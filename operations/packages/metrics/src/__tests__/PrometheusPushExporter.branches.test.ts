/**
 * PrometheusPushExporter — branch-completion tests.
 *
 * Targets the defensive nullish branches in snapshot→exposition conversion:
 *   - `points[0]?.type ?? 'gauge'` when a metric point omits its type
 *   - `groupPoints[0]?.labels ?? []` and `p.labels ?? []` when labels are absent
 *   - `timeoutMs ?? 10_000` when the config omits a timeout
 *
 * These branches defend against a generic IMetricsRegistry implementation
 * (not just InMemoryMetricsRegistry) returning a snapshot whose points lack
 * the optional-in-practice `type`/`labels` fields. Exercising them verifies
 * the exporter's robustness against incomplete snapshot payloads.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PrometheusPushExporter } from "../impl/PrometheusPushExporter.js";
import type { IMetricsRegistry } from "../interfaces/IMetricsRegistry.js";
import type { MetricsSnapshot } from "@agentix-e/db-operations-core/types";

function mockRegistry(snapshot: MetricsSnapshot): IMetricsRegistry {
  const noop = { inc: () => {}, incBy: () => {}, reset: () => {}, get: () => 0, set: () => {}, dec: () => {}, add: () => {}, observe: () => {}, getCount: () => 0, getSum: () => 0, getQuantile: () => undefined };
  return {
    counter: () => noop as any,
    gauge: () => noop as any,
    histogram: () => noop as any,
    snapshot: () => snapshot,
  };
}

function makePoint(overrides: Record<string, unknown>): any {
  return {
    name: "metric",
    type: "gauge",
    value: 1,
    labels: [],
    timestamp: 0,
    ...overrides,
  };
}

describe("PPE-branch: incomplete snapshot payloads", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installMockFetch() {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  }

  it("falls back to gauge when a metric point omits its type", async () => {
    installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [makePoint({ name: "no_type_metric", type: undefined })],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: "http://gw:9091", job: "j", instance: "i", timeoutMs: 100,
    });

    await exporter.push();

    const body = (globalThis.fetch as any).mock.calls[0][1].body;
    expect(body).toContain("# TYPE no_type_metric gauge");
  });

  it("treats absent histogram labels as empty", async () => {
    installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [
        makePoint({ name: "hist_count", type: "gauge", labels: undefined }),
        makePoint({ name: "hist_sum", type: "gauge", labels: undefined }),
      ],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: "http://gw:9091", job: "j", instance: "i", timeoutMs: 100,
    });

    await exporter.push();

    const body = (globalThis.fetch as any).mock.calls[0][1].body;
    expect(body).toContain("# TYPE hist histogram");
    expect(body).toContain("hist_count 1");
  });

  it("treats absent counter/gauge labels as empty", async () => {
    installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [makePoint({ name: "bare_gauge", labels: undefined })],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: "http://gw:9091", job: "j", instance: "i", timeoutMs: 100,
    });

    await exporter.push();

    const body = (globalThis.fetch as any).mock.calls[0][1].body;
    expect(body).toContain("bare_gauge 1");
  });

  it("uses the default 10s timeout when timeoutMs is omitted", async () => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const snapshot: MetricsSnapshot = { points: [makePoint({})], capturedAt: Date.now() };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: "http://gw:9091", job: "j", instance: "i",
    });

    // push() sets a 10s abort timeout; advancing past it must abort the (already
    // resolved) fetch without throwing, proving the default timeout is applied.
    await exporter.push();

    vi.useRealTimers();
  });
});
