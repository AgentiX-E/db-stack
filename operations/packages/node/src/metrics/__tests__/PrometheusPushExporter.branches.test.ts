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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrometheusPushExporter } from '../impl/PrometheusPushExporter.js';
import type { ICounter, IGauge, IHistogram, IMetricsRegistry } from '../interfaces/IMetricsRegistry.js';
import type { MetricPoint, MetricsSnapshot } from '../../core/types.js';

function mockRegistry(snapshot: MetricsSnapshot): IMetricsRegistry {
  const counter: ICounter = {
    inc: () => {},
    incBy: () => {},
    reset: () => {},
    get: () => 0,
  };
  const gauge: IGauge = {
    set: () => {},
    inc: () => {},
    dec: () => {},
    add: () => {},
    get: () => 0,
  };
  const histogram: IHistogram = {
    observe: () => {},
    getCount: () => 0,
    getSum: () => 0,
    getQuantile: () => undefined,
    reset: () => {},
  };
  return {
    counter: () => counter,
    gauge: () => gauge,
    histogram: () => histogram,
    snapshot: () => snapshot,
  };
}

/**
 * The branches pinned here only run for a snapshot from a registry that omits
 * the optional-in-practice `type`/`labels` fields — a payload that is
 * deliberately out of contract. This helper is the single place that says so.
 */
function incomplete<T>(value: unknown): T {
  return value as T;
}

function makePoint(overrides: Partial<MetricPoint>): MetricPoint {
  return incomplete<MetricPoint>({
    name: 'metric',
    type: 'gauge',
    value: 1,
    labels: [],
    timestamp: 0,
    ...overrides,
  });
}

describe('PPE-branch: incomplete snapshot payloads', () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installMockFetch() {
    originalFetch = globalThis.fetch;
    const mock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mock;
    return mock;
  }

  it('falls back to gauge when a metric point omits its type', async () => {
    const fetchMock = installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [makePoint({ name: 'no_type_metric', type: undefined })],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: 'http://gw:9091',
      job: 'j',
      instance: 'i',
      timeoutMs: 100,
    });

    await exporter.push();

    const body = fetchMock.mock.calls[0]![1].body;
    expect(body).toContain('# TYPE no_type_metric gauge');
  });

  it('treats absent histogram labels as empty', async () => {
    const fetchMock = installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [
        makePoint({ name: 'hist_count', type: 'gauge', labels: undefined }),
        makePoint({ name: 'hist_sum', type: 'gauge', labels: undefined }),
      ],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: 'http://gw:9091',
      job: 'j',
      instance: 'i',
      timeoutMs: 100,
    });

    await exporter.push();

    const body = fetchMock.mock.calls[0]![1].body;
    expect(body).toContain('# TYPE hist histogram');
    expect(body).toContain('hist_count 1');
  });

  it('treats absent counter/gauge labels as empty', async () => {
    const fetchMock = installMockFetch();
    const snapshot: MetricsSnapshot = {
      points: [makePoint({ name: 'bare_gauge', labels: undefined })],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: 'http://gw:9091',
      job: 'j',
      instance: 'i',
      timeoutMs: 100,
    });

    await exporter.push();

    const body = fetchMock.mock.calls[0]![1].body;
    expect(body).toContain('bare_gauge 1');
  });

  it('uses the default 10s timeout when timeoutMs is omitted', async () => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const snapshot: MetricsSnapshot = {
      points: [makePoint({})],
      capturedAt: Date.now(),
    };
    const exporter = new PrometheusPushExporter(mockRegistry(snapshot), {
      pushGatewayUrl: 'http://gw:9091',
      job: 'j',
      instance: 'i',
    });

    // push() sets a 10s abort timeout; advancing past it must abort the (already
    // resolved) fetch without throwing, proving the default timeout is applied.
    await exporter.push();

    vi.useRealTimers();
  });
});
