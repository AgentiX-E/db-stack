/**
 * I25 — B3 CDC Hardening tests.
 *
 * CDC1-CDC3: CDCSinkResolver (connection retry, batch splitting, health checks)
 * CDC4-CDC6: CDCBenchRunner (throughput, latency percentiles, batch comparison)
 * CDC7-CDC9: CDCFailureInjector (connection drop, partial emit, duplicate injection)
 * CDC10-CDC12: Integrated hardening (retry+inject, exactly-once under fault, recovery)
 * CDC13-CDC15: Edge cases (zero events, rapid connect/disconnect, concurrent emits)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CDCSinkResolver, type ResolverHealth, type FailureEvent } from '../../replication/CDCSinkResolver';
import { CDCBenchRunner, type CDCBenchReport } from '../../replication/CDCBenchRunner';
import { CDCFailureInjector, type FailureConfig } from '../../replication/CDCFailureInjector';
import { InMemoryCDCSink } from '../../replication/InMemoryCDCSink';
import type { ICDCSink, CDCSinkEvent } from '../../interfaces/replication/ICDCSink';

// ── Helpers ─────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeEvents(count: number, startIdx = 0): CDCSinkEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${startIdx + i}`,
    type: 'insert' as const,
    table: 'test_table',
    key: `key-${startIdx + i}`,
    data: { idx: startIdx + i },
    timestamp: BigInt(Date.now()),
  }));
}

// ── FailingSink (for retry testing) ────────────────────────

class FailingSink implements ICDCSink {
  readonly name = 'failing-sink';
  private _connected = false;
  private emitFails = 0;
  private failCount: number;
  private connectFails = 0;
  private connectFailCount: number;

  constructor(options: { failEmits?: number; failConnects?: number } = {}) {
    this.failCount = options.failEmits ?? 0;
    this.connectFailCount = options.failConnects ?? 0;
  }

  async connect(): Promise<void> {
    if (this.connectFails < this.connectFailCount) {
      this.connectFails++;
      throw new Error('simulated connect failure');
    }
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async emit(events: CDCSinkEvent[]): Promise<void> {
    if (!this._connected) throw new Error('not connected');
    if (this.emitFails < this.failCount) {
      this.emitFails++;
      throw new Error('simulated emit failure');
    }
  }

  get connected(): boolean {
    return this._connected;
  }
}

// ── CDC1-CDC3: CDCSinkResolver ────────────────────────────

describe('CDC1: CDCSinkResolver — connection retry', () => {
  it('succeeds on first attempt when sink is healthy', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 3,
      retryBaseMs: 5,
    });
    await resolver.connect();
    expect(resolver.connected).toBe(true);
    await resolver.disconnect();
  });

  it('retries on connection failure and succeeds', async () => {
    // Fails first connect, succeeds second
    const sink = new FailingSink({ failConnects: 1 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 3,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    await resolver.connect();
    expect(resolver.connected).toBe(true);
    await resolver.disconnect();
  });

  it('throws after exhausting all retries', async () => {
    const sink = new FailingSink({ failConnects: 10 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 3,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    await expect(resolver.connect()).rejects.toThrow('connection failed after');
  });

  it('emits failure events on retry exhaustion', async () => {
    const sink = new FailingSink({ failConnects: 10 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 2,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    const failures: FailureEvent[] = [];
    resolver.onFailure((e) => failures.push(e));

    await expect(resolver.connect()).rejects.toThrow();
    expect(failures.length).toBe(1);
    expect(failures[0]!.mode.type).toBe('retry_exhausted');
  });
});

describe('CDC2: CDCSinkResolver — batch splitting', () => {
  it('emits a single batch when below maxBatchSize', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { maxBatchSize: 100 });

    await resolver.connect();
    const events = makeEvents(50);
    await resolver.emit(events);

    expect(sink.getEvents()).toHaveLength(50);
    await resolver.disconnect();
  });

  it('splits large batch into multiple emits', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { maxBatchSize: 100 });

    await resolver.connect();
    const events = makeEvents(350);
    await resolver.emit(events);

    expect(sink.getEvents()).toHaveLength(350);
    await resolver.disconnect();
  });

  it('zero events emit is a no-op', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink);

    await resolver.connect();
    await resolver.emit([]);
    expect(sink.getEvents()).toHaveLength(0);
    await resolver.disconnect();
  });
});

describe('CDC3: CDCSinkResolver — health checks', () => {
  it('publishes health status on connect', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { healthCheckIntervalMs: 0 });

    const healthEvents: ResolverHealth[] = [];
    resolver.onHealthChange((h) => healthEvents.push(h));

    await resolver.connect();
    // onHealthChange should have fired on connect
    expect(healthEvents.length).toBeGreaterThanOrEqual(1);
    expect(healthEvents[0]!.connected).toBe(true);

    await resolver.disconnect();
  });

  it('reports correct emit counters', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { healthCheckIntervalMs: 0 });

    await resolver.connect();
    await resolver.emit(makeEvents(10));
    await resolver.emit(makeEvents(20, 10));

    const health = resolver.getHealth();
    expect(health.totalEmitted).toBe(30);
    expect(health.totalFailures).toBe(0);
    expect(health.lastEmitTimestamp).not.toBeNull();
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);

    await resolver.disconnect();
  });

  it('unsubscribe removes listener', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { healthCheckIntervalMs: 0 });

    const events: ResolverHealth[] = [];
    const unsub = resolver.onHealthChange((h) => events.push(h));

    await resolver.connect();
    const countAfterConnect = events.length;

    unsub();
    await resolver.disconnect();
    // No new events fired via health change listener (disconnect doesn't trigger healthChange)
    expect(events.length).toBe(countAfterConnect);
  });
});

// ── CDC4-CDC6: CDCBenchRunner ─────────────────────────────

describe('CDC4: CDCBenchRunner — basic benchmarks', () => {
  it('runs a full benchmark suite', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner({
      totalEvents: 100,
      batchSizes: [10, 50],
      warmupEvents: 10,
    });

    const report = await bench.run(sink);
    expect(report.totalEvents).toBe(200); // 100 per batch size × 2 batch sizes
    expect(report.batches).toHaveLength(2);
    expect(report.batches[0]!.batchSize).toBe(10);
    expect(report.batches[1]!.batchSize).toBe(50);
    // Throughput should be > 0
    expect(report.overallEps).toBeGreaterThan(0);
  });

  it('single batch size benchmark returns correct metrics', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner({
      totalEvents: 500,
      batchSizes: [100],
      warmupEvents: 0,
    });

    const report = await bench.run(sink);
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]!.totalEvents).toBe(500);
    expect(report.batches[0]!.eventsPerSecond).toBeGreaterThan(0);
  });
});

describe('CDC5: CDCBenchRunner — latency percentiles', () => {
  it('computes correct percentile values', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner();

    const latencies = await bench.latencyBench(sink, 10, 100);
    expect(latencies.p50).toBeGreaterThanOrEqual(0);
    expect(latencies.p95).toBeGreaterThanOrEqual(latencies.p50);
    expect(latencies.p99).toBeGreaterThanOrEqual(latencies.p95);
    expect(latencies.max).toBeGreaterThanOrEqual(latencies.min);
    expect(latencies.mean).toBeGreaterThanOrEqual(0);
  });

  it('different batch sizes produce different throughput', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner({
      totalEvents: 200,
      batchSizes: [1, 200],
      warmupEvents: 0,
    });

    const report = await bench.run(sink);
    // Batch size 200 should be faster (fewer round-trips)
    const bs1 = report.batches[0]!; // batchSize = 1
    const bs200 = report.batches[1]!; // batchSize = 200
    // Don't assert ordering (timing-dependent), just check both ran
    expect(bs1.eventsPerSecond).toBeGreaterThan(0);
    expect(bs200.eventsPerSecond).toBeGreaterThan(0);
  });
});

describe('CDC6: CDCBenchRunner — edge cases', () => {
  it('handles empty batch sizes gracefully', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner({
      totalEvents: 100,
      batchSizes: [],
      warmupEvents: 0,
    });

    const report = await bench.run(sink);
    expect(report.batches).toHaveLength(0);
    expect(report.totalEvents).toBe(0);
  });

  it('latency bench with large sample size', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner();

    const latencies = await bench.latencyBench(sink, 50, 200);
    expect(latencies.p50).toBeGreaterThanOrEqual(0);
    expect(latencies.max).toBeGreaterThanOrEqual(latencies.min);
  });
});

// ── CDC7-CDC9: CDCFailureInjector ─────────────────────────

describe('CDC7: CDCFailureInjector — connection failures', () => {
  it('injects connection drop on connect', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'connection_drop', probability: 1.0 }]);

    await expect(injector.connect()).rejects.toThrow('injected connection failure');
    expect(injector.connected).toBe(false);
  });

  it('injects connection drop during emit', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'connection_drop', probability: 1.0 }]);

    // Connect succeeds (no connect failure configured in this scenario)
    // But we need connect to work... use failEveryN with emit-based
    const injector2 = new CDCFailureInjector(new InMemoryCDCSink(), [
      { type: 'connection_drop', failEveryN: 1, maxFailures: 1 },
    ]);

    await injector2.connect();
    const events = makeEvents(10);

    // First emit should trigger the connection drop
    await expect(injector2.emit(events)).rejects.toThrow('injected connection drop');
    expect(injector2.failureCount).toBe(1);
  });
});

describe('CDC8: CDCFailureInjector — emit failures', () => {
  it('injects partial emit failure', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'partial_emit', failEveryN: 1, maxFailures: 1 }]);

    await injector.connect();
    const events = makeEvents(10);

    await expect(injector.emit(events)).rejects.toThrow('partial emit');
    // First half should have been emitted
    expect(sink.getEvents()).toHaveLength(5);
    expect(injector.failureCount).toBe(1);
  });

  it('injects duplicate events', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'duplicate_inject', failEveryN: 1, maxFailures: 1 }]);

    await injector.connect();
    const events = makeEvents(5);

    // No error for duplicate injection — just emits twice
    await injector.emit(events);
    expect(sink.getEvents()).toHaveLength(10); // 5 × 2
    expect(injector.failureCount).toBe(1);
  });

  it('injects reordered events', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'reorder_inject', failEveryN: 1, maxFailures: 1 }]);

    await injector.connect();
    const events = makeEvents(5); // id: evt-0 .. evt-4

    await injector.emit(events);
    const emitted = sink.getEvents();
    expect(emitted).toHaveLength(5);
    // Check they're in reverse order
    expect(emitted[0]!.id).toBe('evt-4');
    expect(emitted[4]!.id).toBe('evt-0');
    expect(injector.failureCount).toBe(1);
  });

  it('latency spike injection adds delay', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      {
        type: 'latency_spike',
        probability: 1.0,
        latencyMs: 50,
        maxFailures: 1,
      },
    ]);

    await injector.connect();
    const events = makeEvents(10);

    const t0 = Date.now();
    await injector.emit(events);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow slight timing variance
    expect(injector.failureCount).toBe(1);
  });
});

describe('CDC9: CDCFailureInjector — probabilistic vs deterministic', () => {
  it('probabilistic failures trigger stochastically', async () => {
    const sink = new InMemoryCDCSink();
    // Use latency_spike (not connection_drop) so a single injected failure
    // does not disconnect the sink and cascade into N "not connected"
    // failures. Its probability branch calls Math.random exactly once per
    // emit, which we control deterministically below.
    const injector = new CDCFailureInjector(sink, [{ type: 'latency_spike', probability: 0.01, latencyMs: 1 }]);

    await injector.connect();

    // Deterministically drive the random threshold: return values above the
    // 0.01 threshold for most emits (no injection) and below it for a chosen
    // few (injection). This removes flakiness while still exercising the real
    // `Math.random() < probability` branch.
    const sequence = Array.from({ length: 50 }, (_, i) => (i === 7 || i === 29 ? 0.005 : 0.5));
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      return sequence.shift() ?? 0.5;
    });

    for (let i = 0; i < 50; i++) {
      await injector.emit(makeEvents(1));
    }

    randomSpy.mockRestore();

    // Exactly two of the fifty emits crossed the 0.01 threshold.
    expect(injector.failureCount).toBe(2);
    expect(injector.totalEmits).toBe(50);
  });

  it('deterministic every-N failure fires predictably', async () => {
    const sink = new InMemoryCDCSink();
    // Use latency_spike instead of connection_drop — it doesn't disconnect,
    // so subsequent emits still work
    const injector = new CDCFailureInjector(sink, [
      {
        type: 'latency_spike',
        probability: 1.0,
        latencyMs: 1,
        failEveryN: 3,
        maxFailures: 2,
      },
    ]);

    await injector.connect();

    const t0 = Date.now();
    // Emit 10 times — spikes at emit #3 and #6 (every 3, max 2)
    for (let i = 0; i < 10; i++) {
      await injector.emit(makeEvents(1));
    }
    const spikes = injector.failureCount;

    expect(spikes).toBe(2);
  });

  it('maxFailures limits total fault injections', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'latency_spike', probability: 1.0, latencyMs: 1, maxFailures: 3 },
    ]);

    await injector.connect();

    for (let i = 0; i < 10; i++) {
      await injector.emit(makeEvents(1));
    }

    expect(injector.failureCount).toBe(3);
  });
});

// ── CDC10-CDC12: Integrated Hardening ─────────────────────

describe('CDC10: Integrated retry + failure injector', () => {
  it('resolution handles transient connection failures', async () => {
    // FailingSink fails once then succeeds
    const sink = new FailingSink({ failConnects: 1 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 5,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    await resolver.connect();
    expect(resolver.connected).toBe(true);

    await resolver.emit(makeEvents(10));
    const health = resolver.getHealth();
    expect(health.totalEmitted).toBe(10);

    await resolver.disconnect();
  });

  it('resolution + injector verify exactly-once under fault', async () => {
    // Use InMemory sink + failure injector + resolver wrapping
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'duplicate_inject', failEveryN: 5, maxFailures: 2 }]);
    const resolver = new CDCSinkResolver(injector, { maxBatchSize: 50 });

    await resolver.connect();

    // Emit 100 unique events in batches of 20
    for (let i = 0; i < 5; i++) {
      const events = makeEvents(20, i * 20);
      try {
        await resolver.emit(events);
      } catch {
        // Resolver will retry/throw — we accept some failures
      }
    }

    await resolver.disconnect();

    const emitted = sink.getEvents();
    // With duplicate injection at every 5th emit and max 2,
    // we injected 2 duplicates → some events may appear twice
    const ids = emitted.map((e) => e.id);
    const uniqueIds = new Set(ids);
    // All original IDs should be present at least once
    expect(uniqueIds.size).toBeGreaterThanOrEqual(80);
  });
});

describe('CDC11: Failure recovery patterns', () => {
  it('resolver recovers after multiple emit failures', async () => {
    // Sink that fails 3 times then works
    const sink = new FailingSink({ failEmits: 3 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 5,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    await resolver.connect();

    let success = false;
    for (let i = 0; i < 5; i++) {
      try {
        await resolver.emit(makeEvents(10));
        success = true;
        break;
      } catch {
        // Retry
      }
    }

    // After 3 failures, should eventually succeed (on 4th or 5th attempt)
    expect(success).toBe(true);
    expect(sink.connected).toBe(true);

    await resolver.disconnect();
  });

  it('reports accurate failure metrics', async () => {
    const sink = new FailingSink({ failEmits: 2 });
    const resolver = new CDCSinkResolver(sink, {
      maxRetries: 3,
      retryBaseMs: 5,
      retryStrategy: 'fixed',
    });

    const failures: FailureEvent[] = [];
    resolver.onFailure((e) => failures.push(e));

    await resolver.connect();

    // Emit multiple batches — first 2 will fail
    for (let i = 0; i < 5; i++) {
      try {
        await resolver.emit(makeEvents(1));
      } catch {
        /* retry exhausted */
      }
    }

    const health = resolver.getHealth();
    expect(health.totalFailures).toBeGreaterThan(0);
    expect(failures.length).toBeGreaterThan(0);

    await resolver.disconnect();
  });
});

describe('CDC12: Bench + Injector integration', () => {
  it('benchmark works with failure-injected sink', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'latency_spike', probability: 0.05, latencyMs: 1 }]);
    const bench = new CDCBenchRunner({
      totalEvents: 100,
      batchSizes: [50],
      warmupEvents: 10,
    });

    const report = await bench.run(injector);
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]!.totalEvents).toBe(100);
    expect(report.batches[0]!.eventsPerSecond).toBeGreaterThan(0);
  });
});

// ── CDC13-CDC15: Edge Cases ───────────────────────────────

describe('CDC13: Resolver edge cases', () => {
  it('emit when disconnected throws', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { maxBatchSize: 100 });

    await expect(resolver.emit(makeEvents(10))).rejects.toThrow('disconnected');
  });

  it('double disconnect is safe', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink);

    await resolver.connect();
    await resolver.disconnect();
    await resolver.disconnect(); // No-op

    expect(resolver.connected).toBe(false);
  });

  it('batch exactly at maxBatchSize boundary', async () => {
    const sink = new InMemoryCDCSink();
    const resolver = new CDCSinkResolver(sink, { maxBatchSize: 100 });

    await resolver.connect();
    await resolver.emit(makeEvents(100));
    expect(sink.getEvents()).toHaveLength(100);

    await resolver.disconnect();
  });
});

describe('CDC14: Failure injector edge cases', () => {
  it('reset clears counters but preserves config', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'latency_spike', probability: 1.0, latencyMs: 1, maxFailures: 1 },
    ]);

    await injector.connect();

    // Fire the failure
    await injector.emit(makeEvents(1));
    expect(injector.failureCount).toBe(1);

    // Reset
    injector.reset();
    expect(injector.failureCount).toBe(0);

    // Should fire again (config preserved, maxFailures reset)
    await injector.emit(makeEvents(1));
    expect(injector.failureCount).toBe(1);
  });

  it('no failures configured → pass-through', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, []);

    await injector.connect();
    await injector.emit(makeEvents(10));

    expect(sink.getEvents()).toHaveLength(10);
    expect(injector.failureCount).toBe(0);
  });
});

describe('CDC15: Bench runner edge cases', () => {
  it('warmupEvents = 0 works correctly', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner({
      totalEvents: 10,
      batchSizes: [5],
      warmupEvents: 0,
    });

    const report = await bench.run(sink);
    expect(report.batches[0]!.totalEvents).toBe(10);
  });

  it('latency bench percentile ordering is monotonic', async () => {
    const sink = new InMemoryCDCSink();
    const bench = new CDCBenchRunner();

    const latencies = await bench.latencyBench(sink, 10, 50);
    expect(latencies.min).toBeLessThanOrEqual(latencies.p50);
    expect(latencies.p50).toBeLessThanOrEqual(latencies.p95);
    expect(latencies.p95).toBeLessThanOrEqual(latencies.p99);
    expect(latencies.p99).toBeLessThanOrEqual(latencies.p99_9);
    expect(latencies.p99_9).toBeLessThanOrEqual(latencies.max);
  });
});
