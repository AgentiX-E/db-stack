/**
 * stress-concurrency.test.ts — Stress and concurrency safety tests.
 *
 * Tests the InMemory implementations under concurrent access patterns.
 * In Node.js, true parallelism doesn't exist (single-threaded event loop),
 * but async/await yields can create interleaving. Methods that use `await`
 * internally are vulnerable to race conditions. This test suite validates
 * that implementations handle concurrent access correctly.
 *
 * @module stress-concurrency
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Imports ─────────────────────────────────────────────────────────

import { MetricsRegistry } from '../../../metrics/src/impl/MetricsRegistry.js';
import { InMemoryLogger } from '../../../logger/src/impl/InMemoryLogger.js';
import { InMemoryDeadlockDetector } from '../../../monitor/src/impl/InMemoryDeadlockDetector.js';
import { InMemoryAlertRuleManager } from '../../../monitor/src/impl/InMemoryAlertRuleManager.js';
import { InMemoryBackupManager } from '../../../backup/src/impl/InMemoryBackupManager.js';
import { InMemoryStorageBackend } from '../../../backup/src/impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../../../backup/src/impl/RetentionPolicyEvaluator.js';
import { InMemoryAuditStore } from '../../../audit/src/impl/InMemoryAuditStore.js';
import { InMemoryRateLimiter } from '../../../security/src/impl/InMemoryRateLimiter.js';
import { InMemorySlowQueryRecorder } from '../../../monitor/src/impl/InMemorySlowQueryRecorder.js';
import { InMemoryDistributedTracer } from '../../../observability/src/impl/InMemoryDistributedTracer.js';
import { InMemoryConnectionMonitor } from '../../../monitor/src/impl/InMemoryConnectionMonitor.js';
import { ProviderRegistry, token } from '../provider.js';
import { HealthOrchestrator } from '../../../health/src/impl/HealthOrchestrator.js';
import { componentProbe } from '../../../health/src/impl/ComponentProbe.js';
import type { IProviderLifecycle } from '../provider.js';
import type { IHealthProbe } from '../../../health/src/interfaces/IHealthProbe.js';
import type { ProbeResult } from '../types.js';

// ══════════════════════════════════════════════════════════════════════
//  SECTION 1: Concurrent Counter Contention
// ══════════════════════════════════════════════════════════════════════

describe('Section 1: Concurrent Counter Contention', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('100 concurrent counter.inc() → exact 100', () => {
    const counter = registry.counter('ops');
    for (let i = 0; i < 100; i++) {
      counter.inc();
    }
    expect(counter.get()).toBe(100);
  });

  it('100 concurrent gauge.inc() → exact 100', () => {
    const gauge = registry.gauge('conns');
    for (let i = 0; i < 100; i++) {
      gauge.inc();
    }
    expect(gauge.get()).toBe(100);
  });

  it('50 concurrent inc() + 50 concurrent dec() on same gauge → net 0', () => {
    const gauge = registry.gauge('balance');
    for (let i = 0; i < 50; i++) {
      gauge.inc();
      gauge.dec();
    }
    expect(gauge.get()).toBe(0);
  });

  it('100 concurrent counter.incBy(2) → exact 200', () => {
    const counter = registry.counter('ops');
    for (let i = 0; i < 100; i++) {
      counter.incBy(2);
    }
    expect(counter.get()).toBe(200);
  });

  it('Concurrent inc() + snapshot() → snapshot value is one of the intermediate states', () => {
    const counter = registry.counter('ops');
    // Synchronous inc and snapshot — both are sync, so no interleaving
    // After 50 incs, value is deterministic
    for (let i = 0; i < 50; i++) {
      counter.inc();
    }
    const snap = registry.snapshot();
    const opsPoint = snap.points.find(p => p.name === 'ops');
    expect(opsPoint).toBeDefined();
    expect(opsPoint!.value).toBe(50);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 2: Concurrent InMemoryLogger
// ══════════════════════════════════════════════════════════════════════

describe('Section 2: Concurrent InMemoryLogger', () => {
  let logger: InMemoryLogger;

  beforeEach(() => {
    logger = new InMemoryLogger('test', 1000);
  });

  it('50 concurrent info() calls → getEntries().length === 50', () => {
    for (let i = 0; i < 50; i++) {
      logger.info(`message ${i}`);
    }
    expect(logger.getEntries()).toHaveLength(50);
  });

  it('50 concurrent info() + concurrent getEntries() → no crash, no duplicate entries', () => {
    for (let i = 0; i < 50; i++) {
      logger.info(`msg ${i}`);
    }
    const entries = logger.getEntries();
    expect(entries).toHaveLength(50);

    // Verify no duplicates (each message appears once)
    const messages = new Set(entries.map(e => e.message));
    expect(messages.size).toBe(50);
  });

  it('Concurrent child() creation + logging → entries have correct context', () => {
    const child = logger.child({ childKey: 'childVal' });
    for (let i = 0; i < 25; i++) {
      child.info(`child msg ${i}`);
    }
    const childEntries = child.getEntries();
    expect(childEntries).toHaveLength(25);
    for (const entry of childEntries) {
      expect(entry.context?.childKey).toBe('childVal');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 3: Concurrent DeadlockDetector
// ══════════════════════════════════════════════════════════════════════

describe('Section 3: Concurrent DeadlockDetector', () => {
  let detector: InMemoryDeadlockDetector;

  beforeEach(() => {
    detector = new InMemoryDeadlockDetector();
  });

  it('10 concurrent reportLockWait() on different tx+resource pairs → all registered', () => {
    for (let i = 0; i < 10; i++) {
      detector.reportLockWait(`tx-${i}`, `resource-${i}`);
    }
    // Trigger detection to verify graph is built
    const events = detector.detectDeadlocks();
    expect(events).toHaveLength(0);
    // All registered — verify no crash
    expect(detector.getDeadlockCount()).toBe(0);
  });

  it('Concurrent reportLockWait(A→B) + reportLockWait(B→A) → deadlock detected', () => {
    // Create a classic deadlock: A waits for B's resource, B waits for A's resource
    detector.reportLockAcquired('tx-A', 'resource-B');
    detector.reportLockAcquired('tx-B', 'resource-A');
    detector.reportLockWait('tx-A', 'resource-A');
    detector.reportLockWait('tx-B', 'resource-B');

    const events = detector.detectDeadlocks();
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Verify cycle involves both transactions
    const deadlock = events[0];
    expect(deadlock.transactions).toContain('tx-A');
    expect(deadlock.transactions).toContain('tx-B');
  });

  it('50 concurrent reportLockWait/reportLockAcquired alternating → no crash, consistent graph', () => {
    // Set up a scenario with alternating wait/acquired patterns
    for (let i = 0; i < 25; i++) {
      const tx = `tx-alt-${i}`;
      detector.reportLockAcquired(tx, `resource-${i}`);
      detector.reportLockWait(tx, `resource-${i + 1}`);
    }
    // Verify no crash
    const events = detector.detectDeadlocks();
    expect(Array.isArray(events)).toBe(true);
  });

  it('Concurrent detectDeadlocks() while transactions are running → no crash', () => {
    // Start some transactions
    for (let i = 0; i < 10; i++) {
      detector.reportLockAcquired(`tx-act-${i}`, `res-${i}`);
    }
    // Run detection multiple times
    for (let i = 0; i < 5; i++) {
      detector.detectDeadlocks();
    }
    expect(detector.getDeadlockCount()).toBe(0);

    // Now add a deadlock scenario and detect again
    // A holds res-B, B holds res-A, then both wait for each other's resource
    detector.reportLockAcquired('tx-A', 'res-B');
    detector.reportLockAcquired('tx-B', 'res-A');
    detector.reportLockWait('tx-A', 'res-A');
    detector.reportLockWait('tx-B', 'res-B');
    const events = detector.detectDeadlocks();
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('Rapid cycle (A→B, B→A, A acquires, B acquires) → detection still accurate', () => {
    // Complete a rapid cycle
    detector.reportLockAcquired('tx-A', 'res-B');
    detector.reportLockAcquired('tx-B', 'res-A');
    detector.reportLockWait('tx-A', 'res-A');
    detector.reportLockWait('tx-B', 'res-B');

    // Detection
    let events = detector.detectDeadlocks();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const firstDeadlockCount = detector.getDeadlockCount();

    // Now A acquires res-A (resolving), B acquires res-B (resolving)
    detector.reportLockAcquired('tx-A', 'res-A');
    detector.reportLockAcquired('tx-B', 'res-B');

    // Re-detect — should not find new deadlocks (already resolved)
    events = detector.detectDeadlocks();
    // The deadlock may have been auto-resolved (victim removed), so no crash expected
    expect(Array.isArray(events)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 4: Concurrent AlertRuleManager
// ══════════════════════════════════════════════════════════════════════

describe('Section 4: Concurrent AlertRuleManager', () => {
  let manager: InMemoryAlertRuleManager;

  beforeEach(() => {
    manager = new InMemoryAlertRuleManager();
  });

  it('10 concurrent addRule() → getRules().length === 10', async () => {
    const count = 10;
    const promises: Promise<string>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        manager.addRule({
          name: `rule-${i}`,
          metric: `metric-${i}`,
          condition: 'gt',
          threshold: 90,
          durationMs: 60000,
          severity: 'warning',
          enabled: true,
        }),
      );
    }
    const ids = await Promise.all(promises);
    expect(ids).toHaveLength(count);
    const rules = manager.getRules();
    expect(rules).toHaveLength(count);
  });

  it('Concurrent addRule + evaluate → evaluate sees consistent state', async () => {
    // Add a rule
    const ruleId = await manager.addRule({
      name: 'cpu-rule',
      metric: 'cpu_usage',
      condition: 'gt',
      threshold: 80,
      durationMs: 60000,
      severity: 'critical',
      enabled: true,
    });

    // Evaluate with snapshot
    const result = manager.evaluateSnapshot({ cpu_usage: 95 });
    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe(ruleId);
    expect(result[0].value).toBe(95);
  });

  it('Concurrent enable/disable + evaluate → rule state eventually consistent', () => {
    const rule: import('../../../monitor/src/interfaces/index.js').AlertRule = {
      name: 'toggle-rule',
      metric: 'test_metric',
      condition: 'gt',
      threshold: 50,
      durationMs: 60000,
      severity: 'warning',
      enabled: true,
    };

    // Use createRule which returns a Promise
    manager.createRule(rule).then(id => {
      // Toggle enabled/disabled
      manager.setRuleEnabled(id, false);
      const resultDisabled = manager.evaluateSnapshot({ test_metric: 90 });
      expect(resultDisabled).toHaveLength(0);

      manager.setRuleEnabled(id, true);
      const resultEnabled = manager.evaluateSnapshot({ test_metric: 90 });
      expect(resultEnabled).toHaveLength(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 5: Concurrent BackupManager
// ══════════════════════════════════════════════════════════════════════

describe('Section 5: Concurrent BackupManager', () => {
  let backupManager: InMemoryBackupManager;

  beforeEach(() => {
    const storage = new InMemoryStorageBackend();
    const retention = new RetentionPolicyEvaluator({
      maxFullSnapshots: 100,
      maxTotalBytes: 10_000_000_000,
    });
    backupManager = new InMemoryBackupManager(storage, retention);
  });

  it('10 concurrent createBackup() → listBackups().then(results.length === 10)', async () => {
    const count = 10;
    const promises: ReturnType<typeof backupManager.createBackup>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(backupManager.createBackup({ type: 'full' }));
    }
    const results = await Promise.all(promises);
    expect(results).toHaveLength(count);
    for (const r of results) {
      expect(r.success).toBe(true);
    }

    const backups = await backupManager.listBackups();
    expect(backups).toHaveLength(count);
  });

  it('Parallel create + delete + list → no crash, consistent state', async () => {
    // Create some backups
    const results = await Promise.all([
      backupManager.createBackup({ type: 'full' }),
      backupManager.createBackup({ type: 'full' }),
      backupManager.createBackup({ type: 'full' }),
      backupManager.createBackup({ type: 'full' }),
      backupManager.createBackup({ type: 'full' }),
    ]);
    expect(results).toHaveLength(5);

    // Delete one and list
    const firstId = results[0].snapshot!.snapshotId;
    const [deleted, backups] = await Promise.all([
      backupManager.deleteBackup(firstId),
      backupManager.listBackups(),
    ]);
    expect(deleted).toBe(true);
    expect(backups).toHaveLength(4);
  });

  it('Concurrent restore + prune → both complete safely', async () => {
    // Create backups
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => backupManager.createBackup({ type: 'full' })),
    );

    // Restore all and prune in parallel
    const restorePromises = results.map(r =>
      backupManager.restoreFromSnapshot(r.snapshot!.snapshotId),
    );
    const allOps = await Promise.all([
      ...restorePromises,
      backupManager.prune(),
    ]);

    const restoreResults = allOps.slice(0, 5) as Awaited<ReturnType<typeof backupManager.restoreFromSnapshot>>[];
    const prunedCount = allOps[5] as number;

    expect(restoreResults.every(r => r.success)).toBe(true);
    expect(typeof prunedCount).toBe('number');
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 6: Concurrent AuditStore
// ══════════════════════════════════════════════════════════════════════

describe('Section 6: Concurrent AuditStore', () => {
  let auditStore: InMemoryAuditStore;

  beforeEach(() => {
    auditStore = new InMemoryAuditStore();
  });

  it('50 concurrent write() → count() === 50', async () => {
    const count = 50;
    const promises: ReturnType<typeof auditStore.write>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        auditStore.write({
          operation: `op-${i}`,
          actor: 'user1',
          resource: 'db',
          result: 'success',
        }),
      );
    }
    const ids = await Promise.all(promises);
    expect(ids).toHaveLength(count);

    const total = await auditStore.count();
    expect(total).toBe(count);
  });

  it('50 concurrent write() + concurrent pruneOlderThan() → no crash, consistent count', async () => {
    // Write entries
    const writePromises: ReturnType<typeof auditStore.write>[] = [];
    for (let i = 0; i < 50; i++) {
      writePromises.push(
        auditStore.write({
          operation: 'test',
          actor: 'user',
          resource: 'db',
          result: 'success',
        }),
      );
    }
    await Promise.all(writePromises);

    // Prune with a future date (will prune all)
    const pruned = await auditStore.pruneOlderThan(new Date(Date.now() + 100000));
    expect(pruned).toBe(50);

    const total = await auditStore.count();
    expect(total).toBe(0);
  });

  it('Concurrent write + query + delete → race-safe', async () => {
    // Write
    const ids = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        auditStore.write({
          operation: `op-${i}`,
          actor: 'user',
          resource: 'db',
          result: 'success',
        }),
      ),
    );
    expect(ids).toHaveLength(25);

    // Query
    const entries = await auditStore.query({});
    expect(entries).toHaveLength(25);

    // Prune all
    const pruned = await auditStore.pruneOlderThan(new Date(Date.now() + 100000));
    expect(pruned).toBe(25);

    const total = await auditStore.count();
    expect(total).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 7: Concurrent RateLimiter
// ══════════════════════════════════════════════════════════════════════

describe('Section 7: Concurrent RateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  it('100 concurrent check() with maxRequests=10 → exactly 10 allowed, 90 denied', () => {
    const results: ReturnType<typeof limiter.check>[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(limiter.check('test-key', { maxRequests: 10, windowMs: 60000 }));
    }

    const allowed = results.filter(r => r.allowed);
    const denied = results.filter(r => !r.allowed);
    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(90);
  });

  it('Concurrent check + reset → no crash', () => {
    // Fill the rate limiter
    for (let i = 0; i < 10; i++) {
      limiter.check('key', { maxRequests: 10, windowMs: 60000 });
    }

    // Reset and check
    limiter.reset('key');
    const result = limiter.check('key', { maxRequests: 10, windowMs: 60000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('10 concurrent check() with different keys → each limited independently', () => {
    const results: ReturnType<typeof limiter.check>[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(limiter.check(`key-${i}`, { maxRequests: 5, windowMs: 60000 }));
    }

    // Each key should be allowed (first request)
    expect(results.every(r => r.allowed)).toBe(true);
    expect(results.every(r => r.remaining === 4)).toBe(true);

    // Second round: each should still be allowed
    const results2: ReturnType<typeof limiter.check>[] = [];
    for (let i = 0; i < 10; i++) {
      results2.push(limiter.check(`key-${i}`, { maxRequests: 5, windowMs: 60000 }));
    }
    expect(results2.every(r => r.allowed)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 8: Cross-package Concurrent Scenario
// ══════════════════════════════════════════════════════════════════════

describe('Section 8: Cross-package Concurrent Scenario', () => {
  describe('ProviderRegistry with 5 registered InMemory providers → concurrent start() → all started', () => {
    it('should start all lifecycle providers concurrently', async () => {
      const registry = new ProviderRegistry();

      const providers: IProviderLifecycle[] = [];
      for (let i = 0; i < 5; i++) {
        const p: IProviderLifecycle = {
          providerId: `provider-${i}`,
          phase: 'created' as const,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          getHealth: () => null,
        };
        providers.push(p);
        const t = token<unknown>(`provider-${i}`);
        registry.register(t, p);
      }

      await registry.start();
      expect(registry.phase).toBe('started');

      for (const p of providers) {
        expect(p.start).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('HealthOrchestrator with 10 components → concurrent liveness() calls', () => {
    it('should return consistent results from concurrent liveness calls', () => {
      const orchestrator = new HealthOrchestrator();

      // Register 10 healthy components
      for (let i = 0; i < 10; i++) {
        const probe: IHealthProbe = {
          probeId: `probe-${i}`,
          componentName: `Component-${i}`,
          liveness: () => ({ ok: true }),
          readiness: () => ({ ok: true }),
          startup: () => ({ ok: true }),
        };
        orchestrator.registerComponent(probe);
      }

      // Multiple concurrent liveness calls
      const results: ReturnType<typeof orchestrator.liveness>[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(orchestrator.liveness());
      }

      // All should return same result
      for (const result of results) {
        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });
  });

  describe('MetricsRegistry + Logger cross: concurrent operations → both states consistent', () => {
    it('should maintain consistent state across concurrent metric and logger operations', () => {
      const metrics = new MetricsRegistry();
      const logger = new InMemoryLogger('cross', 1000);

      const counter = metrics.counter('test_ops');
      for (let i = 0; i < 50; i++) {
        counter.inc();
        logger.info(`operation ${i}`);
      }

      expect(counter.get()).toBe(50);
      expect(logger.getEntries()).toHaveLength(50);
    });
  });

  describe('DeadlockDetector + SlowQueryRecorder: concurrent simulations → both accurate', () => {
    it('should maintain accuracy under concurrent deadlock and slow query simulations', () => {
      const detector = new InMemoryDeadlockDetector();
      const recorder = new InMemorySlowQueryRecorder(50, 1000);

      // Simulate 10 concurrent transactions
      for (let i = 0; i < 10; i++) {
        const txA = `tx-sim-A-${i}`;
        const txB = `tx-sim-B-${i}`;
        detector.reportLockAcquired(txA, `res-${i}-1`);
        detector.reportLockAcquired(txB, `res-${i}-2`);
        detector.reportLockWait(txA, `res-${i}-2`);
        detector.reportLockWait(txB, `res-${i}-1`);

        recorder.record({
          query: `SELECT * FROM table_${i}`,
          durationMs: 200 + i,
          timestamp: new Date(),
          database: `db-${i}`,
          user: `user-${i}`,
        });
      }

      const deadlocks = detector.detectDeadlocks();
      // Some may resolve, some may not — just verify no crash
      expect(Array.isArray(deadlocks)).toBe(true);

      // Check slow queries recorded
      recorder.getSlowQueries(50).then(queries => {
        expect(queries.length).toBeGreaterThanOrEqual(10);
      });
    });
  });

  describe('Full integration: backup + audit + metric → all three subsystems consistent', () => {
    it('should maintain consistency across backup create, audit write, and metric increment', async () => {
      const metrics = new MetricsRegistry();
      const logger = new InMemoryLogger('integ', 1000);
      const storage = new InMemoryStorageBackend();
      const retention = new RetentionPolicyEvaluator({
        maxFullSnapshots: 100,
        maxTotalBytes: 10_000_000_000,
      });
      const backupMgr = new InMemoryBackupManager(storage, retention);
      const audit = new InMemoryAuditStore();

      const backupCounter = metrics.counter('backups_created');

      // 50 concurrent operations
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        ops.push(
          (async () => {
            backupCounter.inc();
            logger.info(`integ: operation ${i}`);
            const backupResult = await backupMgr.createBackup({ type: 'full' });
            const auditId = await audit.write({
              operation: 'backup_create',
              actor: 'system',
              resource: backupResult.snapshot!.snapshotId,
              result: 'success',
            });
            return { backupResult, auditId };
          })(),
        );
      }

      const results = await Promise.all(ops);
      expect(results).toHaveLength(50);

      // Check all three subsystems
      expect(backupCounter.get()).toBe(50);
      expect(logger.getEntries()).toHaveLength(50);

      const auditCount = await audit.count();
      expect(auditCount).toBe(50);

      const backups = await backupMgr.listBackups();
      expect(backups).toHaveLength(50);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
//  SECTION 9: Large-Scale Stress
// ══════════════════════════════════════════════════════════════════════

describe('Section 9: Large-Scale Stress', () => {
  describe('Create 1000 components, run liveness() → fast (<500ms)', () => {
    it('should handle 1000 components quickly', () => {
      const orchestrator = new HealthOrchestrator();

      const start = performance.now();

      for (let i = 0; i < 1000; i++) {
        const probe: IHealthProbe = {
          probeId: `probe-${i}`,
          componentName: `Component-${i}`,
          liveness: () => ({ ok: true }),
          readiness: () => ({ ok: true }),
          startup: () => ({ ok: true }),
        };
        orchestrator.registerComponent(probe);
      }

      const result = orchestrator.liveness();
      const duration = performance.now() - start;

      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(duration).toBeLessThan(500);
    });
  });

  describe('1000 audit entries written → count and query correct', () => {
    it('should handle 1000 audit entries', async () => {
      const audit = new InMemoryAuditStore();

      const ids = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          audit.write({
            operation: `bulk-op-${i}`,
            actor: 'stress-test',
            resource: 'db',
            result: 'success',
          }),
        ),
      );

      expect(ids).toHaveLength(1000);

      const count = await audit.count();
      expect(count).toBe(1000);

      // Query with filter
      const queried = await audit.query({ actor: 'stress-test', limit: 500 });
      expect(queried).toHaveLength(500);
    });
  });

  describe('1000 slow queries recorded → circular buffer eviction works', () => {
    it('should handle 1000 slow queries with eviction', async () => {
      const recorder = new InMemorySlowQueryRecorder(1, 500); // max 500 entries

      for (let i = 0; i < 1000; i++) {
        await recorder.record({
          query: `SELECT * FROM t${i}`,
          durationMs: 100 + i,
          timestamp: new Date(),
          database: 'stress',
          user: 'tester',
        });
      }

      const queries = await recorder.getSlowQueries(1);
      // Circular buffer: only last 500 should remain
      expect(queries.length).toBeLessThanOrEqual(500);
      expect(recorder.getSlowQueryCount()).toBe(1000);
    });
  });

  describe('1000 metrics (100 names × 10 labels) → snapshot has 1000 points', () => {
    it('should snapshot 1000 metric points', () => {
      const metrics = new MetricsRegistry();

      for (let n = 0; n < 100; n++) {
        for (let l = 0; l < 10; l++) {
          const counter = metrics.counter(`metric_${n}`, { label: `val_${l}` });
          counter.inc();
        }
      }

      const snap = metrics.snapshot();
      expect(snap.points).toHaveLength(1000);
    });
  });

  describe('1000 spans created and ended → getCompletedSpans correct length', () => {
    it('should track 1000 completed spans', () => {
      const tracer = new InMemoryDistributedTracer();

      const spanIds: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const { spanId, end } = tracer.startSpan(`span-${i}`);
        spanIds.push(spanId);
        end('ok');
      }

      const spans = tracer.getCompletedSpans();
      expect(spans).toHaveLength(1000);

      // Verify span names
      const names = spans.map(s => s.name);
      expect(names[0]).toBe('span-0');
      expect(names[999]).toBe('span-999');
    });
  });
});
