/**
 * MetricsRegistry — In-memory metrics registry implementing IMetricsRegistry.
 *
 * Stores all metric instances in maps keyed by (name + canonical label pairs).
 * Provides snapshot() for export, and supports reset for testing.
 *
 * ⚠️ Not optimized for ultra-high throughput (doesn't use shared memory).
 *    For sustained >1M ops/s, use a native Prometheus client instead.
 *
 * @module @agentix-e/db-operations-metrics/impl
 */

import type { IMetricsRegistry, ICounter, IGauge, IHistogram } from '../interfaces/IMetricsRegistry.js';
import type { MetricsSnapshot, MetricPoint, MetricType } from '@agentix-e/db-operations-core/types';

// ── Helpers ──────────────────────────────────────────────────

function canonicalLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function labelsToPairs(labels?: Record<string, string>): Array<{ key: string; value: string }> {
  if (!labels) return [];
  return Object.entries(labels).map(([key, value]) => ({ key, value }));
}

// ── Metric Implementations ────────────────────────────────────

class Counter implements ICounter {
  private _value = 0;

  inc(): void { this._value++; }
  incBy(value: number): void {
    if (value < 0) throw new Error('Counter cannot decrement');
    this._value += value;
  }
  reset(): void { this._value = 0; }
  get(): number { return this._value; }
}

class Gauge implements IGauge {
  private _value = 0;

  set(value: number): void { this._value = value; }
  inc(): void { this._value++; }
  dec(): void { this._value--; }
  add(value: number): void { this._value += value; }
  get(): number { return this._value; }
}

class Histogram implements IHistogram {
  private _values: number[] = [];
  private _sum = 0;

  constructor(private _buckets?: number[]) {}

  observe(value: number): void {
    this._values.push(value);
    this._sum += value;
  }

  getCount(): number { return this._values.length; }
  getSum(): number { return this._sum; }

  getQuantile(p: number): number | undefined {
    if (this._values.length === 0) return undefined;
    const sorted = [...this._values].sort((a, b) => a - b);
    const idx = Math.floor(p * (sorted.length - 1));
    return sorted[idx];
  }

  reset(): void {
    this._values = [];
    this._sum = 0;
  }
}

// ── Registry ──────────────────────────────────────────────────

interface MetricKey {
  name: string;
  labels: Record<string, string>;
  labelStr: string;
}

function makeKey(name: string, labels?: Record<string, string>): MetricKey {
  return { name, labels: labels ?? {}, labelStr: canonicalLabels(labels) };
}

/**
 * In-memory metrics registry.
 */
export class MetricsRegistry implements IMetricsRegistry {
  private _counters = new Map<string, Counter>();
  private _gauges = new Map<string, Gauge>();
  private _histograms = new Map<string, Histogram>();
  private _counterMeta = new Map<string, MetricKey>();
  private _gaugeMeta = new Map<string, MetricKey>();
  private _histogramMeta = new Map<string, MetricKey>();

  counter(name: string, labels?: Record<string, string>): ICounter {
    const key = makeKey(name, labels);
    const mapKey = `${name}:${key.labelStr}`;
    if (!this._counters.has(mapKey)) {
      this._counters.set(mapKey, new Counter());
      this._counterMeta.set(mapKey, key);
    }
    return this._counters.get(mapKey)!;
  }

  gauge(name: string, labels?: Record<string, string>): IGauge {
    const key = makeKey(name, labels);
    const mapKey = `${name}:${key.labelStr}`;
    if (!this._gauges.has(mapKey)) {
      this._gauges.set(mapKey, new Gauge());
      this._gaugeMeta.set(mapKey, key);
    }
    return this._gauges.get(mapKey)!;
  }

  histogram(name: string, labels?: Record<string, string>, buckets?: number[]): IHistogram {
    const key = makeKey(name, labels);
    const mapKey = `${name}:${key.labelStr}`;
    if (!this._histograms.has(mapKey)) {
      this._histograms.set(mapKey, new Histogram(buckets));
      this._histogramMeta.set(mapKey, key);
    }
    return this._histograms.get(mapKey)!;
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    const points: MetricPoint[] = [];

    const addPoints = (meta: Map<string, MetricKey>, type: MetricType, getValue: (key: string) => number) => {
      for (const [mapKey, key] of meta) {
        points.push({
          name: key.name,
          type,
          value: getValue(mapKey),
          labels: labelsToPairs(key.labels),
          timestamp: now,
        });
      }
    };

    addPoints(this._counterMeta, 'counter', k => (this._counters.get(k) as Counter).get());
    addPoints(this._gaugeMeta, 'gauge', k => (this._gauges.get(k) as Gauge).get());

    // For histograms, add count + sum as separate points.
    for (const [mapKey, key] of this._histogramMeta) {
      const h = this._histograms.get(mapKey) as Histogram;
      points.push({
        name: `${key.name}_count`,
        type: 'gauge',
        value: h.getCount(),
        labels: labelsToPairs(key.labels),
        timestamp: now,
      });
      points.push({
        name: `${key.name}_sum`,
        type: 'gauge',
        value: h.getSum(),
        labels: labelsToPairs(key.labels),
        timestamp: now,
      });
    }

    return { points, capturedAt: now };
  }
}
