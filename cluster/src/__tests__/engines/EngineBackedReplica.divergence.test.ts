/**
 * EngineBackedReplica — what it does when a snapshot install fails.
 *
 * Why this file exists
 * --------------------
 * A failed install is not a missed heartbeat. Raft discards the log up to the
 * snapshot boundary *before* calling `installSnapshot`, so the entries the
 * snapshot was meant to carry are gone from the log and absent from the engine.
 * If the replica then keeps applying the entries above the boundary, its applied
 * index converges on the cluster's while its state has a hole in it — and it
 * answers reads from that hole.
 *
 * That is exactly what a real cluster did: `stateSize=31` next to `applied=52`,
 * with the follower logging `Snapshot is truncated: 0 bytes …` once a second.
 * The divergence was silent; the case that the cluster reported as caught up was
 * the case that was wrong.
 *
 * The replica now refuses to apply after a failed restore until a restore
 * succeeds, which is what turns silent divergence into a named error at the node
 * that has the problem.
 *
 * Acceptance criteria:
 *   AC 36.1  a healthy replica reports no restore failure
 *   AC 36.2  a rejected envelope is recorded and rethrown
 *   AC 36.3  after a failed install, apply() refuses and names the cause
 *   AC 36.4  the refusal is chained to the original error
 *   AC 36.5  a successful install clears the refusal and applies resume
 *   AC 36.6  an engine that throws during restore is treated the same way
 *   AC 36.7  a snapshot taken while refused still describes the state it has
 */

import { describe, it, expect } from 'vitest';
import { EngineBackedReplica, encodeSnapshotEnvelope } from '../../engines/EngineBackedReplica';
import { MemoryStorageEngine } from '../../engines/MemoryStorageEngine';
import { SqlVecErrorCode } from '../../interfaces/types';
import type { IStorageEngine } from '../../interfaces/IStorageEngine';

const put = (key: string, value: string) => Buffer.from(JSON.stringify({ op: 'put', key, value }), 'utf8');

/** A valid, positioned envelope for the reference engine's payload format. */
function envelopeFor(shardId: number, index: number, entries: Record<string, string>): Buffer {
  return encodeSnapshotEnvelope({
    shardId,
    index,
    term: 1,
    // The reference engine's own snapshot format: sorted `[key, value]` pairs.
    payload: Buffer.from(JSON.stringify({ entries: Object.entries(entries) }), 'utf8'),
  });
}

describe('EngineBackedReplica — a failed install is not a transient miss', () => {
  it('AC 36.1: a healthy replica reports no restore failure', () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });

    expect(replica.restoreFailure).toBeNull();
  });

  it('AC 36.2: a rejected envelope is recorded and rethrown', async () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });

    // Zero bytes is what the cluster actually received: `Buffer.concat` of a
    // chunk list that raft-core had silently emptied.
    await expect(replica.restore(Buffer.alloc(0))).rejects.toThrow(/truncated/i);
    expect(replica.restoreFailure).toBeInstanceOf(Error);
    expect(String(replica.restoreFailure)).toMatch(/truncated/i);
  });

  it('AC 36.3 + AC 36.4: after a failed install, apply() refuses and names the cause', async () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: put('a', '1') });
    await replica.restore(Buffer.alloc(0)).catch(() => undefined);

    const error = await replica.apply({ index: 9, term: 1, command: 'kv', data: put('b', '2') }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The message has to carry the reason, or the operator is back to guessing.
    expect(message).toContain('Refusing to apply index 9');
    expect(message).toMatch(/snapshot install failed/i);
    expect(message).toMatch(/truncated/i);
    expect((error as { code?: string }).code).toBe(SqlVecErrorCode.INTERNAL_ERROR);
    // And the original error is still reachable for a cause-chain reader.
    expect((error as { cause?: unknown }).cause).toBe(replica.restoreFailure);
    // The state was left alone: index 2 never reached the engine.
    expect(replica.lastAppliedIndex()).toBe(1);
  });

  it('AC 36.5: a successful install clears the refusal and applies resume', async () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: put('a', '1') });
    await replica.restore(Buffer.alloc(0)).catch(() => undefined);
    expect(replica.restoreFailure).not.toBeNull();

    await replica.restore(envelopeFor(1, 40, { a: '1', b: '2' }));
    expect(replica.restoreFailure).toBeNull();
    expect(replica.lastAppliedIndex()).toBe(40);

    await replica.apply({ index: 41, term: 1, command: 'kv', data: put('c', '3') });
    expect(replica.lastAppliedIndex()).toBe(41);
    const body = JSON.parse((await replica.snapshot()).subarray(30).toString('utf8')) as {
      entries: [string, string][];
    };
    expect(Object.fromEntries(body.entries)).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('AC 36.6: an engine that throws during restore is refused the same way', async () => {
    // The engine rejects the payload even though the envelope is well formed —
    // a durable engine out of space does exactly this.
    const engine: IStorageEngine = {
      name: 'failing-engine',
      apply: async () => undefined,
      query: async () => Buffer.alloc(0),
      snapshot: async () => Buffer.alloc(0),
      restore: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      sizeInBytes: async () => 0,
      close: async () => undefined,
    };
    const replica = new EngineBackedReplica({ shardId: 1, engine });

    await expect(replica.restore(envelopeFor(1, 5, { a: '1' }))).rejects.toThrow(/ENOSPC/);
    expect(replica.restoreFailure).toBeInstanceOf(Error);

    const error = await replica.apply({ index: 6, term: 1, command: 'kv', data: put('b', '2') }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect((error as Error).message).toMatch(/ENOSPC/);
  });

  it('AC 36.7: a snapshot taken while refused still describes the state it has', async () => {
    // The replica must not pretend: a snapshot of a divergent replica contains
    // what the engine holds, at the index the engine reached, so a later restore
    // from it cannot be mistaken for the cluster's state.
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: put('a', '1') });
    await replica.restore(Buffer.alloc(0)).catch(() => undefined);

    const framed = await replica.snapshot();
    expect(framed.length).toBeGreaterThan(30);
    expect(replica.lastAppliedIndex()).toBe(1);
  });
});
