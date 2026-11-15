/**
 * Engine conformance — two structurally unrelated engines, one contract.
 *
 * `MemoryStorageEngine` is the shipped reference implementation; `SqliteKeyValueEngine`
 * is a durable, SQL-backed engine with a different command encoding. Both run the
 * published suite from `@agentix-e/db-cluster/testing` unchanged. If a future change
 * weakens the engine SPI, this file fails for both engines at once, which is the
 * whole point of publishing the suite rather than testing the contract per engine.
 */

import { describe, it, expect } from 'vitest';
import { runEngineConformance } from '../../testing/engine-conformance';
import { MemoryStorageEngine } from '../../engines/MemoryStorageEngine';
import { SqliteKeyValueEngine, sqliteCodec } from '../fixtures/SqliteKeyValueEngine';
import { EngineBackedReplica } from '../../engines/EngineBackedReplica';
import { decodeSnapshotEnvelope, SNAPSHOT_ENVELOPE_VERSION } from '../../engines/EngineBackedReplica';
import { SqlVecErrorCode } from '../../interfaces/types';

/** Codec for the reference engine's JSON wire format. */
const memoryCodec = {
  put: (key: string, value: string) => Buffer.from(JSON.stringify({ op: 'put', key, value }), 'utf8'),
  del: (key: string) => Buffer.from(JSON.stringify({ op: 'del', key }), 'utf8'),
  get: (key: string) => Buffer.from(JSON.stringify({ op: 'get', key }), 'utf8'),
  keys: () => Buffer.from(JSON.stringify({ op: 'keys' }), 'utf8'),
  decodeGet: (response: Buffer): string | null =>
    (JSON.parse(response.toString('utf8')) as { value: string | null }).value,
  decodeKeys: (response: Buffer): string[] => (JSON.parse(response.toString('utf8')) as { keys: string[] }).keys,
};

runEngineConformance({
  label: 'MemoryStorageEngine (reference)',
  framework: { describe, it },
  create: () => new MemoryStorageEngine(),
  codec: memoryCodec,
});

runEngineConformance({
  label: 'SqliteKeyValueEngine (durable, SQL)',
  framework: { describe, it },
  create: () => new SqliteKeyValueEngine(),
  codec: sqliteCodec,
});

describe('engine SPI — adapter behaviour that is engine independent', () => {
  it('frames the snapshot with shard, index and term', async () => {
    const replica = new EngineBackedReplica({ shardId: 7, engine: new MemoryStorageEngine() });
    await replica.apply({ index: 1, term: 3, command: 'kv', data: memoryCodec.put('a', '1') });
    await replica.apply({ index: 2, term: 3, command: 'kv', data: memoryCodec.put('b', '2') });

    const envelope = decodeSnapshotEnvelope(await replica.snapshot(), 7);
    expect(envelope.shardId).toBe(7);
    expect(envelope.index).toBe(2);
    expect(envelope.term).toBe(3);
  });

  it('refuses a non-integer index rather than framing an unusable snapshot', async () => {
    const engine = new MemoryStorageEngine();
    const replica = new EngineBackedReplica({ shardId: 1, engine });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') });
    // Force an index the envelope cannot represent; this is a programmer error in
    // whatever produced the entry, so it must not silently truncate.
    (replica as unknown as { _appliedIndex: number })._appliedIndex = Number.MAX_SAFE_INTEGER + 2;
    await expect(replica.snapshot()).rejects.toThrow(/safe non-negative integer/);
  });

  it('rejects a negative index on apply', async () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });
    await expect(replica.apply({ index: -1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') })).rejects.toThrow(
      /safe non-negative integer/,
    );
  });

  it('adopts a recovery starting index above 1 instead of reporting a gap', async () => {
    // A replica whose engine was restored out of band reports the index it is at;
    // the first entry it sees afterwards is that index plus one, never 1.
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine(), initialIndex: 40 });
    await replica.apply({ index: 41, term: 2, command: 'kv', data: memoryCodec.put('a', '1') });
    expect(await replica.getAppliedIndex()).toBe(41);
  });

  it('exposes the shard id and the engine query path', async () => {
    const replica = new EngineBackedReplica({ shardId: 3, engine: new MemoryStorageEngine() });
    expect(replica.shardId()).toBe(3);
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') });
    expect(JSON.parse((await replica.query(memoryCodec.get('a'))).toString('utf8'))).toEqual({ value: '1' });
  });

  it('accepts a string payload as well as a buffer', async () => {
    const replica = new EngineBackedReplica({ shardId: 1, engine: new MemoryStorageEngine() });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', 'str').toString('utf8') });
    expect(await replica.getAppliedIndex()).toBe(1);
  });

  it('surfaces an engine rejection and keeps the replica usable', async () => {
    const engine = new MemoryStorageEngine();
    const replica = new EngineBackedReplica({ shardId: 1, engine });
    // A malformed payload is a caller bug; the index must not advance, and the
    // retry of the same index must still be accepted.
    await expect(
      replica.apply({ index: 1, term: 1, command: 'kv', data: Buffer.from('not json', 'utf8') }),
    ).rejects.toThrow(/not valid JSON/);
    expect(await replica.getAppliedIndex()).toBe(0);
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') });
    expect(await replica.getAppliedIndex()).toBe(1);
  });

  it('carries the entry type and message id into the apply context', async () => {
    // PITR writes stamp an operation and a message id on the entry; the engine
    // needs both to build its own recovery journal, so the adapter must not drop
    // them — and must not invent them when the writer did not set them.
    const engine = new MemoryStorageEngine();
    const replica = new EngineBackedReplica({ shardId: 2, engine });
    await replica.apply({
      index: 1,
      term: 4,
      command: 'kv',
      type: 'put',
      msgId: 'pitr-1',
      data: memoryCodec.put('a', '1'),
    });
    await replica.apply({ index: 2, term: 4, command: 'kv', data: memoryCodec.put('b', '2') });

    expect(engine.appliedContexts[0]).toMatchObject({
      shardId: 2,
      index: 1,
      applyTerm: 4,
      operation: 'put',
      msgId: 'pitr-1',
    });
    expect(engine.appliedContexts[1]).not.toHaveProperty('operation');
    expect(engine.appliedContexts[1]).not.toHaveProperty('msgId');
  });

  it('rejects a snapshot from a newer envelope version instead of reinterpreting its bytes', async () => {
    const engine = new MemoryStorageEngine();
    const replica = new EngineBackedReplica({ shardId: 1, engine });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') });

    const bytes = Buffer.from(await replica.snapshot());
    bytes.writeUInt16BE(SNAPSHOT_ENVELOPE_VERSION + 1, 4);

    await expect(replica.restore(bytes)).rejects.toMatchObject({ code: SqlVecErrorCode.FAILED_PRECONDITION });
    await expect(replica.restore(bytes)).rejects.toThrow(
      `Unsupported snapshot envelope version ${SNAPSHOT_ENVELOPE_VERSION + 1}`,
    );
    expect(JSON.parse((await replica.query(memoryCodec.get('a'))).toString('utf8'))).toEqual({ value: '1' });
  });

  it('rejects a raw engine snapshot that was never framed', async () => {
    // `engine.snapshot()` is the engine's own format: valid for restore(), but it
    // carries no shard, index or term. Handing it to the replica must be a clear
    // rejection rather than a restore that silently loses the position.
    const engine = new MemoryStorageEngine();
    const replica = new EngineBackedReplica({ shardId: 1, engine });
    await replica.apply({ index: 1, term: 1, command: 'kv', data: memoryCodec.put('a', '1') });
    await replica.apply({ index: 2, term: 1, command: 'kv', data: memoryCodec.put('b', '2') });
    await replica.apply({ index: 3, term: 1, command: 'kv', data: memoryCodec.put('c', '3') });

    await expect(replica.restore(await engine.snapshot())).rejects.toMatchObject({
      code: SqlVecErrorCode.INVALID_ARGUMENT,
    });
    await expect(replica.restore(await engine.snapshot())).rejects.toThrow(/bad magic/);
    expect(await replica.getAppliedIndex()).toBe(3);
    expect(JSON.parse((await replica.query(memoryCodec.get('c'))).toString('utf8'))).toEqual({ value: '3' });
  });
});
