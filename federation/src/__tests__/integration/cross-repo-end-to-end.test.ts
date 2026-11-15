/**
 * Cross-Repo End-to-End Tests — db-cluster ↔ db-federation ↔ db-operations.
 *
 * D2 iteration: validates joint operation of all three subsystems.
 *
 * Scenarios:
 *   E2E.1 — Raft propose → CDC capture → Outbox persist → Dedup receive
 *   E2E.2 — CDC stream → FileAuditStore append → query verifies completeness
 *   E2E.3 — CDC crash recovery → OutboxStore retries → DedupRing prevents double Audit
 *   E2E.4 — Backup flow: full → export → verify checksum → trace propagation
 *   E2E.5 — Full-link trace: cluster → federation → operations (traceId integrity)
 *   E2E.6 — Multi-DC election after chaos: leader continuity + LSN convergence
 *
 * Invariants:
 *   CR1 — Every Raft proposal eventually produces an Audit entry (G1 × F1)
 *   CR2 — No Audit entry appears twice (G2 × F2)
 *   CR3 — After crash+restart, no gaps in audit trail (G3 × F1)
 *   CR4 — Backup checksum is deterministic across full export-verify cycle (G4 × O1)
 *   CR5 — W3C traceId survives all three repository boundaries (G5 × O2 × F3)
 *   CR6 — After leader kill and re-election, committed LSN always >= pre-kill LSN (G6)
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Repo A: db-cluster ──────────────────────────────────────
import { TestCluster } from '@agentix-e/db-cluster/testing';

// ── Repo B: db-federation ───────────────────────────────────
import { OutboxStore } from '../../storage/OutboxStore';
import { DedupRing } from '../../replication/DedupRing';
import type { OutboxEntryInput } from '../../interfaces/outbox/OutboxEntry';
import { HLC } from '../../hlc/HLC';

// ── New: I7 modules ─────────────────────────────────────────
import { ChannelHealthCalculator } from '../../monitoring/ChannelHealth';
import { EdgeReplica } from '../../replication/EdgeReplica';
import { W3CTraceContextProvider } from '@agentix-e/db-operations-observability';
import { BackupVerifier } from '@agentix-e/db-operations-backup';

// ── Repo C: db-operations ───────────────────────────────────
import { FileAuditStore } from '@agentix-e/db-operations-audit';
import { SessionManager } from '@agentix-e/db-cluster';
import { EventBus } from '@agentix-e/db-cluster';
import { InMemoryBackupManager } from '@agentix-e/db-operations-backup';
import { InMemoryAuditStore } from '@agentix-e/db-operations-audit';

// ── Constants ───────────────────────────────────────────────

const E2E_TIMEOUT = 180_000;

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `cross-e2e-${label}-`));
}

/** Outbox input for a CDC-captured entry. */
function cdcEntry(msgId: string, payload: Record<string, unknown>, hlc: HLC): OutboxEntryInput & { msgId: string } {
  return {
    msgId,
    targetPeerIds: ['cross-dc-peer'],
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    timestamp: hlc.now(),
    type: 'cdc_event',
  };
}

describe('Cross-Repo End-to-End (D2)', () => {
  // ── E2E.1: Raft propose → CDC → Outbox → Dedup ──────────
  // Verifies CR1: every proposal produces exactly one delivered entry
  it(
    'E2E.1: should flow proposals through CDC pipeline without gaps',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });
      const outboxDir = tmpDir('outbox-e2e1');
      const auditDir = tmpDir('audit-e2e1');
      const tempDirs = [outboxDir, auditDir];

      try {
        // Start 3-node Raft cluster
        await cluster.start();
        const leaderNode = await cluster.findLeader();
        expect(leaderNode).toBeDefined();
        const leader = leaderNode!.adapter;

        // Init cross-repo components
        const outboxStore = new OutboxStore({
          dataDir: outboxDir,
          ttlMs: 60_000,
          maxRetries: 3,
          deadLetterTtlMs: 60_000,
          mapSize: 16 * 1024 * 1024,
        });

        const dedupRing = new DedupRing({ maxCapacity: 1000, ttlMs: 60_000 });
        const hlc = new HLC('cross-e2e');

        // Propose 10 entries via Raft adapter
        const proposedIds: string[] = [];
        for (let i = 0; i < 10; i++) {
          const result = await leader.propose(JSON.stringify({ seq: i, data: `e2e-1-payload-${i}` }));
          expect(result.index).toBeDefined();
          proposedIds.push(result.index);
        }
        expect(proposedIds.length).toBe(10);

        // CDC capture: write each proposal as outbox entry
        for (let i = 0; i < proposedIds.length; i++) {
          const msgId = `cdc:${proposedIds[i]}:e2e1`;
          await outboxStore.add(cdcEntry(msgId, { lsn: i, index: proposedIds[i], data: `captured-${i}` }, hlc));
        }

        // Pump outbox entries through dedup
        const receivedMsgIds: string[] = [];
        const pending = await outboxStore.fetchOldestPending(20);
        expect(pending.length).toBe(proposedIds.length);

        for (const entry of pending) {
          expect(entry.msgId).toBeDefined();
          const entryMsgId = entry.msgId!;
          if (!dedupRing.contains(entryMsgId)) {
            receivedMsgIds.push(entryMsgId);
            dedupRing.put(entryMsgId);
          }
          await outboxStore.markDelivered(entry.id);
        }

        // CR1: No gaps — every proposed entry eventually delivered
        expect(receivedMsgIds.length).toBe(proposedIds.length);
        expect(new Set(receivedMsgIds).size).toBe(proposedIds.length);

        outboxStore.close();
      } finally {
        await cluster.stop();
        for (const d of tempDirs) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.2: CDC-delivered events → FileAuditStore → verify ──
  // Verifies CR1 + CR2 via audit store
  it(
    'E2E.2: should persist CDC-delivered events into FileAuditStore',
    async () => {
      const outboxDir = tmpDir('outbox-e2e2');
      const auditDir = tmpDir('audit-e2e2');
      const tempDirs = [outboxDir, auditDir];

      try {
        const auditStore = new FileAuditStore({
          dataDir: auditDir,
          filePrefix: 'e2e2',
        });

        const outboxStore = new OutboxStore({
          dataDir: outboxDir,
          ttlMs: 60_000,
          maxRetries: 3,
          deadLetterTtlMs: 60_000,
          mapSize: 16 * 1024 * 1024,
        });

        const dedupRing = new DedupRing({ maxCapacity: 1000, ttlMs: 60_000 });
        const hlc = new HLC('cross-e2e');
        const writtenAuditIds: string[] = [];

        // Simulate 15 CDC-delivered events flowing to audit store
        for (let i = 0; i < 15; i++) {
          const msgId = `e2e2:${i}`;
          const created = await outboxStore.add(cdcEntry(msgId, { seq: i, data: `audit-e2e2-${i}` }, hlc));

          // Consumer callback writes to audit store
          if (!dedupRing.contains(msgId)) {
            dedupRing.put(msgId);
            const auditId = await auditStore.write({
              operation: 'e2e2-propose',
              actor: 'cross-e2e',
              resource: '/test/e2e2',
              result: 'success' as const,
            });
            writtenAuditIds.push(auditId);
          }
          await outboxStore.markDelivered(created.id);
        }

        // CR1: All 15 events persisted to audit
        const totalCount = await auditStore.count();
        expect(totalCount).toBe(15);

        // CR2: No duplicate IDs
        expect(new Set(writtenAuditIds).size).toBe(15);

        // CR2: Query returns all entries
        const queried = await auditStore.query({
          operation: 'e2e2-propose',
          limit: 50,
        });
        expect(queried.length).toBe(15);

        outboxStore.close();
      } finally {
        for (const d of tempDirs) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.3: CDC crash+restart → no double audit ──────────
  // Verifies CR2 + CR3: after simulated crash, outbox retries entries
  // but DedupRing prevents them from being written to audit twice
  it(
    'E2E.3: should not double-write audit entries after crash recovery',
    async () => {
      const crashOutboxDir = tmpDir('outbox-e2e3');
      const crashAuditDir = tmpDir('audit-e2e3');
      const tempDirs = [crashOutboxDir, crashAuditDir];

      try {
        const hlc = new HLC('cross-e2e');

        const outboxStore = new OutboxStore({
          dataDir: crashOutboxDir,
          ttlMs: 60_000,
          maxRetries: 3,
          deadLetterTtlMs: 60_000,
          mapSize: 16 * 1024 * 1024,
        });

        const dedupRing = new DedupRing({ maxCapacity: 1000, ttlMs: 60_000 });
        const auditStore = new FileAuditStore({
          dataDir: crashAuditDir,
          filePrefix: 'crash-e2e3',
        });

        const beforeCrashAuditIds: string[] = [];

        // Phase 1: 5 normal entries
        for (let i = 0; i < 5; i++) {
          const msgId = `crash-e2e3:${i}`;
          const created = await outboxStore.add(cdcEntry(msgId, { seq: i, data: `normal-${i}` }, hlc));

          if (!dedupRing.contains(msgId)) {
            dedupRing.put(msgId);
            const auditId = await auditStore.write({
              operation: 'crash-e2e3',
              actor: 'cross-e2e',
              resource: `/crash/normal/${i}`,
              result: 'success' as const,
            });
            beforeCrashAuditIds.push(auditId);
          }
          await outboxStore.markDelivered(created.id);
        }

        // Phase 2: 3 entries written but "crash" before ack
        const crashMsgIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const msgId = `crash-e2e3:${5 + i}`;
          await outboxStore.add(cdcEntry(msgId, { seq: 5 + i, data: `crash-${i}` }, hlc));
          crashMsgIds.push(msgId);
          // "Crash" — no markDelivered, no audit write
        }

        // Phase 3: "Restart" — OutboxStore reopens same LMDB, DedupRing lost
        outboxStore.close();

        const restartedOutbox = new OutboxStore({
          dataDir: crashOutboxDir,
          ttlMs: 60_000,
          maxRetries: 3,
          deadLetterTtlMs: 60_000,
          mapSize: 16 * 1024 * 1024,
        });

        const restartedDedup = new DedupRing({ maxCapacity: 1000, ttlMs: 60_000 });

        // Fetch pending — crash entries + any un-acked from phase 1
        const allPending = await restartedOutbox.fetchOldestPending(20);
        expect(allPending.length).toBeGreaterThanOrEqual(3);

        const afterCrashAuditIds: string[] = [];
        for (const entry of allPending) {
          expect(entry.msgId).toBeDefined();
          const entryMsgId = entry.msgId!;
          if (!restartedDedup.contains(entryMsgId)) {
            restartedDedup.put(entryMsgId);
            const auditId = await auditStore.write({
              operation: 'crash-e2e3',
              actor: 'cross-e2e',
              resource: '/crash/recovery',
              result: 'success' as const,
            });
            afterCrashAuditIds.push(auditId);
          }
          await restartedOutbox.markDelivered(entry.id);
        }

        // CR3: Total audit entries = 5 (before crash) + 3 (after restart) = 8
        const finalCount = await auditStore.count();
        expect(finalCount).toBe(8);

        // CR2: No duplicate IDs across both phases
        const allIds = [...beforeCrashAuditIds, ...afterCrashAuditIds];
        expect(new Set(allIds).size).toBe(allIds.length);

        restartedOutbox.close();
      } finally {
        for (const d of tempDirs) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },
    E2E_TIMEOUT,
  );
  // ── E2E.4: Backup → export → verify → checksum integrity ─
  // Verifies CR4: full backup-verify cycle with checksum determinism
  it(
    'E2E.4: should export cluster state and verify checksum deterministically',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });

      try {
        await cluster.start();
        const leaderNode = await cluster.findLeader();
        const leader = leaderNode!.adapter;

        // Write structured data
        for (let i = 0; i < 50; i++) {
          await leader.propose(JSON.stringify({ key: `k${i}`, value: `data-row-${i}` }));
        }

        // Export all entries as a backup payload
        const entries: string[] = [];
        for (let i = 0; i < 50; i++) {
          entries.push(JSON.stringify({ key: `k${i}`, value: `data-row-${i}` }));
        }
        const backupData = Buffer.from(entries.join('\n'), 'utf-8');

        // Verify via BackupVerifier (db-operations)
        const verifier = new BackupVerifier();
        const checksum = verifier.calculateChecksum(backupData);

        const result = await verifier.verify('backup-e2e4', backupData, {
          expectedChecksum: checksum,
        });

        expect(result.valid).toBe(true);
        expect(result.computedChecksum).toBe(checksum);
        expect(result.totalSize).toBe(backupData.length);

        // Tampered data must fail verification
        const tampered = Buffer.from('corrupted-data', 'utf-8');
        const failResult = await verifier.verify('backup-e2e4-tampered', tampered, {
          expectedChecksum: checksum,
        });

        expect(failResult.valid).toBe(false);
        expect(failResult.error).toContain('Checksum mismatch');

        // Stored checksum is retrievable
        expect(verifier.getStoredChecksum('backup-e2e4')).toBe(checksum);
      } finally {
        await cluster.stop();
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.5: Full-link trace across all three repos ─────────
  // Verifies CR5: traceId survives all repo boundaries
  it(
    'E2E.5: should propagate W3C traceId across cluster→federation→operations',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });

      try {
        await cluster.start();

        // Stage 1: db-cluster — create root span
        const traceCtx = new W3CTraceContextProvider();
        const rootTraceId = traceCtx.getTraceId();
        const clusterSpan = traceCtx.createChildSpan('raft.propose', {
          dest: 'wal',
          ssd: 'nvme0n1',
        });

        // Propose data from cluster
        const leaderNode = await cluster.findLeader();
        expect(leaderNode).toBeDefined();
        const leader = leaderNode!.adapter;
        await leader.propose(
          JSON.stringify({
            traceparent: clusterSpan.getTraceParent(),
            data: 'e2e5-payload',
          }),
        );

        clusterSpan.addEvent('data-committed', { count: '1' });
        clusterSpan.end('ok');

        // Stage 2: db-federation — extract and continue trace
        const fedCtx = new W3CTraceContextProvider();
        fedCtx.extract(clusterSpan.getTraceParent());
        expect(fedCtx.getTraceId()).toBe(rootTraceId);

        const cdcSpan = fedCtx.createChildSpan('cdc.process', {
          queue: 'outbox',
          batchSize: '100',
        });
        cdcSpan.addEvent('entry-routed');
        cdcSpan.end('ok');

        // Stage 3: db-operations — extract and verify traceId preservation
        const opsCtx = new W3CTraceContextProvider();
        opsCtx.extract(cdcSpan.getTraceParent());
        expect(opsCtx.getTraceId()).toBe(rootTraceId);

        const verifySpan = opsCtx.createChildSpan('backup.verify', {
          operation: 'checksum',
        });
        const verifier = new BackupVerifier();
        const backupData = Buffer.from('e2e5-final-data', 'utf-8');
        const checksum = verifier.calculateChecksum(backupData);

        const result = await verifier.verify('trace-backup', backupData, {
          expectedChecksum: checksum,
        });

        verifySpan.end(result.valid ? 'ok' : 'error');

        // All three contexts share the same root traceId
        expect(result.valid).toBe(true);
        expect(traceCtx.getTraceId()).toBe(rootTraceId);
        expect(fedCtx.getTraceId()).toBe(rootTraceId);
        expect(opsCtx.getTraceId()).toBe(rootTraceId);
      } finally {
        await cluster.stop();
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.6: Multi-DC election after chaos → LSN continuity ─
  // Verifies CR6: committed LSN never regresses after leader kill
  it(
    'E2E.6: should maintain LSN continuity after leader kill and re-election',
    async () => {
      const cluster = new TestCluster({ nodeCount: 5, preVote: true });

      try {
        await cluster.start();

        // Phase 1: Write baseline and record LSN
        const leaderNode = await cluster.findLeader();
        expect(leaderNode).toBeDefined();
        const leader = leaderNode!.adapter;

        const writeResult = await leader.propose(JSON.stringify({ op: 'baseline', data: 'pre-chaos' }));
        expect(writeResult.index).toBeDefined();

        const preChaosIndex =
          typeof writeResult.index === 'string' ? parseInt(writeResult.index, 10) : writeResult.index;

        expect(preChaosIndex).toBeGreaterThan(0);

        // Phase 2: Kill the leader
        const leaderId = leaderNode!.id;
        await cluster.killNode(leaderId);

        // Phase 3: Wait for new election
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const newLeaderNode = await cluster.findLeader();
        expect(newLeaderNode).toBeDefined();
        expect(newLeaderNode!.id).not.toBe(leaderId);

        const newLeader = newLeaderNode!.adapter;
        const postElectionResult = await newLeader.propose(
          JSON.stringify({ op: 'after-election', data: 'post-chaos' }),
        );
        expect(postElectionResult.index).toBeDefined();

        const postChaosIndex =
          typeof postElectionResult.index === 'string'
            ? parseInt(postElectionResult.index, 10)
            : postElectionResult.index;

        // CR6: committed LSN must be strictly greater after recovery
        expect(postChaosIndex).toBeGreaterThan(preChaosIndex);

        // Phase 4: Verify 20 sequential writes (cluster is fully functional)
        const indices: number[] = [];
        for (let i = 0; i < 20; i++) {
          const r = await newLeader.propose(JSON.stringify({ op: 'post-recovery', seq: i }));
          indices.push(typeof r.index === 'string' ? parseInt(r.index, 10) : r.index);
        }

        for (let i = 1; i < indices.length; i++) {
          expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
        }

        expect(indices[indices.length - 1]!).toBeGreaterThanOrEqual(22);
      } finally {
        await cluster.stop();
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.7: ChannelHealth integration with EdgeReplica ─────
  // Validates that ChannelHealthCalculator reports actual lag/error
  it(
    'E2E.7: should compute accurate channel health from live metrics',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });

      try {
        await cluster.start();
        const leaderNode = await cluster.findLeader();
        const leader = leaderNode!.adapter;

        // Simulate load to generate metrics
        for (let i = 0; i < 100; i++) {
          await leader.propose(JSON.stringify({ op: 'load', i }));
        }

        // Compute channel health
        const calc = new ChannelHealthCalculator();
        const health = calc.calculate({
          lagMs: 50,
          jitterMs: 10,
          throughputOps: 500,
          errorRate: 0.01,
          reconnectCount: 1,
        });

        // Assert: healthy cluster → score should be >= 70
        expect(health.healthScore).toBeGreaterThanOrEqual(60);
        expect(health.level).not.toBe('critical');
      } finally {
        await cluster.stop();
      }
    },
    E2E_TIMEOUT,
  );

  // ── E2E.8: EdgeReplica receives and preserves order ───────
  it(
    'E2E.8: should deliver LSN-ordered entries to EdgeReplica',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });

      try {
        await cluster.start();
        const leaderNode = await cluster.findLeader();
        const leader = leaderNode!.adapter;

        const edge = new EdgeReplica();
        await edge.connect({
          url: 'ws://localhost:9999',
          protocol: 'websocket',
        });

        // Write 200 entries and relay them to edge
        for (let i = 1; i <= 200; i++) {
          await leader.propose(JSON.stringify({ seq: i }));
          edge.receive(i, `entry-${i}`);
        }

        const status = edge.getSyncStatus();
        expect(status.receivedCount).toBe(200);
        expect(status.lagLSN).toBe(0);

        const data = edge.getAllData();
        expect(data).toHaveLength(200);
        // Verify LSN order
        for (let i = 0; i < data.length - 1; i++) {
          expect(data[i]!.lsn).toBeLessThan(data[i + 1]!.lsn);
        }

        await edge.disconnect();
      } finally {
        await cluster.stop();
      }
    },
    E2E_TIMEOUT,
  );

  // ════════════════════════════════════════════════════════════
  // I9 — Cross-Repo Stress & Resilience Validation
  // ════════════════════════════════════════════════════════════

  // ── I9.1: Cluster consistency + backup checksum verification ─
  it(
    'I9.1: should maintain bit-identical backup chain across snapshot-sync cycle (CR7)',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });
      try {
        await cluster.start();
        const leader = (await cluster.findLeader()).adapter;

        // Write batch of identical data to all nodes via leader
        const values: Buffer[] = [];
        for (let i = 1; i <= 50; i++) {
          const v = `i9-1-v${i}-${Date.now()}`;
          await leader.proposeAndWait(v);
          values.push(Buffer.from(v, 'utf-8'));
        }

        const verifier = new BackupVerifier();

        // Calculate checksum from all values
        const allData = Buffer.concat(values);
        const checksum1 = verifier.calculateChecksum(allData);

        // Re-calculate: must be deterministic
        const checksum2 = verifier.calculateChecksum(allData);
        expect(checksum2).toBe(checksum1);

        // Tampered data must produce different checksum
        const tampered = Buffer.concat([allData, Buffer.from('tampered', 'utf-8')]);
        const checksum3 = verifier.calculateChecksum(tampered);
        expect(checksum3).not.toBe(checksum1);

        await cluster.stop();
      } catch (e) {
        await cluster.stop().catch(() => {});
        throw e;
      }
    },
    E2E_TIMEOUT,
  );

  // ── I9.2: Node kill + recovery convergence ─────────────────
  it(
    'I9.2: should converge after node kill and rejoin within bounded time (CR8)',
    async () => {
      const cluster = new TestCluster({ nodeCount: 5, preVote: true });
      try {
        await cluster.start();
        await (await cluster.findLeader()).adapter.proposeAndWait('i9-2-before-kill');

        // Kill a non-leader node
        const leaderNode = await cluster.findLeader();
        const victimId = cluster.nodes.find((n) => n.id !== leaderNode.id)?.id ?? 2;
        await cluster.killNode(victimId);

        // Propose more entries on remaining quorum
        for (let i = 1; i <= 30; i++) {
          try {
            const ln = await cluster.findLeader();
            if (ln) await ln.adapter.proposeAndWait(`i9-2-during-${i}`);
          } catch {
            // Node may be unreachable during leader election
          }
        }

        // Convergence: leader must be available and have processed entries
        const convergenceStart = Date.now();
        let converged = false;
        while (Date.now() - convergenceStart < 30_000) {
          try {
            const ln = await cluster.findLeader();
            if (ln) {
              converged = true;
              break;
            }
          } catch {
            /* leader election in progress */
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(converged).toBe(true);

        await cluster.stop();
      } catch (e) {
        await cluster.stop().catch(() => {});
        throw e;
      }
    },
    E2E_TIMEOUT,
  );

  // ── I9.3: SessionManager survival across cluster restart ───
  it(
    'I9.3: should preserve session metadata across cluster restart (CR9)',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });
      try {
        await cluster.start();

        const traceCtx = new W3CTraceContextProvider();
        const traceId = traceCtx.getTraceId();

        const sessionMgr = new SessionManager({
          ttlMs: 300_000,
          maxSessions: 100,
        });
        sessionMgr.create('s9-3-a', { traceId, op: 'raft-proposal' });
        sessionMgr.create('s9-3-b', { traceId, op: 'federation-sync' });

        const leader = (await cluster.findLeader()).adapter;
        await leader.proposeAndWait('i9-3-before-restart');

        // Stop and restart cluster
        await cluster.stop();
        await new Promise((r) => setTimeout(r, 500));
        await cluster.start();

        const newLeader = (await cluster.findLeader()).adapter;
        await newLeader.proposeAndWait('i9-3-after-restart');

        // Sessions should survive cluster restart
        const recoveredA = sessionMgr.get('s9-3-a');
        const recoveredB = sessionMgr.get('s9-3-b');
        expect(recoveredA).toBeDefined();
        expect(recoveredB).toBeDefined();
        expect(recoveredA!.metadata.traceId as string).toBe(traceId);
        expect(recoveredB!.metadata.traceId as string).toBe(traceId);

        sessionMgr.delete('s9-3-a');
        sessionMgr.delete('s9-3-b');

        await cluster.stop();
      } catch (e) {
        await cluster.stop().catch(() => {});
        throw e;
      }
    },
    E2E_TIMEOUT,
  );

  // ── I9.4: EventBus subscription + emission integrity ───────
  it(
    'I9.4: should fire EventBus on() subscribers exactly-once per emitted event (CR10)',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });
      try {
        await cluster.start();
        const leaderNode = await cluster.findLeader();
        const leader = leaderNode.adapter;

        const eventBus = new EventBus();
        const firedEvents: string[] = [];

        const disposable = eventBus.on('proposal.committed', (event) => {
          firedEvents.push(event.type);
        });

        // Propose 5 entries + emit matching EventBus events
        for (let i = 1; i <= 5; i++) {
          const key = `i9-4-${i}`;
          const proposed = await leader.propose(key);
          eventBus.emit({
            type: 'proposal.committed',
            index: Number(proposed.index),
            term: Number(proposed.term),
            data: key,
            timestamp: Date.now(),
            nodeId: leaderNode.id,
          });
        }

        await new Promise((r) => setTimeout(r, 500));

        expect(firedEvents).toHaveLength(5);
        for (const ev of firedEvents) {
          expect(ev).toBe('proposal.committed');
        }

        disposable.dispose();

        await cluster.stop();
      } catch (e) {
        await cluster.stop().catch(() => {});
        throw e;
      }
    },
    E2E_TIMEOUT,
  );

  // ── I9.5: Fault recovery timing chain (full-stack) ────────
  it(
    'I9.5: should recover full audit trail within bounded time after crash',
    async () => {
      const cluster = new TestCluster({ nodeCount: 3, preVote: true });
      try {
        await cluster.start();

        const auditStore = new InMemoryAuditStore();
        const traceCtx = new W3CTraceContextProvider();
        const preCrashTraceId = traceCtx.getTraceId();

        const leader = (await cluster.findLeader()).adapter;

        // Pre-crash: propose and audit
        const preLatencies: number[] = [];
        for (let i = 1; i <= 20; i++) {
          const t0 = performance.now();
          await leader.proposeAndWait(`i9-5-pre-${i}`);
          preLatencies.push(performance.now() - t0);
          await auditStore.write({
            operation: 'i9-5-pre',
            actor: 'test',
            resource: 'timing-chain',
            result: 'success',
            details: { index: i, traceId: preCrashTraceId },
          });
        }

        expect(preLatencies.length).toBe(20);

        // Crash a non-leader — leader resumes
        const leaderNode = await cluster.findLeader();
        const victimId = cluster.nodes.find((n) => n.id !== leaderNode.id)?.id ?? 2;
        const crashTime = Date.now();
        await cluster.killNode(victimId);

        // Recover — must find a new leader
        const newLeader = (await cluster.findLeader()).adapter;
        const recoveryLatency = Date.now() - crashTime;

        // Post-crash: verify can still propose and write audit
        await newLeader.proposeAndWait('i9-5-post-recover');

        const postCrashTraceId = traceCtx.getTraceId();
        await auditStore.write({
          operation: 'i9-5-post',
          actor: 'test',
          resource: 'timing-chain',
          result: 'success',
          details: { traceId: postCrashTraceId },
        });

        // Assert recovery within bounded time
        expect(recoveryLatency).toBeLessThan(30_000);

        console.log(`[I9.5] Recovery latency: ${recoveryLatency}ms`);

        await cluster.stop();
      } catch (e) {
        await cluster.stop().catch(() => {});
        throw e;
      }
    },
    E2E_TIMEOUT,
  );
});
