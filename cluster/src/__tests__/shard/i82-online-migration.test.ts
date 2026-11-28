/**
 * Online shard migration — the numbers come from the shard, not from a random generator.
 *
 * `C-02` in the audit: the coordinator answered `startMigration` with a byte
 * total drawn from `Math.random()`, advanced `bytesCopied` by the configured
 * batch size whether or not anything was copied, and added a random "delta" per
 * catch-up round. Every case below fails against that code with a named
 * assertion, which is the acceptance the roadmap asked for.
 *
 *   OM.1   progress is the source's entry count, measured
 *   OM.2   a migration of an empty shard reports zero entries, not a plausible curve
 *   OM.3   writes that arrive during the copy are caught up, and counted
 *   OM.4   the watermark means no entry is copied twice
 *   OM.5   the target's count is compared against the source's before completion
 *   OM.6   a lost write fails the migration with both counts in the message
 *   OM.7   a key deleted between the scan and the read is reconciled, not copied
 *   OM.8   the catch-up is bounded by `finalSyncTimeoutMs`
 *   OM.9   a manual cutover takes the same conservation check
 *   OM.10  writes are suspended only inside the cutover window
 *   OM.11  rollback and cancel stop the run and clear the suspended flag
 *   OM.12  the status carries the watermark the coordinator reached
 */

import { describe, expect, it } from 'vitest';
import { OnlineShardMigration } from '../../shard/OnlineShardMigration';
import type { IMigrationConfig } from '../../interfaces/shard/IOnlineShardMigration';
import { MemoryShardSink, MemoryShardSource, MemoryStore } from './migration-memory';

function config(overrides: Partial<IMigrationConfig> = {}): IMigrationConfig {
  return {
    shardId: 7,
    sourceNode: 'node-a',
    targetNode: 'node-b',
    batchSize: 4,
    finalSyncTimeoutMs: 500,
    pauseWritesOnCutover: false,
    ...overrides,
  };
}

/** A source with `count` entries, values sized so bytes are not equal to entries. */
function seeded(count: number, value = 'v'): MemoryShardSource {
  const store = new MemoryStore();
  for (let i = 0; i < count; i += 1) store.put(`key-${i}`, value);
  return new MemoryShardSource(store);
}

describe('OnlineShardMigration — measured against the shard', () => {
  it('OM.1: progress is the source’s entry count, not a batch counter over a random total', async () => {
    const migration = new OnlineShardMigration(seeded(8, 'value'), new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config({ batchSize: 4 }));

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('completed');
    expect(status.progress).toBe(100);
    expect(status.entriesTotal).toBe(8);
    expect(status.entriesCopied).toBe(8);
    // Bytes are measured from the source, so eight entries of `key-N` + `value`
    // are more than eight bytes and fewer than eight times a kilobyte.
    expect(status.bytesCopied).toBeGreaterThan(8);
    expect(status.bytesCopied).toBe(seeded(8, 'value').store.bytes());
  });

  it('OM.2: an empty shard reports zero entries and completes without inventing a curve', async () => {
    const migration = new OnlineShardMigration(seeded(0), new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config());

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('completed');
    expect(status.entriesTotal).toBe(0);
    expect(status.entriesCopied).toBe(0);
    expect(status.bytesCopied).toBe(0);
    expect(status.remainingBytes).toBe(0);
  });

  it('OM.3: a write that arrives during the copy is caught up and counted', async () => {
    const source = seeded(6);
    const sink = new MemoryShardSink();
    let injected = false;
    source.onScan = () => {
      if (injected) return;
      injected = true;
      // One entry lands between the first and the second page of the copy.
      source.store.put('late', 'arrived-during-copy');
    };

    const migration = new OnlineShardMigration(source, sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 3 }));
    const status = await migration.waitForCompletion(migrationId);

    expect(status.phase).toBe('completed');
    const target = sink.storeFor('node-b');
    expect(target.get('late')?.value).toBe('arrived-during-copy');
    expect(target.size).toBe(7);
    expect(status.entriesCopied).toBe(7);
    expect(status.entriesTotal).toBe(7);
  });

  it('OM.4: the watermark means no entry is copied twice', async () => {
    const sink = new MemoryShardSink();
    const migration = new OnlineShardMigration(seeded(10), sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 3 }));
    await migration.waitForCompletion(migrationId);

    const keys = sink.applied.map((entry) => entry.key);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(10);
    // Ascending version order: a later write is applied after an earlier one.
    const versions = sink.applied.map((entry) => entry.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it('OM.5: the target’s count is compared against the source’s before completion', async () => {
    const sink = new MemoryShardSink();
    const migration = new OnlineShardMigration(seeded(5), sink);
    const { migrationId } = await migration.startMigration(config());
    const status = await migration.waitForCompletion(migrationId);

    const sourceStats = await seeded(5).stats();
    expect(status.entriesCopied).toBe(sourceStats.entries);
    expect(sink.storeFor('node-b').size).toBe(sourceStats.entries);
  });

  it('OM.6: a lost write fails the migration with both counts in the message', async () => {
    const sink = new MemoryShardSink();
    sink.dropKeys.add('key-2');
    const migration = new OnlineShardMigration(seeded(5), sink);
    const { migrationId } = await migration.startMigration(config());

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('lost entries');
    expect(status.error).toContain("the target holds 4 of the source's 5");
    // The migration does not claim to have copied what never arrived.
    expect(status.progress).toBeLessThan(100);
  });

  it('OM.7: a key deleted between the scan and the read is reconciled, not copied', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 4; i += 1) store.put(`key-${i}`, `v-${i}`);
    const source = new MemoryShardSource(store);
    const sink = new MemoryShardSink();
    let deleted = false;
    source.onScan = () => {
      if (deleted) return;
      deleted = true;
      // The shard loses the key before the coordinator reads it.
      store.delete('key-1');
    };

    const migration = new OnlineShardMigration(source, sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));
    const status = await migration.waitForCompletion(migrationId);

    expect(status.phase).toBe('completed');
    expect(sink.storeFor('node-b').get('key-1')).toBeUndefined();
    expect(sink.storeFor('node-b').size).toBe(3);
    expect(status.entriesCopied).toBe(3);
  });

  it('OM.8: the catch-up is bounded by finalSyncTimeoutMs', async () => {
    const source = seeded(4);
    let written = 0;
    // A shard under sustained write load: every scan sees one more entry.
    source.onScan = () => {
      written += 1;
      source.store.put(`relentless-${written}`, 'x');
    };

    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    const started = Date.now();
    const { migrationId } = await migration.startMigration(config({ batchSize: 2, finalSyncTimeoutMs: 50 }));
    const status = await migration.waitForCompletion(migrationId);

    // It ends, and it refuses to cut over. A catch-up that cannot end is a
    // migration that never finishes, and the deadline is the only thing that
    // distinguishes "behind" from "stuck" — but a target that is behind must not
    // be announced as one that is current, so the migration fails by name.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('did not quiesce within 50 ms');
    expect(status.caughtUpVersion).toBeGreaterThan(4);
  });

  it('OM.9: a manual cutover takes the same conservation check as the automatic one', async () => {
    const sink = new MemoryShardSink();
    sink.dropKeys.add('key-0');
    const migration = new OnlineShardMigration(seeded(6), sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 1 }));

    // Force it: a cutover that skipped the check would report a migration the
    // automatic path had refused.
    await expect(migration.cutover(migrationId)).rejects.toThrow('lost entries');
    expect((await migration.getStatus(migrationId)).phase).toBe('failed');
  });

  it('OM.10: writes are suspended only inside the cutover window', async () => {
    const sink = new MemoryShardSink();
    const migration = new OnlineShardMigration(seeded(6), sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 2, pauseWritesOnCutover: true }));

    // Before the run reaches cutover there is nothing to suspend.
    expect(migration.areWritesSuspended(migrationId)).toBe(false);
    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('completed');
    // And the suspension is released when the migration completes, or the shard
    // it left behind would refuse writes forever.
    expect(migration.areWritesSuspended(migrationId)).toBe(false);
    expect(migration.getActiveMigrationCount()).toBe(0);
  });

  it('OM.11: rollback and cancel stop the run and clear the suspended flag', async () => {
    const rollbackSink = new MemoryShardSink();
    const rollback = new OnlineShardMigration(seeded(6), rollbackSink);
    const rolled = await rollback.startMigration(config({ batchSize: 1, pauseWritesOnCutover: true }));

    expect((await rollback.getStatus(rolled.migrationId)).phase).not.toBe('failed');
    await rollback.rollback(rolled.migrationId);
    const rolledStatus = await rollback.getStatus(rolled.migrationId);
    expect(rolledStatus.phase).toBe('rolled-back');
    expect(rolledStatus.entriesCopied).toBe(0);
    expect(rolledStatus.bytesCopied).toBe(0);
    expect(rollback.areWritesSuspended(rolled.migrationId)).toBe(false);

    // Held inside its first scan, so the cancel arrives while the copy is in
    // flight — a cancel after completion is a no-op, and asserting on one would
    // prove nothing about cancellation.
    const cancelSource = seeded(6);
    let release: () => void = () => undefined;
    cancelSource.pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const cancelled = new OnlineShardMigration(cancelSource, new MemoryShardSink());
    const run = await cancelled.startMigration(config({ batchSize: 1, pauseWritesOnCutover: true }));
    const cancelling = cancelled.cancel(run.migrationId);
    release();
    await cancelling;
    const cancelledStatus = await cancelled.getStatus(run.migrationId);
    expect(cancelledStatus.phase).toBe('failed');
    expect(cancelledStatus.error).toBe('cancelled by user');
    expect(cancelled.areWritesSuspended(run.migrationId)).toBe(false);
  });

  it('OM.13: mid-flight progress is the count copied over the count held', async () => {
    const source = seeded(6);
    let release: () => void = () => undefined;
    let held = false;
    source.onScan = async () => {
      // Hold the copy after the first page has been applied, so `getStatus`
      // describes a migration that is in the middle of one rather than one that
      // has finished. `onScan` runs after a page is built and before it is
      // applied, so the second call is the one that follows the first apply.
      if (held || source.scanCalls < 2) return;
      held = true;
      await new Promise<void>((resolveHold) => {
        release = resolveHold;
      });
    };

    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));

    const mid = await migration.getStatus(migrationId);
    expect(mid.phase).toBe('initial-sync');
    expect(mid.entriesCopied).toBe(2);
    expect(mid.entriesTotal).toBe(6);
    expect(mid.progress).toBe(33);
    expect(mid.remainingBytes).toBeGreaterThan(0);

    release();
    const done = await migration.waitForCompletion(migrationId);
    expect(done.progress).toBe(100);
    expect(done.remainingBytes).toBe(0);
  });

  it('OM.14: a source that throws something other than an Error is still reported', async () => {
    const source = seeded(3);
    source.scanEntries = async () => {
      // Deliberately not an Error: a source can reject with anything, and the
      // coordinator must still name what it caught.
      throw 'shard refused'; // eslint-disable-line no-throw-literal
    };
    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config());

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('failed');
    expect(status.error).toBe('shard refused');
  });

  it('OM.15: a shard emptied after the start visits the copy’s empty-page exit', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 4; i += 1) store.put(`key-${i}`, `v-${i}`);
    const source = new MemoryShardSource(store);
    let emptied = false;
    source.onScan = () => {
      if (emptied) return;
      emptied = true;
      for (let i = 0; i < 4; i += 1) store.delete(`key-${i}`);
    };

    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));
    const status = await migration.waitForCompletion(migrationId);

    // The snapshot the migration owes is empty by the time it looks, so there is
    // nothing to copy and nothing to reconcile.
    expect(status.error).toBeUndefined();
    expect(status.phase).toBe('completed');
    expect(status.entriesCopied).toBe(0);
    expect(status.entriesTotal).toBe(0);
  });

  it('OM.16: a cutover requested during the initial pass stops the copy, not the check', async () => {
    const source = seeded(6);
    let release: () => void = () => undefined;
    let held = false;
    source.onScan = async () => {
      if (held) return;
      held = true;
      await new Promise<void>((resolveHold) => {
        release = resolveHold;
      });
    };
    const sink = new MemoryShardSink();
    const migration = new OnlineShardMigration(source, sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));

    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
    const cutting = migration.cutover(migrationId);
    release();
    await cutting;

    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBe('completed');
    // Every entry still arrives: the cutover skips the rest of the phased copy and
    // the final pass takes what is left, so a manual cutover is faster, not lossy.
    expect(sink.storeFor('node-b').size).toBe(6);
  });

  it('OM.17: a cancel that arrives inside the conservation check does not undo a completed migration', async () => {
    const sink = new MemoryShardSink();
    let release: () => void = () => undefined;
    sink.statsGate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const migration = new OnlineShardMigration(seeded(4), sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));

    // The run is now past every cancellation checkpoint and inside the check.
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
    const cancelling = migration.cancel(migrationId);
    release();
    await cancelling;

    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBe('completed');
    expect(status.entriesCopied).toBe(4);
  });

  it('OM.12: the status carries the watermark the coordinator reached', async () => {
    const migration = new OnlineShardMigration(seeded(5), new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config({ batchSize: 2 }));
    const status = await migration.waitForCompletion(migrationId);

    // Five writes, versions 1..5; the coordinator consumed all of them.
    expect(status.caughtUpVersion).toBe(5);
  });
});

describe('OnlineShardMigration — C-04 listener failure reporting', () => {
  it('a throwing progress listener is reported and does not abort the migration', async () => {
    const reported: unknown[] = [];
    const migration = new OnlineShardMigration(seeded(5), new MemoryShardSink(), (failure) => reported.push(failure));
    migration.onProgress(() => {
      throw new Error('listener-boom');
    });

    const { migrationId } = await migration.startMigration(config());
    const status = await migration.waitForCompletion(migrationId);

    // The listener's exception never changed the migration's own outcome.
    expect(status.phase).toBe('completed');
    // But it was reported, with the component named.
    expect(reported.length).toBeGreaterThan(0);
    expect((reported[0] as { source: string }).source).toBe('OnlineShardMigration.listener');
  });

  it('a broken reporter cannot abort the migration', async () => {
    const migration = new OnlineShardMigration(seeded(3), new MemoryShardSink(), () => {
      throw new Error('reporter-boom');
    });
    migration.onProgress(() => {
      throw new Error('listener-boom');
    });

    const { migrationId } = await migration.startMigration(config());
    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('completed');
  });
});
