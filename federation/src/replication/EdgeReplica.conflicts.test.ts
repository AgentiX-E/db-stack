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
