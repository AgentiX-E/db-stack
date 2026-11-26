/**
 * EdgeReplica — conflict intake through an engine-agnostic resolver callback.
 *
 * A replication stream is identified by LSN. A second frame carrying an LSN
 * already applied is either a transport duplicate (same payload — ignore it)
 * or two writers that claimed the same position with different values (a real
 * conflict). The replica used to push both into `_data`, so a duplicate inflated
 * `receivedCount` and a genuine conflict was never arbitrated.
 *
 * The resolver is a plain callback, so any engine can supply its own policy:
 * the replica knows nothing about HLC or CRDT, only "given the two values at
 * this LSN, which one stands". No resolver configured → the old append behaviour
 * is preserved, so an engine that does not have conflicts pays nothing.
 */

import { describe, it, expect } from 'vitest';
import { EdgeReplica, type EdgeSourceConfig } from './EdgeReplica';

const SOURCE: EdgeSourceConfig = { url: 'ws://edge:9001', protocol: 'websocket' };

async function connected(withResolver = false): Promise<{
  edge: EdgeReplica;
  consulted: Array<{ lsn: number; existing: unknown; incoming: unknown }>;
}> {
  const consulted: Array<{ lsn: number; existing: unknown; incoming: unknown }> = [];
  const edge = new EdgeReplica(
    withResolver
      ? {
          resolveConflict: (lsn, existing, incoming) => {
            consulted.push({ lsn, existing, incoming });
            return incoming;
          },
        }
      : {},
  );
  await edge.connect(SOURCE);
  return { edge, consulted };
}

describe('EdgeReplica — LSN conflict intake', () => {
  it('a transport duplicate is not appended twice', async () => {
    const { edge } = await connected();
    edge.receive(7, { key: 'k', value: 'v' });
    edge.receive(7, { key: 'k', value: 'v' });
    expect(edge.getAllData()).toHaveLength(1);
    expect(edge.getSyncStatus().receivedCount).toBe(1);
    edge.disconnect();
  });

  it('a conflicting LSN is put to the resolver, not silently appended', async () => {
    const { edge, consulted } = await connected(true);
    edge.receive(7, { key: 'k', value: 'from-a' });
    edge.receive(7, { key: 'k', value: 'from-b' });
    expect(consulted).toHaveLength(1);
    expect(consulted[0]).toEqual({
      lsn: 7,
      existing: { key: 'k', value: 'from-a' },
      incoming: { key: 'k', value: 'from-b' },
    });
    edge.disconnect();
  });

  it('the resolver decides which payload survives at that LSN', async () => {
    const { edge } = await connected();
    // First replica keeps the existing value when a resolver says so.
    const keeper = new EdgeReplica({
      resolveConflict: () => ({ key: 'k', value: 'kept' }),
    });
    await keeper.connect(SOURCE);
    keeper.receive(7, { key: 'k', value: 'old' });
    keeper.receive(7, { key: 'k', value: 'new' });
    expect(keeper.getAllData()).toEqual([{ lsn: 7, payload: { key: 'k', value: 'kept' } }]);
    keeper.disconnect();
    edge.disconnect();
  });

  it('without a resolver, a conflicting LSN keeps the first payload (deterministic)', async () => {
    const { edge, consulted } = await connected(false);
    edge.receive(7, { key: 'k', value: 'first' });
    edge.receive(7, { key: 'k', value: 'second' });
    expect(consulted).toHaveLength(0);
    expect(edge.getAllData()).toEqual([{ lsn: 7, payload: { key: 'k', value: 'first' } }]);
    edge.disconnect();
  });

  it('the conflict callback is engine-agnostic: any payload shape passes through', async () => {
    const seen: unknown[] = [];
    const edge = new EdgeReplica({
      resolveConflict: (_lsn, existing, incoming) => {
        seen.push(existing, incoming);
        return incoming;
      },
    });
    await edge.connect(SOURCE);
    edge.receive(1, { rows: [1, 2, 3] });
    edge.receive(1, { rows: [4, 5] });
    expect(seen).toEqual([{ rows: [1, 2, 3] }, { rows: [4, 5] }]);
    edge.disconnect();
  });
});

describe('EdgeReplica — handler failures are observable, not swallowed', () => {
  it('an event handler that throws is reported through onError', async () => {
    const edge = new EdgeReplica();
    const errors: Error[] = [];
    edge.onError((e) => errors.push(e));
    edge.onEvent(() => {
      throw new Error('event-handler-boom');
    });
    await edge.connect(SOURCE);
    edge.receive(1, 'x');
    expect(errors.map((e) => e.message)).toContain('event-handler-boom');
    edge.disconnect();
  });

  it('a sync-complete handler that throws is reported through onError', async () => {
    const edge = new EdgeReplica();
    const errors: Error[] = [];
    edge.onError((e) => errors.push(e));
    edge.onSyncComplete(() => {
      throw new Error('sync-complete-boom');
    });
    await edge.connect(SOURCE);
    edge.receive(1, 'x'); // lag=0 → sync complete fires
    expect(errors.map((e) => e.message)).toContain('sync-complete-boom');
    edge.disconnect();
  });

  it('one handler throwing still lets the other handlers run', async () => {
    const edge = new EdgeReplica();
    const seen: string[] = [];
    edge.onEvent(() => {
      throw new Error('first-boom');
    });
    edge.onEvent(() => seen.push('second'));
    edge.onEvent(() => seen.push('third'));
    await edge.connect(SOURCE);
    edge.receive(1, 'x');
    expect(seen).toEqual(['second', 'third']);
    edge.disconnect();
  });
});

describe('EdgeReplica — engine-agnostic connection callback', () => {
  it('a supplied transport callback drives connect instead of the simulated one', async () => {
    let dialed: EdgeSourceConfig | null = null;
    const edge = new EdgeReplica({
      connectTransport: async (source) => {
        dialed = source;
      },
    });
    await edge.connect(SOURCE);
    expect(dialed).toEqual(SOURCE);
    expect(edge.getSyncStatus().state).toBe('syncing');
    edge.disconnect();
  });

  it('a rejected transport callback is reported through onError', async () => {
    const errors: Error[] = [];
    const edge = new EdgeReplica({
      connectTransport: async () => {
        throw new Error('dial-refused');
      },
    });
    edge.onError((e) => errors.push(e));
    await edge.connect(SOURCE);
    expect(errors.map((e) => e.message)).toContain('dial-refused');
    edge.disconnect();
  });
});

describe('EdgeReplica — payload and failure edges', () => {
  it('a payload replayed by reference is a duplicate without serialization', async () => {
    const edge = new EdgeReplica();
    await edge.connect(SOURCE);
    const same = { key: 'k', value: 'v' };
    edge.receive(1, same);
    edge.receive(1, same); // identical reference → strict-equality fast path
    expect(edge.getAllData()).toHaveLength(1);
    edge.disconnect();
  });

  it('a circular payload is treated as a conflict, not a crash', async () => {
    const consulted: unknown[] = [];
    const edge = new EdgeReplica({
      resolveConflict: (_lsn, existing, incoming) => {
        consulted.push(incoming);
        return existing;
      },
    });
    await edge.connect(SOURCE);
    const circular: Record<string, unknown> = { key: 'k' };
    circular.self = circular; // JSON.stringify throws on this
    edge.receive(1, { key: 'k' });
    edge.receive(1, circular); // not serializable → conflict path, no throw
    expect(consulted).toHaveLength(1);
    expect(edge.getAllData()).toHaveLength(1);
    edge.disconnect();
  });

  it('a handler that throws a non-Error value is reported as an Error', async () => {
    const edge = new EdgeReplica();
    const errors: Error[] = [];
    edge.onError((e) => errors.push(e));
    edge.onEvent(() => {
      throw 'string-failure'; // eslint-disable-line no-throw-literal
    });
    await edge.connect(SOURCE);
    edge.receive(1, 'x');
    expect(errors.some((e) => e instanceof Error && e.message === 'string-failure')).toBe(true);
    edge.disconnect();
  });

  it('a sync-complete handler that throws a non-Error value is reported', async () => {
    const edge = new EdgeReplica();
    const errors: Error[] = [];
    edge.onError((e) => errors.push(e));
    edge.onSyncComplete(() => {
      throw 42; // eslint-disable-line no-throw-literal
    });
    await edge.connect(SOURCE);
    edge.receive(1, 'x');
    expect(errors.some((e) => e instanceof Error && e.message === '42')).toBe(true);
    edge.disconnect();
  });
});

describe('EdgeReplica — an arbitration decision is observable on the event stream', () => {
  it('an incoming value that wins arbitration is published to onEvent', async () => {
    const edge = new EdgeReplica({
      resolveConflict: (_lsn, _existing, incoming) => incoming,
    });
    const seen: Array<{ lsn: number; payload: unknown }> = [];
    edge.onEvent((event) => seen.push({ lsn: event.lsn, payload: event.payload }));
    await edge.connect(SOURCE);

    edge.receive(7, { key: 'k', value: 'from-a' });
    edge.receive(7, { key: 'k', value: 'from-b' });

    // The stream is append-only: the first frame was already published when it
    // arrived. The contract is that the subscriber's *latest* view of this LSN
    // agrees with getAllData() — the arbitrated value, not the stale first write.
    expect(edge.getAllData()).toEqual([{ lsn: 7, payload: { key: 'k', value: 'from-b' } }]);
    expect(seen[seen.length - 1]).toEqual({ lsn: 7, payload: { key: 'k', value: 'from-b' } });
    expect(seen).toHaveLength(2); // the original frame, then the decision
    edge.disconnect();
  });

  it('a decision that keeps the existing value is not published twice', async () => {
    const edge = new EdgeReplica({
      resolveConflict: (lsn, existing, _incoming) => existing,
    });
    const seen: unknown[] = [];
    edge.onEvent((event) => seen.push(event.payload));
    await edge.connect(SOURCE);

    edge.receive(7, { key: 'k', value: 'first' });
    edge.receive(7, { key: 'k', value: 'second' });

    expect(seen).toEqual([{ key: 'k', value: 'first' }]);
    edge.disconnect();
  });

  it('a byte-identical replay is not published again', async () => {
    const edge = new EdgeReplica();
    const seen: unknown[] = [];
    edge.onEvent((event) => seen.push(event.payload));
    await edge.connect(SOURCE);

    edge.receive(7, { key: 'k', value: 'v' });
    edge.receive(7, { key: 'k', value: 'v' });

    expect(seen).toEqual([{ key: 'k', value: 'v' }]);
    edge.disconnect();
  });
});
