/**
 * MemoryStorageEngine — its own JSON wire format.
 *
 * The conformance suite proves that the engine satisfies the SPI through both
 * engines. This file pins the encoding of the reference engine itself, because
 * that encoding is what an adapter author copies: which payloads it accepts,
 * what each query answers, and which malformed payloads it refuses without
 * touching live state.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStorageEngine } from '../../engines/MemoryStorageEngine';
import type { EngineApplyContext } from '../../interfaces/IStorageEngine';

function payload(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function raw(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function context(index: number): EngineApplyContext {
  return { shardId: 1, index, applyTerm: 1 };
}

describe('MemoryStorageEngine — command decoding', () => {
  it('applies a nop without changing state but still records the position', async () => {
    // A replicated entry that belongs to another subsystem has to consume its
    // index, otherwise the next real command looks like a gap in the log.
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'nop' }));

    expect(await engine.sizeInBytes()).toBe(0);
    expect(JSON.parse((await engine.query(payload({ op: 'keys' }))).toString('utf8'))).toEqual({ keys: [] });
    expect(engine.appliedContexts).toHaveLength(1);
    expect(engine.appliedContexts[0]).toMatchObject({ shardId: 1, index: 1, applyTerm: 1 });
  });

  it('refuses a query payload on the apply path and records no position', async () => {
    const engine = new MemoryStorageEngine();
    await expect(engine.apply(context(1), payload({ op: 'get', key: 'a' }))).rejects.toThrow(/"get" is not a command/);
    expect(engine.appliedContexts).toEqual([]);
  });

  it('rejects a payload that is not a JSON object', async () => {
    const engine = new MemoryStorageEngine();
    for (const body of ['null', '"put"', '42']) {
      await expect(engine.apply(context(1), raw(body))).rejects.toThrow(/payload must be a JSON object/);
    }
  });

  it('rejects a payload without a string op', async () => {
    const engine = new MemoryStorageEngine();
    for (const body of ['[]', '{}', '{"op":42}']) {
      await expect(engine.apply(context(1), raw(body))).rejects.toThrow(/payload is missing "op"/);
    }
  });

  it('rejects a put whose key or value is not a string', async () => {
    const engine = new MemoryStorageEngine();
    for (const body of [
      '{"op":"put","key":"a"}',
      '{"op":"put","key":1,"value":"v"}',
      '{"op":"put","key":"a","value":2}',
    ]) {
      await expect(engine.apply(context(1), raw(body))).rejects.toThrow(/"put" requires string key and value/);
    }
    expect(await engine.sizeInBytes()).toBe(0);
  });

  it('rejects a del or get without a string key', async () => {
    const engine = new MemoryStorageEngine();
    await expect(engine.apply(context(1), raw('{"op":"del"}'))).rejects.toThrow(/"del" requires a string key/);
    await expect(engine.query(raw('{"op":"get","key":null}'))).rejects.toThrow(/"get" requires a string key/);
  });

  it('rejects an unknown op', async () => {
    const engine = new MemoryStorageEngine();
    await expect(engine.apply(context(1), raw('{"op":"scan"}'))).rejects.toThrow(/unknown op "scan"/);
  });
});

describe('MemoryStorageEngine — query decoding', () => {
  it('answers the size query with the same figure as sizeInBytes', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'ab', value: 'cde' }));
    await engine.apply(context(2), payload({ op: 'put', key: 'x', value: '' }));

    // 2 + 3 + 1 + 0 bytes of live key and value data.
    expect(JSON.parse((await engine.query(payload({ op: 'size' }))).toString('utf8'))).toEqual({ size: 6 });
    expect(await engine.sizeInBytes()).toBe(6);
  });

  it('drops a deleted key from the size query', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'key', value: 'value' }));
    await engine.apply(context(2), payload({ op: 'del', key: 'key' }));
    expect(JSON.parse((await engine.query(payload({ op: 'size' }))).toString('utf8'))).toEqual({ size: 0 });
  });

  it('refuses a command payload on the query path', async () => {
    const engine = new MemoryStorageEngine();
    await expect(engine.query(payload({ op: 'put', key: 'a', value: '1' }))).rejects.toThrow(/"put" is not a query/);
  });
});

describe('MemoryStorageEngine — snapshot encoding', () => {
  it('sorts entries so the same state frames identically regardless of insertion order', async () => {
    const ascending = new MemoryStorageEngine();
    await ascending.apply(context(1), payload({ op: 'put', key: 'a', value: '1' }));
    await ascending.apply(context(2), payload({ op: 'put', key: 'c', value: '3' }));

    const descending = new MemoryStorageEngine();
    await descending.apply(context(1), payload({ op: 'put', key: 'c', value: '3' }));
    await descending.apply(context(2), payload({ op: 'put', key: 'a', value: '1' }));

    const snapshot = await descending.snapshot();
    expect(snapshot.equals(await ascending.snapshot())).toBe(true);
    expect(JSON.parse(snapshot.toString('utf8'))).toEqual({
      entries: [
        ['a', '1'],
        ['c', '3'],
      ],
    });
  });

  it('rejects a snapshot that is not JSON and keeps the live state', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'a', value: '1' }));

    await expect(engine.restore(raw('not json'))).rejects.toThrow(/snapshot is not valid JSON/);
    expect(JSON.parse((await engine.query(payload({ op: 'get', key: 'a' }))).toString('utf8'))).toEqual({
      value: '1',
    });
  });

  it('rejects a snapshot without an entries array and keeps the live state', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'a', value: '1' }));

    for (const body of ['null', '[]', '{}', '{"entries":"nope"}']) {
      await expect(engine.restore(raw(body))).rejects.toThrow(/snapshot is missing "entries"/);
    }
    expect(JSON.parse((await engine.query(payload({ op: 'get', key: 'a' }))).toString('utf8'))).toEqual({
      value: '1',
    });
  });

  it('rejects a malformed entry rather than half-restoring the snapshot', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'kept', value: '1' }));

    const malformed = ['{"entries":["ab"]}', '{"entries":[["a"]]}', '{"entries":[[1,"b"]]}', '{"entries":[["a",2]]}'];
    for (const body of malformed) {
      await expect(engine.restore(raw(body))).rejects.toThrow(/entry must be \[string, string\]/);
    }

    // The replacement is built before the swap, so none of the rejected
    // snapshots may have erased or extended the live state.
    expect(JSON.parse((await engine.query(payload({ op: 'keys' }))).toString('utf8'))).toEqual({ keys: ['kept'] });
  });
});

describe('MemoryStorageEngine — lifecycle', () => {
  it('close releases the data and the recorded apply contexts, and the engine stays usable', async () => {
    const engine = new MemoryStorageEngine();
    await engine.apply(context(1), payload({ op: 'put', key: 'a', value: '1' }));
    expect(await engine.sizeInBytes()).toBe(2);

    await engine.close();
    expect(await engine.sizeInBytes()).toBe(0);
    expect(engine.appliedContexts).toEqual([]);

    await engine.apply(context(1), payload({ op: 'put', key: 'b', value: '2' }));
    expect(JSON.parse((await engine.query(payload({ op: 'keys' }))).toString('utf8'))).toEqual({ keys: ['b'] });
  });
});
