/**
 * OnlineShardMigration — the branches the lifecycle cases do not reach.
 *
 * `i82-online-migration.test.ts` covers the protocol and what it measures. What
 * is left is the refusal side: a registry that knows no such migration, a source
 * that throws, a registry that is cleared, and the two terminal states that make
 * a control command a no-op. None of them needs a timing loop, because the
 * coordinator's failures are values rather than silences.
 */

import { describe, it, expect } from 'vitest';
import { OnlineShardMigration } from '../../shard/OnlineShardMigration';
import type { IMigrationConfig } from '../../interfaces/shard/IOnlineShardMigration';
import { MemoryShardSink, MemoryShardSource, MemoryStore } from '../shard/migration-memory';

function config(overrides: Partial<IMigrationConfig> = {}): IMigrationConfig {
  return {
    shardId: 4,
    sourceNode: 'node-a',
    targetNode: 'node-b',
    batchSize: 2,
    finalSyncTimeoutMs: 100,
    pauseWritesOnCutover: false,
    ...overrides,
  };
}

function seeded(count = 4): MemoryShardSource {
  const store = new MemoryStore();
  for (let i = 0; i < count; i += 1) store.put(`key-${i}`, `value-${i}`);
  return new MemoryShardSource(store);
}

describe('OnlineShardMigration — refusals and terminal states', () => {
  it('every command refuses an unknown migration by name', async () => {
    const migration = new OnlineShardMigration(seeded(), new MemoryShardSink());
    await expect(migration.getStatus('ghost')).rejects.toThrow('migration ghost not found');
    await expect(migration.cutover('ghost')).rejects.toThrow('migration ghost not found');
    await expect(migration.rollback('ghost')).rejects.toThrow('migration ghost not found');
    await expect(migration.cancel('ghost')).rejects.toThrow('migration ghost not found');
    await expect(migration.waitForCompletion('ghost')).rejects.toThrow('migration ghost not found');
  });

  it('refuses a negative final-sync budget before the source is asked anything', async () => {
    let asked = 0;
    const source = seeded();
    const counting = new Proxy(source, {
      get(target, property, receiver) {
        if (property === 'stats') asked += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const migration = new OnlineShardMigration(counting, new MemoryShardSink());
    await expect(migration.startMigration(config({ finalSyncTimeoutMs: -1 }))).rejects.toThrow(
      'finalSyncTimeoutMs must not be negative',
    );
    expect(asked).toBe(0);
  });

  it('a source that throws marks the migration failed with the source’s own message', async () => {
    const source = seeded();
    source.scanEntries = async () => {
      throw new Error('shard is offline');
    };
    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    const { migrationId } = await migration.startMigration(config());

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('failed');
    expect(status.error).toBe('shard is offline');
    expect(migration.getActiveMigrationCount()).toBe(0);
  });

  it('a failure releases the suspended writes it had taken', async () => {
    const sink = new MemoryShardSink();
    sink.dropKeys.add('key-0');
    const migration = new OnlineShardMigration(seeded(), sink);
    const { migrationId } = await migration.startMigration(config({ batchSize: 1, pauseWritesOnCutover: true }));

    const status = await migration.waitForCompletion(migrationId);
    expect(status.phase).toBe('failed');
    // A migration that failed inside the cutover window must not leave the shard
    // refusing writes: the suspension is a lock, and a lock outliving its holder
    // is an outage.
    expect(migration.areWritesSuspended(migrationId)).toBe(false);
  });

  it('cutover after completion is a no-op, and after rollback is refused', async () => {
    const migration = new OnlineShardMigration(seeded(), new MemoryShardSink());
    const done = await migration.startMigration(config());
    await migration.waitForCompletion(done.migrationId);
    await expect(migration.cutover(done.migrationId)).resolves.toBeUndefined();

    const rolled = await migration.startMigration(config({ shardId: 5 }));
    await migration.rollback(rolled.migrationId);
    await expect(migration.cutover(rolled.migrationId)).rejects.toThrow(
      'cannot cutover migration in phase rolled-back',
    );
  });

  it('cancel is a no-op on a terminal migration', async () => {
    const migration = new OnlineShardMigration(seeded(), new MemoryShardSink());
    const done = await migration.startMigration(config());
    await migration.waitForCompletion(done.migrationId);

    await expect(migration.cancel(done.migrationId)).resolves.toBeUndefined();
    // A completed migration is not turned into a cancelled one by a late command.
    expect((await migration.getStatus(done.migrationId)).phase).toBe('completed');
  });

  it('reset clears the registry and the suspended-write set', async () => {
    const source = seeded();
    const migration = new OnlineShardMigration(source, new MemoryShardSink());
    let release: () => void = () => undefined;
    source.pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const { migrationId } = await migration.startMigration(config({ pauseWritesOnCutover: true }));
    expect(migration.listMigrations()).toEqual([migrationId]);

    migration.reset();
    expect(migration.listMigrations()).toEqual([]);
    expect(migration.getActiveMigrationCount()).toBe(0);
    expect(migration.areWritesSuspended(migrationId)).toBe(false);

    // The held scan returns after the registry is gone; the run must not
    // resurrect a migration the caller cleared.
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(migration.listMigrations()).toEqual([]);
  });

  it('two migrations over the same source keep their own counters', async () => {
    const sink = new MemoryShardSink();
    const migration = new OnlineShardMigration(seeded(6), sink);
    const first = await migration.startMigration(config({ shardId: 4, batchSize: 2 }));
    const second = await migration.startMigration(config({ shardId: 5, batchSize: 3, targetNode: 'node-c' }));

    const [one, two] = await Promise.all([
      migration.waitForCompletion(first.migrationId),
      migration.waitForCompletion(second.migrationId),
    ]);
    expect(one.entriesCopied).toBe(6);
    expect(two.entriesCopied).toBe(6);
    expect(one.phase).toBe('completed');
    expect(two.phase).toBe('completed');
    expect(sink.storeFor('node-b').size).toBe(6);
    expect(sink.storeFor('node-c').size).toBe(6);
  });
});
