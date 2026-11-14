/**
 * I13 Observability module tests — LoggingAdapter, RaftMetricsCollector, HealthProbe.
 *
 * Invariants:
 *   OBS1 — LoggingAdapter wraps pino and preserves all ILogger methods
 *   OBS2 — RaftMetricsCollector correctly increments counters, buckets, percentiles
 *   OBS3 — HealthProbe aggregates liveness/readiness/startup correctly
 *   OBS4 — traceContext propagates traceId across async boundaries
 *   OBS5 — Child loggers inherit component bindings
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LoggingAdapter,
  createLogger,
  RaftMetricsCollector,
  HealthProbe,
  traceContext,
} from '../../observability';
import type { ILogger } from '../../observability';

// ── LoggingAdapter ──────────────────────────────────────────

describe('LoggingAdapter (OBS1, OBS5)', () => {
  let adapter: LoggingAdapter;

  beforeEach(() => {
    adapter = createLogger('TestComponent', { env: 'test' });
  });

  it('OBS1.1: should implement all ILogger methods without throwing', () => {
    // This test verifies the adapter is callable; pino handles output.
    // We validate that no method throws.

    expect(() => adapter.trace('trace msg')).not.toThrow();
    expect(() => adapter.debug('debug msg')).not.toThrow();
    expect(() => adapter.info('info msg')).not.toThrow();
    expect(() => adapter.warn('warn msg')).not.toThrow();
    expect(() => adapter.error('error msg')).not.toThrow();
    expect(() => adapter.fatal('fatal msg')).not.toThrow();
  });

  it('OBS1.2: should support context objects', () => {
    expect(() => adapter.info({ key: 'val' }, 'with context')).not.toThrow();
    expect(() => adapter.warn({ code: 503 }, 'service unavailable')).not.toThrow();
  });

  it('OBS1.3: should support Error objects', () => {
    const err = new Error('test error');
    expect(() => adapter.error(err)).not.toThrow();
    expect(() => adapter.error(err, 'with message')).not.toThrow();
    expect(() => adapter.error({ code: 500 }, err, 'with context')).not.toThrow();
    expect(() => adapter.fatal(err)).not.toThrow();
    expect(() => adapter.fatal(err, 'fatal with message')).not.toThrow();
  });

  it('OBS1.3b: fatal supports context + Error + message three-arg form', () => {
    const err = new Error('fatal context error');
    expect(() => adapter.fatal({ code: 500 }, err, 'fatal with context')).not.toThrow();
  });

  it('OBS1.3c: fatal supports a plain context object and message', () => {
    expect(() => adapter.fatal({ requestId: 'r1' }, 'fatal without error')).not.toThrow();
  });

  it('OBS1.3d: error supports a plain context object and message (no Error)', () => {
    expect(() => adapter.error({ requestId: 'r2' }, 'error without error object')).not.toThrow();
  });

  it('OBS1.3e: error/fatal with context + Error but no message (undefined msg)', () => {
    const err = new Error('no message');
    // Two-arg form (context, Error) leaves arg3 undefined → `arg3 || ''` fallback.
    expect(() => adapter.error({ code: 501 }, err)).not.toThrow();
    expect(() => adapter.fatal({ code: 502 }, err)).not.toThrow();
  });

  it('OBS5.1: child logger inherits component and adds bindings', () => {
    const child = adapter.child({ requestId: 'req-1' });
    expect(() => child.info('child msg')).not.toThrow();
    expect(() => child.error(new Error('child err'), 'child error')).not.toThrow();
  });

  it('OBS5.2: deeply nested child loggers do not throw', () => {
    const c1 = adapter.child({ layer: 1 });
    const c2 = c1.child({ layer: 2 });
    const c3 = c2.child({ layer: 3 });
    expect(() => c3.info('nested')).not.toThrow();
  });

  it('OBS1.4: raw() returns underlying pino instance', () => {
    const raw = adapter.raw();
    expect(raw).toBeDefined();
    expect(typeof raw.info).toBe('function');
  });

  it('OBS1.5: createLogger factory produces distinct instances', () => {
    const a = createLogger('A');
    const b = createLogger('B');
    expect(a).not.toBe(b);
  });
});

// ── RaftMetricsCollector ─────────────────────────────────────

describe('RaftMetricsCollector (OBS2)', () => {
  let metrics: RaftMetricsCollector;

  beforeEach(() => {
    metrics = new RaftMetricsCollector();
  });

  it('OBS2.1: counters start at zero', () => {
    const s = metrics.snapshot();
    expect(s.leaderChanges).toBe(0);
    expect(s.proposalsTotal).toBe(0);
    expect(s.proposalsFailed).toBe(0);
    expect(s.currentTerm).toBe(0);
  });

  it('OBS2.2: recordLeaderChange increments correctly', () => {
    metrics.recordLeaderChange();
    metrics.recordLeaderChange();
    expect(metrics.snapshot().leaderChanges).toBe(2);
  });

  it('OBS2.3: recordProposal tracks success and failure', () => {
    metrics.recordProposal(true);
    metrics.recordProposal(true);
    metrics.recordProposal(false);
    metrics.recordProposal(true);
    metrics.recordProposal(false);
    const s = metrics.snapshot();
    expect(s.proposalsTotal).toBe(5);
    expect(s.proposalsFailed).toBe(2);
  });

  it('OBS2.4: gauge setters work', () => {
    metrics.setTerm(7);
    metrics.setLogSizeBytes(102400);
    metrics.setPeerCount(5);
    const s = metrics.snapshot();
    expect(s.currentTerm).toBe(7);
    expect(s.logSizeBytes).toBe(102400);
    expect(s.peerCount).toBe(5);
  });

  it('OBS2.5: commit latency histogram with known values', () => {
    // 10 samples: 5 in bucket 1ms, 3 in bucket 5ms, 1 in bucket 50ms, 1 in bucket 500ms
    const samples = [0.5, 0.7, 1.0, 1.2, 0.8, 3, 4, 4.5, 45, 450];
    for (const ms of samples) {
      metrics.recordCommitLatency(ms);
    }
    const s = metrics.snapshot();
    // Bucket[0] (≤1ms): 0.5, 0.7, 1.0, 0.8 = 4 samples
    expect(s.commitLatencyBuckets[0]).toBe(4);
    // Bucket[1] (≤5ms): 1.2, 3, 4, 4.5 = 4 more (total 8 cumulative)
    expect(s.commitLatencyBuckets[1]).toBe(4);
    let totalInBuckets = 0;
    for (const b of s.commitLatencyBuckets) totalInBuckets += b;
    expect(totalInBuckets).toBe(samples.length);
    expect(s.commitLatencyMs).toBeGreaterThan(0);
  });

  it('OBS2.6: percentiles are computed correctly', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.recordCommitLatency(i);
    }
    const s = metrics.snapshot();
    expect(s.commitLatencyP50).toBeGreaterThanOrEqual(50);
    expect(s.commitLatencyP50).toBeLessThanOrEqual(52);
    expect(s.commitLatencyP95).toBeGreaterThanOrEqual(94);
    expect(s.commitLatencyP99).toBeGreaterThanOrEqual(98);
  });

  it('OBS2.7: toPrometheus produces valid metric lines', () => {
    metrics.recordLeaderChange();
    metrics.recordProposal(true);
    const text = metrics.toPrometheus();
    expect(text).toContain('HELP db_cluster_leader_changes_total');
    expect(text).toContain('TYPE db_cluster_leader_changes_total counter');
    expect(text).toContain('db_cluster_leader_changes_total 1');
    expect(text).toContain('db_cluster_commit_latency_seconds_bucket{le=');
  });

  it('OBS2.8: reset clears all state', () => {
    metrics.recordLeaderChange();
    metrics.recordProposal(true);
    metrics.recordCommitLatency(50);
    metrics.reset();
    const s = metrics.snapshot();
    expect(s.leaderChanges).toBe(0);
    expect(s.proposalsTotal).toBe(0);
    expect(s.commitLatencyMs).toBe(0);
  });
});

// ── HealthProbe ─────────────────────────────────────────────

describe('HealthProbe (OBS3)', () => {
  let health: HealthProbe;

  beforeEach(() => {
    health = new HealthProbe();
  });

  it('OBS3.1: liveness returns ok when no fatal errors', () => {
    const r = health.liveness();
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('OBS3.2: liveness returns fail after fatal errors', () => {
    health.recordFatalError();
    const r = health.liveness();
    expect(r.ok).toBe(false);
  });

  it('OBS3.3: readiness fails before startup complete', () => {
    const r = health.readiness();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('startup');
  });

  it('OBS3.4: readiness succeeds after startup + probes pass', () => {
    health.markStartupComplete();
    health.register('raft', () => ({ ok: true, latencyMs: 1 }));
    const r = health.readiness();
    expect(r.ok).toBe(true);
  });

  it('OBS3.5: readiness fails if any registered probe fails', () => {
    health.markStartupComplete();
    health.register('raft', () => ({ ok: true, latencyMs: 1 }));
    health.register('storage', () => ({ ok: false, reason: 'disk full', latencyMs: 2 }));
    const r = health.readiness();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('storage');
  });

  it('OBS3.6: startup probe reflects initialization state', () => {
    expect(health.startup().ok).toBe(false);
    health.markStartupComplete();
    expect(health.startup().ok).toBe(true);
  });

  it('OBS3.7: fullStatus returns aggregated JSON', () => {
    health.markStartupComplete();
    health.register('raft', () => ({ ok: true, latencyMs: 1 }));
    const status = health.fullStatus();
    expect(status.status).toBe('healthy');
    expect(status.probes.liveness.ok).toBe(true);
    expect(status.probes.readiness.ok).toBe(true);
    expect(status.probes.startup.ok).toBe(true);
  });

  it('OBS3.8: fullStatus degraded when startup not complete', () => {
    const status = health.fullStatus();
    expect(status.status).toBe('degraded');
  });
});

// ── Trace Context ───────────────────────────────────────────

describe('traceContext (OBS4)', () => {
  it('OBS4.1: getTraceId returns undefined when no context active', () => {
    expect(traceContext.getTraceId()).toBeUndefined();
  });

  it('OBS4.2: runWith sets traceId synchronously', () => {
    traceContext.runWith('trace-abc', () => {
      expect(traceContext.getTraceId()).toBe('trace-abc');
    });
    expect(traceContext.getTraceId()).toBeUndefined();
  });

  it('OBS4.3: runWithAsync propagates across async boundaries', async () => {
    const result = await traceContext.runWithAsync('trace-async', async () => {
      await new Promise(r => setTimeout(r, 1));
      return traceContext.getTraceId();
    });
    expect(result).toBe('trace-async');
    expect(traceContext.getTraceId()).toBeUndefined();
  });

  it('OBS4.4: nested runWith preserves inner context', () => {
    traceContext.runWith('outer', () => {
      expect(traceContext.getTraceId()).toBe('outer');
      traceContext.runWith('inner', () => {
        expect(traceContext.getTraceId()).toBe('inner');
      });
      expect(traceContext.getTraceId()).toBe('outer');
    });
  });

  it('OBS4.5: multiple concurrent traces do not leak', async () => {
    const ids = ['a', 'b', 'c'];
    const results = await Promise.all(ids.map(id =>
      traceContext.runWithAsync(id, async () => {
        await new Promise(r => setTimeout(r, Math.random() * 5));
        return traceContext.getTraceId();
      })
    ));
    expect(results.sort()).toEqual(ids.sort());
  });
});
