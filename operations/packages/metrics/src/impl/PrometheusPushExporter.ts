/**
 * PrometheusPushExporter — Pushes metrics to a Prometheus PushGateway.
 *
 * Feature:
 *   - Converts InMemoryMetricsRegistry (or any IMetricsRegistry) to Prometheus
 *     text-format exposition format
 *   - Pushes via HTTP PUT to a configurable PushGateway endpoint
 *   - Supports grouping key for job/instance identification
 *   - Automatic push interval or manual trigger
 *
 * @module @agentix-e/db-operations-metrics/impl
 */

import type { IMetricsRegistry } from '../interfaces/IMetricsRegistry.js';
import type { MetricsSnapshot, MetricPoint } from '@agentix-e/db-operations-core/types';

// ── Config ───────────────────────────────────────────────────────

export interface PrometheusPushExporterConfig {
  /** PushGateway URL (e.g., http://pushgateway:9091). */
  pushGatewayUrl: string;
  /** Job name (used as grouping key). */
  job: string;
  /** Instance identifier (used as grouping key). */
  instance: string;
  /** Additional grouping labels. */
  groupingLabels?: Record<string, string>;
  /** Push interval in ms (0 = manual only). */
  pushIntervalMs?: number;
  /** HTTP timeout in ms. */
  timeoutMs?: number;
}

// ── Metrics → Prometheus text format ────────────────────────────

/**
 * Convert a MetricsSnapshot to Prometheus text-format exposition.
 */
function snapshotToPrometheus(snapshot: MetricsSnapshot): string {
  // Group by name to handle counter/gauge/histogram and labels
  const families = new Map<string, MetricPoint[]>();

  for (const point of snapshot.points) {
    const baseName = point.name.replace(/_count$/, '').replace(/_sum$/, '');
    if (!families.has(baseName)) families.set(baseName, []);
    families.get(baseName)!.push(point);
  }

  const lines: string[] = [];

  for (const [baseName, points] of families) {
    // Determine type from points
    const hasCount = points.some((p) => p.name.endsWith('_count'));
    const hasSum = points.some((p) => p.name.endsWith('_sum'));
    const type = hasCount && hasSum ? 'histogram' : (points[0]?.type ?? 'gauge');

    lines.push(`# HELP ${baseName} ${type === 'histogram' ? 'Histogram' : type === 'counter' ? 'Counter' : 'Gauge'} metric`);
    lines.push(`# TYPE ${baseName} ${type}`);

    if (type === 'histogram') {
      // Collect all label combinations
      const labelGroups = new Map<string, MetricPoint[]>();
      for (const p of points) {
        // Extract clean name (strip _count/_sum)
        // Clean name extraction kept for future histogram label grouping
        void (p.name.replace(/_count$/, '').replace(/_sum$/, '') satisfies string);
        const labelKey = (p.labels ?? []).map((l) => `${l.key}=${l.value}`).sort().join(',');
        if (!labelGroups.has(labelKey)) labelGroups.set(labelKey, []);
        labelGroups.get(labelKey)!.push(p);
      }

      for (const [, groupPoints] of labelGroups) {
        const labelsMap: Record<string, string> = {};
        for (const l of groupPoints[0]?.labels ?? []) {
          labelsMap[l.key] = l.value;
        }
        const labelsStr = Object.keys(labelsMap).length > 0 ? formatLabels(labelsMap) : '';

        const countPoint = groupPoints.find((p) => p.name.endsWith('_count'));
        const sumPoint = groupPoints.find((p) => p.name.endsWith('_sum'));

        if (countPoint) {
          lines.push(`${baseName}_count${labelsStr} ${countPoint.value}`);
        }
        if (sumPoint) {
          lines.push(`${baseName}_sum${labelsStr} ${sumPoint.value}`);
        }
      }
    } else {
      // Counter or gauge
      for (const p of points) {
        const labelsMap: Record<string, string> = {};
        for (const l of p.labels ?? []) {
          labelsMap[l.key] = l.value;
        }
        const labelsStr = Object.keys(labelsMap).length > 0 ? formatLabels(labelsMap) : '';
        lines.push(`${p.name}${labelsStr} ${p.value}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${escapeLabelValue(v)}"`,
  );
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ══════════════════════════════════════════════════════════════════
//  PrometheusPushExporter
// ══════════════════════════════════════════════════════════════════

export class PrometheusPushExporter {
  readonly name = 'prometheus-push';

  private readonly registry: IMetricsRegistry;
  private readonly config: PrometheusPushExporterConfig;
  private readonly baseUrl: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(registry: IMetricsRegistry, config: PrometheusPushExporterConfig) {
    this.registry = registry;
    this.config = config;
    this.baseUrl = this.buildBaseUrl(config);
  }

  private buildBaseUrl(config: PrometheusPushExporterConfig): string {
    const base = config.pushGatewayUrl.replace(/\/+$/, '');
    const labels: Record<string, string> = {
      job: config.job,
      instance: config.instance,
      ...config.groupingLabels,
    };
    // PushGateway requires grouping keys in the URL path: /metrics/job/<job>/instance/<instance>/...
    const parts = Object.entries(labels).map(
      ([k, v]) => `/${k}/${encodeURIComponent(v)}`,
    );
    return `${base}/metrics${parts.join('')}`;
  }

  /**
   * Start the push loop (if pushIntervalMs > 0).
   */
  start(): void {
    if (this.config.pushIntervalMs && this.config.pushIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.push().catch((err) => {
          console.error('[PrometheusPushExporter] Push failed:', err);
        });
      }, this.config.pushIntervalMs);
    }
  }

  /**
   * Stop the periodic push loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Trigger an immediate push.
   */
  async push(): Promise<void> {
    const snapshot = this.registry.snapshot();
    const body = snapshotToPrometheus(snapshot);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 10_000,
    );

    try {
      const response = await fetch(this.baseUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `PushGateway responded ${response.status}: ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
