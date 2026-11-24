/**
 * FederationManager — the dead letter queue has a drain.
 *
 * The manager owns the outbox, the transport and the replication engine, which
 * makes it the only object that can answer "is this target reachable, and does
 * it have entries we gave up on?" — and it never asked. `OutboxStore.retryDeadLetter(id)`
 * had no production caller and `housekeeping()` had none either, so the dead
 * letter queue only ever grew.
 *
 * The assertions are on which entries came back, not on a counter the manager
 * keeps about itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FederationManager, type FederationManagerConfig } from './FederationManager';
import { OutboxStore } from '../storage/OutboxStore';
import type { IMultiLeaderReplication } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';

const teardown: Array<() => void> = [];

afterEach(() => {
  for (const fn of teardown.splice(0)) {
    try {
      fn();
    } catch {
      /* already torn down */
    }
  }
});

interface Harness {
  manager: FederationManager;
  outbox: OutboxStore;
  reachable: Set<string>;
  recovered: () => void;
}

async function makeHarness(options: { reachable?: string[]; dlqScanIntervalMs?: number } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-dlq-'));
  // A zero retry window puts an entry in the dead letter queue on its first
  // failure, which is what this file needs: a queue with something in it.
  const outbox = new OutboxStore({ dataDir, mapSize: 8 * 1024 * 1024, retryWindowMs: 0 });
  const reachable = new Set(options.reachable ?? ['node-b']);

  let recoveredCallback: ((nodeId: string) => void) | null = null;

  const replication: IMultiLeaderReplication = {
    start: async () => {},
    stop: async () => {},
    replicate: async () => ({ msgId: 'm' }),
    getStatus: async () => ({ nodeId: 'node-a', dc: 'east', targets: [] }),
    retryFailed: async (nodeId: string) => outbox.retryDeadLetters(nodeId),
    getPendingCounts: async () => ({}),
    onTargetConnected: () => () => {},
    onTargetDisconnected: () => () => {},
    onTargetRecovered: (cb) => {
      recoveredCallback = cb;
      return () => {
        recoveredCallback = null;
      };
    },
    isPeerReachable: (nodeId: string) => reachable.has(nodeId),
    onHighLag: () => () => {},
  };

  const transport: ITransport = {
    send: async () => true,
    broadcast: async () => 0,
    onMessage: () => () => {},
    getConnectedPeers: () => [],
    getStats: () => ({
      peersConnected: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };

  const replicationConfig: ReplicationConfig = {
    nodeId: 'node-a',
    dc: 'east',
    curveDir: dataDir,
    targets: [
      { nodeId: 'node-b', dc: 'west', address: 'b:1', topology: 'cross-dc', maxBackoffSeconds: 1 },
      { nodeId: 'node-c', dc: 'north', address: 'c:1', topology: 'cross-dc', maxBackoffSeconds: 1 },
    ],
  };

  const config: FederationManagerConfig = {
    nodeId: 'node-a',
    dc: 'east',
    replicationConfig,
    transport,
    outbox,
    dlqScanIntervalMs: options.dlqScanIntervalMs ?? 0,
    outboxHousekeepingIntervalMs: 0,
  };

  const manager = new FederationManager(replication, config);
  await manager.start();

  teardown.push(() => {
    void manager.stop();
    outbox.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return {
    manager,
    outbox,
    reachable,
    recovered: () => recoveredCallback?.('node-b'),
  };
}

/** Write two entries for node-b and two for node-c, then fail them all. */
async function fillDeadLetters(outbox: OutboxStore): Promise<void> {
  for (const target of ['node-b', 'node-b', 'node-c', 'node-c']) {
    const entry = await outbox.add({
      targetPeerIds: [target],
      payload: new TextEncoder().encode('{}'),
      timestamp: { wallTime: 1n, logical: 0, nodeId: 'n1' } as never,
      type: 'replicate',
    });
    outbox.markFailed(entry.id, 'link down');
  }
}

describe('FederationManager — reviving dead letters', () => {
  it('revives only the targets that are reachable now', async () => {
    const h = await makeHarness({ reachable: ['node-b'] });
    await fillDeadLetters(h.outbox);
    expect(h.outbox.getDeadLetterStats().count).toBe(4);

    const revived = await h.manager.scanDeadLetters();

    expect(revived).toEqual({ 'node-b': 2 });
    // node-c is still down: its entries stay written off rather than churning.
    expect(h.outbox.getDeadLetterStats().count).toBe(2);
  });

  it('revives nothing when no target is reachable', async () => {
    const h = await makeHarness({ reachable: [] });
    await fillDeadLetters(h.outbox);

    expect(await h.manager.scanDeadLetters()).toEqual({});
    expect(h.outbox.getDeadLetterStats().count).toBe(4);
  });

  it('is a no-op on an empty queue', async () => {
    const h = await makeHarness();
    expect(await h.manager.scanDeadLetters()).toEqual({});
  });

  it('announces the revive with the number of entries', async () => {
    const h = await makeHarness();
    await fillDeadLetters(h.outbox);

    const events: unknown[] = [];
    h.manager['emitter'].on('dead-letters-revived', (payload: unknown) => events.push(payload));

    await h.manager.scanDeadLetters();
    expect(events).toEqual([{ 'node-b': 2 }]);
  });

  it('re-emits the engine recovery, and revives on it', async () => {
    const h = await makeHarness();
    await fillDeadLetters(h.outbox);

    const recovered: string[] = [];
    h.manager.onTargetRecovered((nodeId) => recovered.push(nodeId));

    h.recovered();
    expect(recovered).toEqual(['node-b']);

    // The handler revives asynchronously; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.outbox.getDeadLetterStats().count).toBe(2);
  });
});
