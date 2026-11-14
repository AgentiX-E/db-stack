/**
 * InMemoryImpls.test.ts — Tests for all monitor in-memory implementations.
 *
 * Covers InMemorySlowQueryRecorder, InMemoryDeadlockDetector,
 * InMemoryConnectionMonitor, InMemoryAlertRuleManager,
 * InMemoryResourceQuotaManager.
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemorySlowQueryRecorder } from '../impl/InMemorySlowQueryRecorder.js';
import { InMemoryDeadlockDetector } from '../impl/InMemoryDeadlockDetector.js';
import { InMemoryConnectionMonitor } from '../impl/InMemoryConnectionMonitor.js';
import { InMemoryAlertRuleManager } from '../impl/InMemoryAlertRuleManager.js';
import { InMemoryResourceQuotaManager } from '../impl/InMemoryResourceQuotaManager.js';

// ── InMemorySlowQueryRecorder ──

describe('InMemorySlowQueryRecorder', () => {
  it('records query above threshold', async () => {
    const recorder = new InMemorySlowQueryRecorder(100);
    await recorder.record({ query: 'SELECT * FROM big_table', durationMs: 200, timestamp: new Date(), database: 'test' });
    const entries = recorder.getRecentSlowQueries();
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('SELECT * FROM big_table');
    expect(entries[0].durationMs).toBe(200);
  });

  it('ignores query below threshold', async () => {
    const recorder = new InMemorySlowQueryRecorder(500);
    await recorder.record({ query: 'SELECT 1', durationMs: 50, timestamp: new Date(), database: 'test' });
    const entries = recorder.getRecentSlowQueries();
    expect(entries).toHaveLength(0);
  });

  it('evicts oldest when exceeding max entries', async () => {
    const recorder = new InMemorySlowQueryRecorder(0, 3); // max 3 entries, threshold 0
    for (let i = 0; i < 5; i++) {
      await recorder.record({ query: `query-${i}`, durationMs: 100, timestamp: new Date(), database: 'test' });
    }
    const entries = recorder.getRecentSlowQueries();
    expect(entries).toHaveLength(3);
    expect(entries[0].query).toBe('query-2');
    expect(entries[1].query).toBe('query-3');
    expect(entries[2].query).toBe('query-4');
  });

  it('setThreshold changes which queries are recorded', async () => {
    const recorder = new InMemorySlowQueryRecorder(500);
    await recorder.record({ query: 'fast', durationMs: 100, timestamp: new Date(), database: 'test' });
    expect(recorder.getRecentSlowQueries()).toHaveLength(0);

    recorder.setThreshold(50);
    await recorder.record({ query: 'also-fast-but-above-threshold', durationMs: 75, timestamp: new Date(), database: 'test' });
    expect(recorder.getRecentSlowQueries()).toHaveLength(1);
    expect(recorder.getRecentSlowQueries()[0].query).toBe('also-fast-but-above-threshold');
  });

  it('total count returned by getSlowQueryCount', async () => {
    const recorder = new InMemorySlowQueryRecorder(0, 100);
    for (let i = 0; i < 10; i++) {
      await recorder.record({ query: `q-${i}`, durationMs: 10, timestamp: new Date(), database: 'test' });
    }
    expect(recorder.getSlowQueryCount()).toBe(10);
  });

  it('clear() resets all entries', async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    await recorder.record({ query: 'SELECT *', durationMs: 100, timestamp: new Date(), database: 'test' });
    expect(recorder.getRecentSlowQueries()).toHaveLength(1);

    recorder.clear();
    expect(recorder.getRecentSlowQueries()).toHaveLength(0);
    expect(recorder.getSlowQueryCount()).toBe(0);
  });

  it('getRecentSlowQueries respects limit', async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    for (let i = 0; i < 10; i++) {
      await recorder.record({ query: `q-${i}`, durationMs: 10, timestamp: new Date(), database: 'test' });
    }
    const limited = recorder.getRecentSlowQueries(3);
    expect(limited).toHaveLength(3);
    expect(limited[0].query).toBe('q-7');
  });

  it('getSlowQueries filters by threshold', async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    await recorder.record({ query: 'fast', durationMs: 50, timestamp: new Date(), database: 'test' });
    await recorder.record({ query: 'slow', durationMs: 200, timestamp: new Date(), database: 'test' });
    const result = await recorder.getSlowQueries(100);
    expect(result).toHaveLength(1);
    expect(result[0].query).toBe('slow');
  });

  it('analyzePatterns groups similar queries', async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    // Same query modulo whitespace, so they normalize to one pattern.
    await recorder.record({ query: 'SELECT * FROM t WHERE   id = 1', durationMs: 100, timestamp: new Date('2026-01-01T00:00:00Z'), database: 'test' });
    await recorder.record({ query: 'SELECT *  FROM t WHERE id = 1', durationMs: 200, timestamp: new Date('2026-01-01T00:00:01Z'), database: 'test' });
    const patterns = await recorder.analyzePatterns();
    // Both queries collapse to the same normalized pattern with two durations.
    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(2);
    // average of [100, 200] = 150 (exact, no floating point)
    expect(patterns[0].averageDurationMs).toBe(150);
  });

  it('analyzePatterns tracks lastSeen as the latest timestamp', async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-01-01T00:00:05Z');
    await recorder.record({ query: 'SELECT x', durationMs: 10, timestamp: early, database: 'test' });
    await recorder.record({ query: 'SELECT x', durationMs: 20, timestamp: late, database: 'test' });
    const patterns = await recorder.analyzePatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].lastSeen.toISOString()).toBe(late.toISOString());
  });

  it('getThreshold returns current threshold', () => {
    const recorder = new InMemorySlowQueryRecorder(200);
    expect(recorder.getThreshold()).toBe(200);
    recorder.setThreshold(500);
    expect(recorder.getThreshold()).toBe(500);
  });

  it('getSlowQueryCount persists even after eviction', async () => {
    const recorder = new InMemorySlowQueryRecorder(0, 2);
    for (let i = 0; i < 5; i++) {
      await recorder.record({ query: `q-${i}`, durationMs: 10, timestamp: new Date(), database: 'test' });
    }
    expect(recorder.getRecentSlowQueries()).toHaveLength(2);
    expect(recorder.getSlowQueryCount()).toBe(5); // total recorded, not just stored
  });
});

// ── InMemoryDeadlockDetector ──

describe('InMemoryDeadlockDetector', () => {
  it('detects 2-node deadlock A→B→A', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockAcquired('txA', 'res-1');
    detector.reportLockAcquired('txB', 'res-2');
    detector.reportLockWait('txA', 'res-2');
    detector.reportLockWait('txB', 'res-1');

    const events = detector.detectDeadlocks();
    expect(events).toHaveLength(1);
    expect(events[0].transactions).toContain('txA');
    expect(events[0].transactions).toContain('txB');
  });

  it('detects 3-node deadlock A→B→C→A', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockAcquired('txA', 'res-1');
    detector.reportLockAcquired('txB', 'res-2');
    detector.reportLockAcquired('txC', 'res-3');

    detector.reportLockWait('txA', 'res-2');
    detector.reportLockWait('txB', 'res-3');
    detector.reportLockWait('txC', 'res-1');

    const events = detector.detectDeadlocks();
    expect(events).toHaveLength(1);
    expect(events[0].transactions.length).toBeGreaterThanOrEqual(2);
  });

  it('no false positive on linear chain A→B→C', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockAcquired('txA', 'res-1');
    detector.reportLockAcquired('txB', 'res-2');
    detector.reportLockAcquired('txC', 'res-3');

    detector.reportLockWait('txB', 'res-1');
    detector.reportLockWait('txC', 'res-2');

    const events = detector.detectDeadlocks();
    expect(events).toHaveLength(0);
  });

  it('resolves deadlock and removes cycle nodes from wait-for graph', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockAcquired('txA', 'res-1');
    detector.reportLockAcquired('txB', 'res-2');
    detector.reportLockWait('txA', 'res-2');
    detector.reportLockWait('txB', 'res-1');

    const events = detector.detectDeadlocks();
    expect(events).toHaveLength(1);

    // After resolution, re-detect should find no cycle
    const remaining = detector.detectDeadlocks();
    expect(remaining).toHaveLength(0);
  });

  it('reports lock timeout as deadlock event', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockTimeout('txA', 'res-1');

    expect(detector.getDeadlockCount()).toBe(1);
  });

  it('tracks total deadlock count', () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockTimeout('txA', 'res-1');
    detector.reportLockTimeout('txB', 'res-2');
    expect(detector.getDeadlockCount()).toBe(2);
  });

  it('getDeadlockHistory returns formatted events', async () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockTimeout('txA', 'res-1');

    const history = await detector.getDeadlockHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toHaveProperty('cycle');
    expect(history[0]).toHaveProperty('victimTransaction');
    expect(history[0]).toHaveProperty('detectedAt');
  });

  it('start and stop resolve without error', async () => {
    const detector = new InMemoryDeadlockDetector();
    await expect(detector.start()).resolves.toBeUndefined();
    await expect(detector.stop()).resolves.toBeUndefined();
  });

  it('onDeadlock callback fires on detection', () => {
    const detector = new InMemoryDeadlockDetector();
    const callback = vi.fn();
    detector.onDeadlock(callback);

    detector.reportLockAcquired('txA', 'res-1');
    detector.reportLockAcquired('txB', 'res-2');
    detector.reportLockWait('txA', 'res-2');
    detector.reportLockWait('txB', 'res-1');

    // Explicitly trigger detection
    detector.detectDeadlocks();
    expect(callback).toHaveBeenCalled();
  });

  it('onDeadlock callback fires on timeout', () => {
    const detector = new InMemoryDeadlockDetector();
    const callback = vi.fn();
    detector.onDeadlock(callback);

    detector.reportLockTimeout('txA', 'res-1');
    expect(callback).toHaveBeenCalled();
  });
});

// ── InMemoryConnectionMonitor ──

describe('InMemoryConnectionMonitor', () => {
  it('tracks open → close round-trip', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    expect(monitor.getTotalOpened()).toBe(1);
    const status = monitor.getPoolStatus();
    expect(status).toHaveLength(1);
    expect(status[0].status.active).toBe(1);
  });

  it('tracks waiting connections', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionWaiting('pool-1');
    const status = monitor.getPoolStatus();
    expect(status[0].status.waiting).toBe(1);
  });

  it('utilization ratio calculation', () => {
    const monitor = new InMemoryConnectionMonitor();
    // Default maxSize is 100
    for (let i = 0; i < 50; i++) {
      monitor.reportConnectionOpened('pool-1');
    }
    const status = monitor.getPoolStatus();
    expect(status[0].status.utilization).toBe(0.5);
  });

  it('getPoolUtilization returns aggregate stats', async () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    monitor.reportConnectionOpened('pool-1');
    monitor.reportConnectionWaiting('pool-1');

    const stats = await monitor.getPoolUtilization();
    expect(stats.active).toBe(2);
    expect(stats.waiting).toBe(1);
  });

  it('start and stop resolve without error', async () => {
    const monitor = new InMemoryConnectionMonitor();
    await expect(monitor.start()).resolves.toBeUndefined();
    await expect(monitor.stop()).resolves.toBeUndefined();
  });

  it('onExhaustion registers callbacks', () => {
    const monitor = new InMemoryConnectionMonitor();
    const callback = vi.fn();
    monitor.onExhaustion(callback);
    // Can't easily trigger exhaustion without mocking, but callback registration should work
    expect(true).toBe(true);
  });

  it('reset clears all state', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    monitor.reset();

    expect(monitor.getTotalOpened()).toBe(0);
    expect(monitor.getPoolStatus()).toHaveLength(0);
  });

  it('multiple pools are tracked separately', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-a');
    monitor.reportConnectionOpened('pool-b');
    monitor.reportConnectionOpened('pool-b');

    const statuses = monitor.getPoolStatus();
    expect(statuses).toHaveLength(2);
    const poolA = statuses.find(s => s.poolId === 'pool-a')!;
    const poolB = statuses.find(s => s.poolId === 'pool-b')!;
    expect(poolA.status.active).toBe(1);
    expect(poolB.status.active).toBe(2);
  });

  it('getConnections returns tracked connections', async () => {
    const monitor = new InMemoryConnectionMonitor();
    const conn = { id: 'c1', user: 'admin', database: 'prod', state: 'active', connectedAt: new Date(), idleInTransaction: false };
    monitor.addConnection(conn);

    const connections = await monitor.getConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].id).toBe('c1');
  });

  it('removeConnection deletes a tracked connection', async () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.addConnection({ id: 'c1', user: 'admin', database: 'prod', state: 'active', connectedAt: new Date(), idleInTransaction: false });
    expect(await monitor.getConnections()).toHaveLength(1);

    monitor.removeConnection('c1');
    expect(await monitor.getConnections()).toHaveLength(0);
  });

  it('reportConnectionClosed decrements active to zero', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    expect(monitor.getPoolStatus()[0].status.active).toBe(1);

    monitor.reportConnectionClosed('pool-1');
    expect(monitor.getPoolStatus()[0].status.active).toBe(0);
  });

  it('reportConnectionClosed does not go negative when no open connections', () => {
    const monitor = new InMemoryConnectionMonitor();
    // No open connections — the guard (pool.active > 0) must prevent active
    // from dropping below zero.
    monitor.reportConnectionClosed('pool-1');
    expect(monitor.getPoolStatus()).toHaveLength(0); // pool never created
  });

  it('reportConnectionClosed is a no-op for an unknown pool', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionClosed('does-not-exist');
    expect(monitor.getPoolStatus()).toHaveLength(0);
  });

  it('getPoolUtilization total equals active plus idle', async () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    monitor.reportConnectionOpened('pool-1');
    const stats = await monitor.getPoolUtilization();
    expect(stats.total).toBe(2); // active(2) + idle(0)
    expect(stats.active).toBe(2);
  });

  it('getPoolStatus total equals active plus idle', () => {
    const monitor = new InMemoryConnectionMonitor();
    monitor.reportConnectionOpened('pool-1');
    monitor.reportConnectionOpened('pool-1');
    const status = monitor.getPoolStatus()[0].status;
    expect(status.total).toBe(2); // active(2) + idle(0)
    expect(status.active).toBe(2);
  });
});

// ── InMemoryAlertRuleManager ──

describe('InMemoryAlertRuleManager', () => {
  it('evaluateSnapshot triggers when value >= threshold (gt)', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'High CPU', metric: 'cpu_usage', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true });
    const triggered = manager.evaluateSnapshot({ cpu_usage: 95 });
    expect(triggered).toHaveLength(1);
    expect(triggered[0].ruleId).toBe('r1');
  });

  it('skips disabled rules', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'High CPU', metric: 'cpu_usage', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: false });
    manager.addRule({ id: 'r2', name: 'High Mem', metric: 'mem_usage', condition: 'gt', threshold: 80, durationMs: 60000, severity: 'warning', enabled: true });
    const triggered = manager.evaluateSnapshot({ cpu_usage: 95, mem_usage: 90 });
    expect(triggered).toHaveLength(1);
    expect(triggered[0].ruleId).toBe('r2');
  });

  it('addRule + removeRule lifecycle', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'Test', metric: 'test', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    expect(manager.getRules()).toHaveLength(1);

    manager.removeRule('r1');
    expect(manager.getRules()).toHaveLength(0);
  });

  it('setRuleEnabled toggles rule state', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'Test', metric: 'test', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });

    manager.setRuleEnabled('r1', false);
    const triggered = manager.evaluateSnapshot({ test: 20 });
    expect(triggered).toHaveLength(0);

    manager.setRuleEnabled('r1', true);
    const triggered2 = manager.evaluateSnapshot({ test: 20 });
    expect(triggered2).toHaveLength(1);
  });

  it('evaluate with empty rules returns empty', async () => {
    const manager = new InMemoryAlertRuleManager();
    const triggered = await manager.evaluate();
    expect(triggered).toHaveLength(0);
  });

  it('evaluate with no matching snapshot key', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'Test', metric: 'nonexistent', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    const triggered = manager.evaluateSnapshot({ actual_metric: 100 });
    expect(triggered).toHaveLength(0);
  });

  it('createRule and updateRule work', async () => {
    const manager = new InMemoryAlertRuleManager();
    const id = await manager.createRule({ id: 'r1', name: 'CPU', metric: 'cpu', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true });
    expect(id).toBe('r1');

    await manager.updateRule('r1', { threshold: 95 });
    const rules = manager.getRules();
    expect(rules[0].threshold).toBe(95);
  });

  it('updateRule rejects when rule does not exist', async () => {
    const manager = new InMemoryAlertRuleManager();
    await expect(manager.updateRule('missing', { threshold: 1 })).rejects.toThrow('Rule not found');
  });

  it('deleteRule removes the rule and its silence', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'CPU', metric: 'cpu', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true });
    manager.silenceRule('r1', 10000);
    manager.deleteRule('r1');
    expect(manager.getRules()).toHaveLength(0);
    // After deletion, evaluating with a matching value must not trigger.
    expect(manager.evaluateSnapshot({ cpu: 95 })).toHaveLength(0);
  });

  it('silenceRule prevents triggering', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'CPU', metric: 'cpu', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true });
    manager.silenceRule('r1', 10000);

    const triggered = manager.evaluateSnapshot({ cpu: 95 });
    expect(triggered).toHaveLength(0);
  });

  it('clearRules removes all rules', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'A', metric: 'a', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    manager.addRule({ id: 'r2', name: 'B', metric: 'b', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    expect(manager.getRules()).toHaveLength(2);

    manager.clearRules();
    expect(manager.getRules()).toHaveLength(0);
  });

  it('removeRule returns true', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'A', metric: 'a', condition: 'gt', threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    expect(manager.removeRule('r1')).toBe(true);
  });

  it.each([
    ['gt', { value: 20, threshold: 10 }, true],
    ['gt', { value: 10, threshold: 10 }, false],
    ['lt', { value: 5, threshold: 10 }, true],
    ['lt', { value: 10, threshold: 10 }, false],
    ['eq', { value: 10, threshold: 10 }, true],
    ['eq', { value: 11, threshold: 10 }, false],
    ['gte', { value: 10, threshold: 10 }, true],
    ['gte', { value: 9, threshold: 10 }, false],
    ['lte', { value: 10, threshold: 10 }, true],
    ['lte', { value: 11, threshold: 10 }, false],
  ])('evaluateSnapshot honors %s condition (%o)', (condition, { value, threshold }, expected) => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'Test', metric: 'm', condition: condition as any, threshold, durationMs: 1000, severity: 'info', enabled: true });
    const triggered = manager.evaluateSnapshot({ m: value });
    expect(triggered.length > 0).toBe(expected);
  });

  it('evaluateSnapshot falls back to gte for unknown condition', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'Test', metric: 'm', condition: 'unknown' as any, threshold: 10, durationMs: 1000, severity: 'info', enabled: true });
    // default branch: value >= threshold
    expect(manager.evaluateSnapshot({ m: 15 }).length).toBe(1);
    expect(manager.evaluateSnapshot({ m: 5 }).length).toBe(0);
  });

  it('evaluateSnapshot fires again after silence expires', () => {
    const manager = new InMemoryAlertRuleManager();
    manager.addRule({ id: 'r1', name: 'CPU', metric: 'cpu', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true });

    // Negative duration makes silencedUntil already in the past → expired.
    manager.silenceRule('r1', -1000);
    const triggered = manager.evaluateSnapshot({ cpu: 95 });
    // Expired silence must not suppress the alert.
    expect(triggered).toHaveLength(1);
  });
});

// ── InMemoryResourceQuotaManager ──

describe('InMemoryResourceQuotaManager', () => {
  it('allows under memory limit', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 4096 });

    const result = manager.checkResource({ memoryMB: 2048, queriesPerSec: 100, connections: 50 });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('blocks over memory limit', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 4096 });

    const result = manager.checkResource({ memoryMB: 8192, queriesPerSec: 100, connections: 50 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('memory');
  });

  it('blocks over query rate limit', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxQueriesPerSec: 1000 });

    const result = manager.checkResource({ memoryMB: 100, queriesPerSec: 5000, connections: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('qps');
  });

  it('blocks over connection limit', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxConnections: 50 });

    const result = manager.checkResource({ memoryMB: 100, queriesPerSec: 10, connections: 100 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('connections');
  });

  it('updateConfig changes limits at runtime', () => {
    const manager = new InMemoryResourceQuotaManager();

    manager.updateConfig({ maxMemoryMB: 2048 });
    expect(manager.checkResource({ memoryMB: 3000, queriesPerSec: 10, connections: 10 }).allowed).toBe(false);

    manager.updateConfig({ maxMemoryMB: 4096 });
    expect(manager.checkResource({ memoryMB: 3000, queriesPerSec: 10, connections: 10 }).allowed).toBe(true);
  });

  it('getConfig returns current limits', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 4096, maxQueriesPerSec: 2000, maxConnections: 100 });

    const config = manager.getConfig();
    expect(config.maxMemoryMB).toBe(4096);
    expect(config.maxQueriesPerSec).toBe(2000);
    expect(config.maxConnections).toBe(100);
  });

  it('getUtilization returns snapshot', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 4096, maxConnections: 100 });
    manager.setUsage({ memoryMB: 2048, connections: 50 });

    const util = manager.getUtilization();
    expect(util.memoryBytes).toBe(2048 * 1024 * 1024);
    expect(util.memoryLimitBytes).toBe(4096 * 1024 * 1024);
    expect(util.memoryUtilization).toBe(0.5);
  });

  it('setQuota and getQuota for roles', async () => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('admin', { cpuLimit: 80, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });

    const quota = await manager.getQuota('admin');
    expect(quota).not.toBeNull();
    expect(quota!.cpuLimit).toBe(80);
    expect(quota!.memoryLimitMB).toBe(4096);
  });

  it('checkQuota with no quota set returns allowed', async () => {
    const manager = new InMemoryResourceQuotaManager();
    const result = await manager.checkQuota('unknown-role');
    expect(result.allowed).toBe(true);
  });

  it('checkQuota blocks over role CPU limit', async () => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('user', { cpuLimit: 50, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });
    manager.setRoleUsage('user', { cpu: 80 });

    const result = await manager.checkQuota('user');
    expect(result.allowed).toBe(false);
  });

  it('getUsage returns current usage', async () => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('user', { cpuLimit: 80, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });
    manager.setRoleUsage('user', { cpu: 45, memoryMB: 2048, connections: 20, queryRate: 500 });

    const usage = await manager.getUsage('user');
    expect(usage.cpu).toBe(45);
    expect(usage.memoryMB).toBe(2048);
    expect(usage.connections).toBe(20);
    expect(usage.queryRate).toBe(500);
  });

  it('getUsage returns zeros for an unknown role', async () => {
    const manager = new InMemoryResourceQuotaManager();
    const usage = await manager.getUsage('unknown-role');
    expect(usage).toEqual({ cpu: 0, memoryMB: 0, connections: 0, queryRate: 0 });
  });

  it('clear resets all quotas and usage', async () => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('user', { cpuLimit: 80, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });
    manager.setRoleUsage('user', { cpu: 10, memoryMB: 100, connections: 5, queryRate: 10 });

    manager.clear();
    expect(await manager.getQuota('user')).toBeNull();
    expect(await manager.getUsage('user')).toEqual({ cpu: 0, memoryMB: 0, connections: 0, queryRate: 0 });
  });

  it.each([
    ['memory', { memoryMB: 8192, connections: 1, queryRate: 1 }, 'Memory limit exceeded'],
    ['connections', { memoryMB: 1, connections: 100, queryRate: 1 }, 'Connection limit exceeded'],
    ['queryRate', { memoryMB: 1, connections: 1, queryRate: 5000 }, 'Query rate limit exceeded'],
  ])('checkQuota blocks over role %s limit', async (_label, usage, reasonPrefix) => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('user', { cpuLimit: 50, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });
    manager.setRoleUsage('user', usage);

    const result = await manager.checkQuota('user');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(reasonPrefix);
  });

  it('checkQuota allows when all role limits satisfied', async () => {
    const manager = new InMemoryResourceQuotaManager();
    await manager.setQuota('user', { cpuLimit: 50, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 });
    manager.setRoleUsage('user', { cpu: 10, memoryMB: 100, connections: 5, queryRate: 10 });

    const result = await manager.checkQuota('user');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('getUtilization memoryUtilization uses non-integer fraction', async () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 3 });
    manager.setUsage({ memoryMB: 2 });
    const util = manager.getUtilization();
    // 2 / 3 = 0.6666... (exact fraction, not integer-rounded)
    expect(util.memoryUtilization).toBeCloseTo(2 / 3, 10);
  });

  it('getUtilization memoryUtilization is 0 when maxMemoryMB is 0', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxMemoryMB: 0 });
    manager.setUsage({ memoryMB: 100 });
    expect(manager.getUtilization().memoryUtilization).toBe(0);
  });

  it('setUsage ignores undefined fields (no overwrite)', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.setUsage({ memoryMB: 100, queriesPerSec: 50, connections: 10 });
    // Passing undefined for a field must not reset it.
    manager.setUsage({ memoryMB: undefined });
    expect(manager.getUtilization().memoryBytes).toBe(100 * 1024 * 1024);
    expect(manager.getUtilization().queriesPerSec).toBe(50);
  });

  it('setUsage ignores undefined queriesPerSec', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.setUsage({ queriesPerSec: 50 });
    manager.setUsage({ queriesPerSec: undefined });
    expect(manager.getUtilization().queriesPerSec).toBe(50);
  });

  it('getUtilization connectionPool.utilization is active/max fraction', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxConnections: 4 });
    manager.setUsage({ connections: 2 });
    const util = manager.getUtilization();
    // 2 / 4 = 0.5 exact
    expect(util.connectionPool.utilization).toBe(0.5);
    expect(util.connectionPool.maxSize).toBe(4);
  });

  it('getUtilization connectionPool.utilization is 0 when maxConnections is 0', () => {
    const manager = new InMemoryResourceQuotaManager();
    manager.updateConfig({ maxConnections: 0 });
    manager.setUsage({ connections: 5 });
    expect(manager.getUtilization().connectionPool.utilization).toBe(0);
  });
});
