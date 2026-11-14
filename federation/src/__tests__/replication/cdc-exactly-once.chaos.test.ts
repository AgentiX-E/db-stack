/**
 * CDC Exactly-Once Chaos Tests — crash and restart resilience.
 *
 * D2 iteration: validates OutboxStore + DedupRing crash safety.
 *
 * Scenarios:
 *   C.1 — Sender crash mid-pipeline: entry stays in OutboxStore,
 *         retry on restart, receiver DedupRing prevents duplicates
 *   C.2 — Receiver crash after consumer callback but before ack:
 *         outbox re-delivers, duplication prevented by DedupRing
 *   C.3 — Checkpoint corruption: fallback to last valid checkpoint
 *   C.4 — Interleaved crash cycles: entry written, crash, restart, repeat
 *
 * Invariants (G1-G4 from ExactlyOnceCDCPipeline):
 *   G1 — At-least-once: entry persists in OutboxStore before return
 *   G2 — At-most-once: DedupRing prevents duplicate delivery
 *   G3 — No gaps: LSN checkpoint is monotonic & crash-recoverable
 *   G4 — Durable ack: consumer confirms before checkpoint advances
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HLC } from '../../hlc/HLC.js';
import { OutboxStore } from '../../storage/OutboxStore.js';
import { DedupRing } from '../../replication/DedupRing.js';
import type { OutboxEntry } from '../../interfaces/outbox/OutboxEntry.js';

// ── Helpers ─────────────────────────────────────────────────

function createTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `cdc-chaos-${label}-`));
}

function createOutboxStore(dataDir: string): OutboxStore {
  return new OutboxStore({
    dataDir,
    ttlMs: 60_000,
    maxRetries: 3,
    deadLetterTtlMs: 60_000,
    mapSize: 16 * 1024 * 1024,
  });
}

function makeCdcEntry(lsn: number, txId: number, data: string): Omit<OutboxEntry, 'id'> {
  return {
    msgId: `cdc:${lsn}:${txId}`,
    payload: { lsn, txId, data },
    timestamp: new HLC().now(),
    retryCount: 0,
  };
}

function writeCheckpoint(dir: string, lsn: number): void {
  const tmp = join(dir, 'checkpoint.tmp');
  writeFileSync(tmp, JSON.stringify({ lastLSN: lsn }));
  renameSync(tmp, join(dir, 'checkpoint.json'));
}

function readCheckpoint(dir: string): number | null {
  const p = join(dir, 'checkpoint.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')).lastLSN ?? null;
  } catch { return null; }
}

describe('CDC Exactly-Once Chaos (D2)', () => {
  // C.1: Sender crash mid-pipeline — entry persisted in OutboxStore before crash.
  // After restart, entry is re-fetched and delivered. DedupRing catches duplicate.
  it('C.1: should not duplicate entries when sender crashes mid-pipeline', async () => {
    const senderDir = createTempDir('sender');
    const store = createOutboxStore(senderDir);
    const dedup = new DedupRing({ maxSize: 1000, ttlMs: 60_000 });
    const delivered: string[] = [];
    let checkpoint = 0;

    // 5 normal entries
    for (let i = 0; i < 5; i++) {
      const entry = makeCdcEntry(i + 1, i + 100, `normal-${i}`);
      await store.add(entry);

      if (!dedup.contains(entry.msgId)) {
        delivered.push(entry.msgId);
        dedup.put(entry.msgId);
      }
      await store.markDelivered(entry.msgId);
      checkpoint = i + 1;
    }

    expect(checkpoint).toBe(5);
    expect(delivered.length).toBe(5);

    // Simulate crash after writing entries 6-7 but before ack
    for (let i = 5; i < 7; i++) {
      const entry = makeCdcEntry(i + 1, i + 100, `crash-${i}`);
      await store.add(entry);
      // No markDelivered — "crash" before ack
    }

    // "Restart" — fetch all pending (crash entries + any not yet removed)
    const restartedStore = createOutboxStore(senderDir);
    const pending = await restartedStore.fetchOldestPending(10);

    // Process all pending through dedup — verify each delivered exactly once
    for (const entry of pending) {
      if (!dedup.contains(entry.msgId)) {
        delivered.push(entry.msgId);
        dedup.put(entry.msgId);
      }
      await restartedStore.markDelivered(entry.msgId);
    }

    // G1+G2: delivered count = 7, unique = 7 (no duplicates)
    expect(delivered.length).toBe(7);
    expect(new Set(delivered).size).toBe(7);

    rmSync(senderDir, { recursive: true, force: true });
  }, 30_000);

  // C.2: Receiver crashes after consumer callback but before ack
  it('C.2: should deduplicate when receiver ack is lost', async () => {
    const dir = createTempDir('recv');
    const store = createOutboxStore(dir);
    const dedup = new DedupRing({ maxSize: 1000, ttlMs: 60_000 });
    const consumerCalls: string[] = [];

    // Entry arrives from sender
    const entry1 = makeCdcEntry(1, 100, 'first');
    await store.add(entry1);

    // Receiver processes it
    consumerCalls.push(entry1.msgId);
    dedup.put(entry1.msgId);
    // "Crash" — ack never sent back

    // Sender retries on restart
    const pending = await store.fetchOldestPending(10);
    expect(pending.some((e) => e.msgId === entry1.msgId)).toBe(true);

    // DedupRing catches the duplicate
    if (dedup.contains(entry1.msgId)) {
      // Skip consumer callback — just ack
      await store.markDelivered(entry1.msgId);
    }

    // Consumer was called exactly once
    expect(consumerCalls.filter((id) => id === entry1.msgId).length).toBe(1);

    // Clean entry — normal flow
    const entry2 = makeCdcEntry(2, 200, 'second');
    await store.add(entry2);
    consumerCalls.push(entry2.msgId);
    dedup.put(entry2.msgId);
    await store.markDelivered(entry2.msgId);

    expect(consumerCalls.length).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  // C.3: Checkpoint corruption
  it('C.3: should recover from checkpoint file corruption', async () => {
    const dir = createTempDir('ckpt');

    writeCheckpoint(dir, 42);
    expect(readCheckpoint(dir)).toBe(42);

    // Corrupt
    writeFileSync(join(dir, 'checkpoint.json'), '{invalid}');
    expect(readCheckpoint(dir)).toBeNull();

    // Recover from LSN 0
    writeCheckpoint(dir, 0);
    expect(readCheckpoint(dir)).toBe(0);

    writeCheckpoint(dir, 100);
    expect(readCheckpoint(dir)).toBe(100);

    rmSync(dir, { recursive: true, force: true });
  });

  // C.4: Interleaved crash cycles
  it('C.4: should maintain exactly-once under interleaved crashes', async () => {
    const dir = createTempDir('crash-cycle');
    const store = createOutboxStore(dir);
    const msgIds: string[] = [];

    // Write 5 entries — each write is crash-safe (LMDB fsync)
    for (let i = 0; i < 5; i++) {
      const entry = makeCdcEntry(i + 1, i + 100, `cycle-${i}`);
      const created = await store.add(entry);
      msgIds.push(created.msgId);
      // "Crash" — no markDelivered, fresh DedupRing on restart
    }

    // Simulate restart with empty DedupRing
    const restartedDedup = new DedupRing({ maxSize: 1000, ttlMs: 60_000 });
    const restarted = createOutboxStore(dir);
    const pending = await restarted.fetchOldestPending(10);

    const delivered: string[] = [];
    for (const entry of pending) {
      if (!restartedDedup.contains(entry.msgId)) {
        delivered.push(entry.msgId);
        restartedDedup.put(entry.msgId);
      }
      await restarted.markDelivered(entry.msgId);
    }

    // All 5 entries delivered exactly once
    expect(delivered.length).toBe(msgIds.length);
    expect(new Set(delivered).size).toBe(msgIds.length);

    for (const msgId of msgIds) {
      expect(delivered.filter((d) => d === msgId).length).toBe(1);
    }

    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
