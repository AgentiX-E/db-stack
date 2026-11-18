/**
 * EdgeReplica tests — covers connection, sync integrity, network partition recovery and backpressure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EdgeReplica, type EdgeSourceConfig, type ReplicationEvent } from '../../replication/EdgeReplica';

const DEFAULT_SOURCE: EdgeSourceConfig = {
  url: 'ws://localhost:9001',
  protocol: 'websocket',
};

describe('EdgeReplica', () => {
  let edge: EdgeReplica;

  beforeEach(async () => {
    edge = new EdgeReplica();
    await edge.connect(DEFAULT_SOURCE);
  });

  // ── Connection management ───────────────────────────────────────

  it('the state is syncing after connect', () => {
    const status = edge.getSyncStatus();
    expect(status.state).toBe('syncing');
  });

  it('the state is disconnected after disconnect', async () => {
    await edge.disconnect();
    const status = edge.getSyncStatus();
    expect(status.state).toBe('disconnected');
  });

  it('a repeated connect does not fail', async () => {
    await edge.connect(DEFAULT_SOURCE);
    const status = edge.getSyncStatus();
    expect(status.state).toBe('syncing');
  });

  // ── Data intake ─────────────────────────────────────────────────

  it('lag is updated correctly after one data entry arrives', () => {
    edge.receive(1, { key: 'test', value: 'hello' });
    const status = edge.getSyncStatus();
    expect(status.lastLSN).toBe(1);
    expect(status.receivedCount).toBe(1);
    expect(status.lagLSN).toBe(0); // source LSN == received LSN
  });

  it('getAllData returns the full list after several entries arrive', () => {
    edge.receive(1, 'a');
    edge.receive(2, 'b');
    edge.receive(3, 'c');

    const data = edge.getAllData();
    expect(data).toHaveLength(3);
    expect(data.map((d) => d.payload)).toEqual(['a', 'b', 'c']);
  });

  it('getLag returns lagLSN', () => {
    // sourceLSN = 10 (set by hand), lastLSN = 5
    edge.receive(5, 'data');
    edge.receive(10, 'data'); // this updates sourceLSN to 10, lastLSN to 10
    expect(edge.getLag()).toBe(0); // sourceLSN - lastLSN = 10-10 = 0
  });

  // ── Exact replication (1000 entries) ────────────────────────────

  it('1000 entries replicate to the edge exactly, with no loss and no reordering', () => {
    for (let i = 1; i <= 1000; i++) {
      edge.receive(i, `entry-${i}`);
    }

    const data = edge.getAllData();
    expect(data).toHaveLength(1000);

    // Check ordering
    expect(data[0]!.lsn).toBe(1);
    expect(data[999]!.lsn).toBe(1000);
    expect(data[499]!.payload).toBe('entry-500');
  });

  // ── Batch intake ────────────────────────────────────────────────

  it('receiveBatch handles every entry in a batch', () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({
      lsn: i + 1,
      payload: `batch-${i + 1}`,
    }));
    edge.receiveBatch(batch);
    expect(edge.getAllData()).toHaveLength(100);
    expect(edge.getSyncStatus().receivedCount).toBe(100);
  });

  // ── Network partition recovery ─────────────────────────────────

  it('no data is lost after a network partition (resume from the cut-off point)', async () => {
    // 1. Sync the first 500 entries
    for (let i = 1; i <= 500; i++) {
      edge.receive(i, `data-${i}`);
    }
    expect(edge.getAllData()).toHaveLength(500);

    // 2. Disconnect (simulates a network partition)
    await edge.disconnect();

    // 3. Reconnect
    await edge.connect(DEFAULT_SOURCE);

    // 4. Receive the last 500 entries (simulates recovery)
    for (let i = 501; i <= 1000; i++) {
      edge.receive(i, `data-${i}`);
    }

    // 5. Verify: the edge holds all 1000 entries
    const data = edge.getAllData();
    expect(data).toHaveLength(1000);
    expect(data[0]!.payload).toBe('data-1');
    expect(data[999]!.payload).toBe('data-1000');
  });

  // ── Event callbacks ─────────────────────────────────────────────

  it('the onEvent callback receives every data event', () => {
    const events: ReplicationEvent[] = [];
    edge.onEvent((e) => events.push(e));

    edge.receive(1, { key: 'a' });
    edge.receive(2, { key: 'b' });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('data');
    expect(events[0]!.lsn).toBe(1);
  });

  it('onSyncComplete fires when lag = 0', () => {
    const handler = vi.fn();
    edge.onSyncComplete(handler);

    edge.receive(1, 'x');
    // sourceLSN == lastLSN, lag == 0 → sync complete
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('an unregistered callback no longer fires', () => {
    const handler = vi.fn();
    const unsub = edge.onEvent(handler);
    unsub();

    edge.receive(1, 'x');
    expect(handler).not.toHaveBeenCalled();
  });

  it('onError receives error events', () => {
    const handler = vi.fn();
    edge.onError(handler);

    // Simulate an intake error
    edge['_emitError'](new Error('Connection refused'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── Backpressure ────────────────────────────────────────────────

  it('backpressure: a large receiveBatch loses nothing', () => {
    const batch = Array.from({ length: 10000 }, (_, i) => ({
      lsn: i + 1,
      payload: `high-throughput-${i + 1}`,
    }));
    edge.receiveBatch(batch);
    expect(edge.getAllData()).toHaveLength(10000);
  });

  // ── Ordering ────────────────────────────────────────────────────

  it('getAllData keeps intake order when LSNs arrive out of order', () => {
    edge.receive(3, 'c');
    edge.receive(1, 'a');
    edge.receive(2, 'b');

    const data = edge.getAllData();
    // Keeps intake order (no strict sort by LSN; these are edge records)
    expect(data.map((d) => d.lsn)).toEqual([3, 1, 2]);
    expect(data.map((d) => d.payload)).toEqual(['c', 'a', 'b']);
  });
});

// ── Extra coverage of connect boundaries ──────────────────────────
describe('EdgeReplica additional coverage', () => {
  it('destroyed replica rejects connect', async () => {
    const edge = new EdgeReplica();
    // Directly access internal flag for test coverage of destroyed guard
    edge['_destroyed'] = true;
    await expect(edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' })).rejects.toThrow(
      'EdgeReplica has been destroyed',
    );
  });

  it('disconnect clears reconnect timer', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    edge['_reconnectTimer'] = setTimeout(() => {}, 99999);
    await edge.disconnect();
    // Timer should be cleared
    expect(edge['_reconnectTimer']).toBeNull();
  });

  it('receive does nothing when disconnected', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    await edge.disconnect();
    edge.receive(99, 'should-be-ignored');
    expect(edge.getAllData()).toHaveLength(0);
  });

  it('event handler error isolation does not crash', () => {
    const edge = new EdgeReplica();
    edge.onEvent(() => {
      throw new Error('handler crash');
    });
    // Should not throw
    expect(() => edge.receive(1, 'test')).not.toThrow();
  });

  it('syncComplete handler error isolation', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    let called = false;
    edge.onSyncComplete(() => {
      throw new Error('syncComplete crash');
    });
    edge.onSyncComplete(() => {
      called = true;
    });
    edge.receive(1, 'x'); // triggers syncComplete (lag=0) when connected
    expect(called).toBe(true); // second handler still fires
    await edge.disconnect();
  });

  it('error handler error isolation', () => {
    const edge = new EdgeReplica();
    let called = false;
    edge.onError(() => {
      throw new Error('error handler crash');
    });
    edge.onError(() => {
      called = true;
    });
    edge['_emitError'](new Error('test'));
    expect(called).toBe(true);
  });

  it('onSyncComplete only fires once (unsubscribe)', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    let count = 0;
    const unsub = edge.onSyncComplete(() => {
      count++;
    });
    edge.receive(1, 'first');
    unsub();
    edge.receive(2, 'second');
    expect(count).toBe(1);
    await edge.disconnect();
  });

  it('getSyncStatus returns fresh snapshot', () => {
    const edge = new EdgeReplica();
    const s1 = edge.getSyncStatus();
    expect(s1.state).toBe('disconnected');
    edge.receive(5, 'data'); // still disconnected
    const s2 = edge.getSyncStatus();
    // disconnected → receive does nothing
    expect(s2.receivedCount).toBe(0);
  });
});
