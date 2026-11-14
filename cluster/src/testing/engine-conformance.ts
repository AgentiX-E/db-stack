/**
 * Engine conformance suite — the executable definition of {@link IStorageEngine}.
 *
 * An engine that passes this suite can be replicated by db-cluster. The suite is
 * shipped (not test-only) on purpose: an engine author should be able to prove
 * compliance against the published contract instead of reverse-engineering it from
 * the middleware's behaviour, and a middleware maintainer should be able to prove
 * that a change did not weaken the contract for every engine at once.
 *
 * The suite is framework-neutral. It needs only `describe`/`it`; assertions are
 * plain `node:assert`, so it runs unchanged under vitest, jest, mocha or
 * `node:test`.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { runEngineConformance } from '@agentix-e/db-cluster/testing';
 * import { MyEngine } from './my-engine';
 *
 * runEngineConformance({
 *   label: 'my-engine',
 *   framework: { describe, it },
 *   create: () => new MyEngine(),
 *   codec: { ... },
 * });
 * ```
 *
 * @module testing/engine-conformance
 */

import assert from 'node:assert/strict';
import type { EngineApplyContext, IStorageEngine } from '../interfaces/IStorageEngine';
import { EngineBackedReplica } from '../engines/EngineBackedReplica';

/** The minimum test-framework surface the suite needs. */
export interface ConformanceFramework {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}

/**
 * Translates the suite's standard key/value workload into the engine's own
 * encoding. Every method is pure: it produces request bytes, it does not run them.
 */
export interface KeyValueConformanceCodec {
  /** Command payload that sets `key` to `value`. */
  put(key: string, value: string): Buffer;
  /** Command payload that removes `key`. */
  del(key: string): Buffer;
  /** Query request that reads `key`. */
  get(key: string): Buffer;
  /** Query request that lists every key. */
  keys(): Buffer;
  /** Decode a `get` response. `null` means "absent", which is distinct from `""`. */
  decodeGet(response: Buffer): string | null;
  /** Decode a `keys` response. */
  decodeKeys(response: Buffer): string[];
}

export interface EngineConformanceOptions {
  /** Engine label used in the suite titles and failure messages. */
  label: string;
  /** Factory producing a fresh, empty engine for each check. */
  create(): IStorageEngine | Promise<IStorageEngine>;
  /** Workload encoder for the engine under test. */
  codec: KeyValueConformanceCodec;
  /** Test framework primitives (`{ describe, it }` from any of them). */
  framework: ConformanceFramework;
}

/** Payload the suite injects to make an apply fail without engine cooperation. */
const FAILURE_SENTINEL = Buffer.from('__db-cluster-conformance-failure__', 'utf8');

/**
 * Records every apply context and can fail on demand, without the engine under
 * test knowing anything about it.
 */
class InstrumentedEngine implements IStorageEngine {
  readonly contexts: EngineApplyContext[] = [];

  constructor(private readonly inner: IStorageEngine) {}

  get name(): string {
    return this.inner.name;
  }

  async apply(context: EngineApplyContext, payload: Buffer): Promise<void> {
    if (payload.equals(FAILURE_SENTINEL)) {
      throw new Error('injected apply failure');
    }
    this.contexts.push(context);
    return this.inner.apply(context, payload);
  }

  query(request: Buffer): Promise<Buffer> {
    return this.inner.query(request);
  }

  snapshot(): Promise<Buffer> {
    return this.inner.snapshot();
  }

  restore(snapshot: Buffer): Promise<void> {
    return this.inner.restore(snapshot);
  }

  sizeInBytes(): Promise<number> {
    return this.inner.sizeInBytes();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Register the conformance suite.
 *
 * @param options Engine factory, workload codec and the test framework to register with.
 */
export function runEngineConformance(options: EngineConformanceOptions): void {
  const { label, create, codec, framework } = options;
  const { describe, it } = framework;

  interface Fixture {
    engine: InstrumentedEngine;
    replica: EngineBackedReplica;
  }

  /** Build a fresh instrumented engine plus replica, run `body`, always close. */
  async function withReplica(body: (fixture: Fixture) => Promise<void>, shardId = 1): Promise<void> {
    const engine = new InstrumentedEngine(await create());
    const replica = new EngineBackedReplica({ shardId, engine });
    try {
      await body({ engine, replica });
    } finally {
      await engine.close();
    }
  }

  /** Apply `payload` at `index` through the replica. */
  function applyAt(replica: EngineBackedReplica, index: number, payload: Buffer): Promise<void> {
    return replica.apply({ index, term: 1, command: 'kv', data: payload });
  }

  describe(`engine conformance: ${label}`, () => {
    it('starts empty: no keys and a zero live size', async () => {
      await withReplica(async ({ engine }) => {
        assert.deepEqual(codec.decodeKeys(await engine.query(codec.keys())), []);
        assert.equal(await engine.sizeInBytes(), 0);
      });
    });

    it('applies a put and reads it back', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('alpha', 'one'));
        assert.equal(codec.decodeGet(await engine.query(codec.get('alpha'))), 'one');
      });
    });

    it('absent keys and empty values stay distinguishable', async () => {
      await withReplica(async ({ engine, replica }) => {
        assert.equal(codec.decodeGet(await engine.query(codec.get('missing'))), null);
        await applyAt(replica, 1, codec.put('empty', ''));
        assert.equal(codec.decodeGet(await engine.query(codec.get('empty'))), '');
      });
    });

    it('overwrites an existing key', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('k', 'v1'));
        await applyAt(replica, 2, codec.put('k', 'v2'));
        assert.equal(codec.decodeGet(await engine.query(codec.get('k'))), 'v2');
      });
    });

    it('deletes a key, and deleting it again is a no-op', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('k', 'v'));
        await applyAt(replica, 2, codec.del('k'));
        assert.equal(codec.decodeGet(await engine.query(codec.get('k'))), null);
        await applyAt(replica, 3, codec.del('k'));
        assert.equal(codec.decodeGet(await engine.query(codec.get('k'))), null);
        assert.deepEqual(codec.decodeKeys(await engine.query(codec.keys())), []);
        assert.equal(await engine.sizeInBytes(), 0);
      });
    });

    it('keeps 200 keys distinct', async () => {
      await withReplica(async ({ engine, replica }) => {
        for (let i = 0; i < 200; i += 1) {
          await applyAt(replica, i + 1, codec.put(`key-${i}`, `value-${i}`));
        }
        assert.equal(codec.decodeKeys(await engine.query(codec.keys())).length, 200);
        assert.equal(codec.decodeGet(await engine.query(codec.get('key-199'))), 'value-199');
        assert.ok((await engine.sizeInBytes()) > 0);
      });
    });

    it('receives contiguous indexes, the shard id and the apply term', async () => {
      await withReplica(async ({ engine, replica }) => {
        for (let i = 1; i <= 5; i += 1) {
          await applyAt(replica, i, codec.put(`key-${i}`, 'v'));
        }
        assert.deepEqual(
          engine.contexts.map((c) => c.index),
          [1, 2, 3, 4, 5],
        );
        for (const context of engine.contexts) assert.equal(context.shardId, 1);
        for (const context of engine.contexts) assert.equal(context.applyTerm, 1);
      });
    });

    it('produces byte-identical snapshots for an unchanged state', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        await applyAt(replica, 2, codec.put('b', '2'));
        const first = await engine.snapshot();
        const second = await engine.snapshot();
        assert.ok(first.equals(second), 'two snapshots of the same state must be identical');
      });
    });

    it('returns a snapshot that does not alias live state', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        const snapshot = await engine.snapshot();
        snapshot.fill(0);
        assert.equal(codec.decodeGet(await engine.query(codec.get('a'))), '1');
      });
    });

    it('restores into a fresh engine and reproduces the state', async () => {
      const snapshot = await (async () => {
        const engine = new InstrumentedEngine(await create());
        const replica = new EngineBackedReplica({ shardId: 1, engine });
        await applyAt(replica, 1, codec.put('a', '1'));
        await applyAt(replica, 2, codec.put('b', '2'));
        await applyAt(replica, 3, codec.del('a'));
        const bytes = await engine.snapshot();
        await engine.close();
        return bytes;
      })();

      const restored = new InstrumentedEngine(await create());
      try {
        await restored.restore(snapshot);
        assert.equal(codec.decodeGet(await restored.query(codec.get('a'))), null, 'a deleted key must not come back');
        assert.equal(codec.decodeGet(await restored.query(codec.get('b'))), '2');
        assert.deepEqual(codec.decodeKeys(await restored.query(codec.keys())), ['b']);
      } finally {
        await restored.close();
      }
    });

    it('restore replaces rather than merges', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('kept', 'v'));
        const snapshot = await engine.snapshot();
        await applyAt(replica, 2, codec.put('extra', 'v'));
        assert.deepEqual(codec.decodeKeys(await engine.query(codec.keys())).sort(), ['extra', 'kept']);
        await engine.restore(snapshot);
        assert.deepEqual(codec.decodeKeys(await engine.query(codec.keys())), ['kept']);
      });
    });

    it('advances the applied index and reports it', async () => {
      await withReplica(async ({ replica }) => {
        assert.equal(await replica.getAppliedIndex(), 0);
        await applyAt(replica, 1, codec.put('a', '1'));
        await applyAt(replica, 2, codec.put('a', '2'));
        assert.equal(await replica.getAppliedIndex(), 2);
        assert.equal(replica.lastAppliedIndex(), 2);
      });
    });

    it('drops a replayed index instead of applying it twice', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('counter', '1'));
        await applyAt(replica, 1, codec.put('counter', '1'));
        assert.equal(engine.contexts.length, 1, 'the duplicate must not reach the engine');
        assert.equal(replica.skippedReplays, 1);
        assert.equal(await replica.getAppliedIndex(), 1);
      });
    });

    it('accepts a forward jump (raft skips non-command entries) and records it', async () => {
      // raft-core applies CONFIG and NOOP entries itself and never calls the
      // application for them, so the index sequence an engine observes is
      // increasing but not consecutive. Refusing a jump — as this adapter did
      // before the rule was written down — kills the apply loop on the first write
      // after a restart, which is exactly what happened in AC-C7.
      await withReplica(async ({ replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        await applyAt(replica, 4, codec.put('a', '4'));
        assert.equal(await replica.getAppliedIndex(), 4);
        assert.equal(replica.forwardJumps, 1, 'the jump must be counted, not swallowed');
      });
    });

    it('leaves the index untouched when an apply fails, and keeps serving', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        await assert.rejects(() => applyAt(replica, 2, FAILURE_SENTINEL), /injected apply failure/);
        assert.equal(await replica.getAppliedIndex(), 1, 'a failed apply must not advance the index');
        await applyAt(replica, 2, codec.put('a', '2'));
        assert.equal(codec.decodeGet(await engine.query(codec.get('a'))), '2');
      });
    });

    it('serializes concurrent applies in submission order', async () => {
      await withReplica(async ({ engine, replica }) => {
        const pending: Array<Promise<void>> = [];
        for (let i = 1; i <= 20; i += 1) pending.push(applyAt(replica, i, codec.put(`k${i}`, String(i))));
        await Promise.all(pending);
        assert.deepEqual(
          engine.contexts.map((c) => c.index),
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        assert.equal(await replica.getAppliedIndex(), 20);
        assert.equal(codec.decodeGet(await engine.query(codec.get('k20'))), '20');
      });
    });

    it('carries the applied position through snapshot and restore', async () => {
      await withReplica(async ({ replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        await applyAt(replica, 2, codec.put('b', '2'));
        const bytes = await replica.snapshot();

        const engine = new InstrumentedEngine(await create());
        const restored = new EngineBackedReplica({ shardId: 1, engine });
        try {
          await restored.restore(bytes);
          assert.equal(await restored.getAppliedIndex(), 2, 'restore must recover the framed index');
          // The replayed index is dropped, and the next one is accepted.
          await applyAt(restored, 2, codec.put('b', '2'));
          assert.equal(restored.skippedReplays, 1);
          await applyAt(restored, 3, codec.put('c', '3'));
          assert.equal(codec.decodeGet(await engine.query(codec.get('c'))), '3');
        } finally {
          await engine.close();
        }
      });
    });

    it('stamps the boundary index raft declares, not the local watermark', async () => {
      // The engine's watermark can sit below the snapshot boundary — the entries in
      // between were CONFIG or NOOP, applied by raft without reaching the
      // application. A snapshot framed below its own boundary makes the first
      // post-restore apply look like a skip and, before this rule was enforced,
      // wedged the apply loop after a restart.
      await withReplica(async ({ replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        const bytes = await replica.snapshot(3);

        const engine = new InstrumentedEngine(await create());
        const restored = new EngineBackedReplica({ shardId: 1, engine });
        try {
          await restored.restore(bytes);
          assert.equal(await restored.getAppliedIndex(), 3, 'the framed index must be the boundary raft passed');
          assert.equal(codec.decodeGet(await engine.query(codec.get('a'))), '1', 'state must still be complete');
          // The next real entry is accepted, not treated as a gap.
          await applyAt(restored, 4, codec.put('b', '2'));
          assert.equal(codec.decodeGet(await engine.query(codec.get('b'))), '2');
        } finally {
          await engine.close();
        }
      });
    });

    it('rejects a corrupt snapshot and keeps the current state', async () => {
      await withReplica(async ({ engine, replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        const bytes = await replica.snapshot();
        const corrupt = Buffer.from(bytes);
        corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
        await assert.rejects(() => replica.restore(corrupt), /corrupt|CRC/i);
        assert.equal(codec.decodeGet(await engine.query(codec.get('a'))), '1');
        assert.equal(await replica.getAppliedIndex(), 1);
      });
    });

    it('rejects a truncated snapshot', async () => {
      await withReplica(async ({ replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        const bytes = await replica.snapshot();
        await assert.rejects(() => replica.restore(bytes.subarray(0, 10)), /truncated/i);
      });
    });

    it('rejects a snapshot from another shard', async () => {
      await withReplica(async ({ replica }) => {
        await applyAt(replica, 1, codec.put('a', '1'));
        const bytes = await replica.snapshot();
        const engine = new InstrumentedEngine(await create());
        const otherShard = new EngineBackedReplica({ shardId: 2, engine });
        try {
          await assert.rejects(() => otherShard.restore(bytes), /shard 1, not 2/i);
        } finally {
          await engine.close();
        }
      });
    });

    it('reports the live size through the replica', async () => {
      await withReplica(async ({ replica }) => {
        assert.equal(await replica.dataSize(), 0);
        await applyAt(replica, 1, codec.put('a', '1'));
        assert.ok((await replica.dataSize()) > 0);
      });
    });

    it('closes idempotently', async () => {
      const engine = await create();
      await engine.close();
      await engine.close();
    });
  });
}
