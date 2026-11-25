/**
 * FederationManager — the control plane it wires, and the log it hands off from.
 *
 * Neither subject here is the replication path (that is
 * `FederationManager.inbound.test.ts`):
 *
 *   1. **Routing.** A heartbeat, a digest and a bootstrap frame each have to
 *      reach the component that owns them, and a control frame that reaches none
 *      has to be reported rather than dropped. Before IT-90 the first two were
 *      local emitter events — a subscriber inside the process saw them and no peer
 *      ever did — so "routed" was not a property anything could check.
 *   2. **The handoff log.** A bootstrapping peer names a position and expects
 *      everything after it. The position is real (this layer's own `_lsn`),
 *      bounded (`handoffLogLimit`), and refused rather than answered empty when
 *      the log no longer reaches back: an empty answer tells the peer its handoff
 *      finished and leaves a hole nothing will fill.
 *
 * The managers here are real, over a real `InProcessTransport`. Only the
 * replication engine and the outbox are doubled, because neither is what these
 * cases are about and both bring their own stores and timers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FederationManager, encodeEnvelope } from './FederationManager';
import type { IMultiLeaderReplication } from '../interfaces/replication/IMultiLeaderReplication';
import type { ReplicationConfig, ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import { InProcessTransport } from '../transport/InProcessTransport';
import { HLC } from '../hlc/HLC';
import { deriveRetention } from '../storage/retention';
import { buildHeartbeatFrame, HEARTBEAT_TYPE } from './heartbeatFrame';
import type { HeartbeatBody } from './heartbeatFrame';
import { AE_SUMMARY_TYPE, buildSummaryRequest } from '../replication/antientropyFrames';
import {
  BOOTSTRAP_DONE_TYPE,
  BOOTSTRAP_REQUEST_TYPE,
  buildBootstrapDone,
  buildBootstrapRequest,
} from '../replication/bootstrapFrames';

// ── Fixtures ──

function target(nodeId: string): ReplicationTarget {
  return { nodeId, dc: 'dc-west', address: `tls://${nodeId}:7001`, topology: 'cross-dc', maxBackoffSeconds: 60 };
}

function replicationConfig(nodeId: string, peers: string[]): ReplicationConfig {
  return { nodeId, dc: 'dc-east', curveDir: '/tmp/test', targets: peers.map(target) };
}

function mockReplication(): IMultiLeaderReplication {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    replicate: vi.fn().mockResolvedValue({ msgId: 'repl:0:mock' }),
    getStatus: vi.fn().mockResolvedValue({ nodeId: 'node-a', dc: 'dc-east', targets: [] }),
    retryFailed: vi.fn().mockResolvedValue(0),
    getPendingCounts: vi.fn().mockResolvedValue({}),
    onTargetConnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetDisconnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetRecovered: vi.fn().mockReturnValue(vi.fn()),
    isPeerReachable: vi.fn(() => true),
    onHighLag: vi.fn().mockReturnValue(vi.fn()),
    getRetention: () => deriveRetention(),
  };
}

function storedEntry(): OutboxEntry {
  return {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: new HLC('test').now(),
    type: 'test',
    status: 'pending',
    createdAt: Date.now(),
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  };
}

function mockOutbox(): IOutboxStore {
  return {
    add: vi.fn().mockResolvedValue(storedEntry()),
    fetchOldestPending: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockReturnValue(false),
    getPendingCount: vi.fn().mockResolvedValue(0),
    getPendingStats: vi.fn(() => ({})),
    getDeadLetterEntries: vi.fn(() => []),
    retryDeadLetters: vi.fn(() => 0),
    housekeeping: vi.fn(() => ({ delivered: 0, deadLettered: 0 })),
    getRetention: () => deriveRetention(),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      pendingCount: 0,
      deliveredCount: 0,
      oldestPendingTimestamp: null,
    }),
  };
}

interface Node {
  manager: FederationManager;
  transport: InProcessTransport;
  registryKey: string;
}

const open: Node[] = [];
const spares: InProcessTransport[] = [];

/**
 * A socket on an existing registry, with nothing behind it.
 *
 * A manager answers the peer that asked, so a case that asserts on the answer
 * needs somebody at the other end of the wire — otherwise the transport refuses
 * the reply and the counter under test stays at zero for a reason that has
 * nothing to do with routing.
 */
function peerOn(registryKey: string, nodeId: string): InProcessTransport {
  const transport = new InProcessTransport({ nodeId, registryKey });
  spares.push(transport);
  return transport;
}

/**
 * A manager on a real transport, with every background timer pinned except the
 * ones a case is about.
 *
 * The defaults are left long rather than disabled: an interval of `0` means "off"
 * for the sweep and the heartbeat, and a disabled timer cannot be observed. Long
 * intervals say the same thing without claiming the timer does not exist.
 */
function node(nodeId: string, options: { peers?: string[]; overrides?: Record<string, unknown> } = {}): Node {
  const registryKey = `fm-${Math.random().toString(36).slice(2)}`;
  const transport = new InProcessTransport({ nodeId, registryKey });
  const config = {
    nodeId,
    dc: 'dc-east',
    replicationConfig: replicationConfig(nodeId, options.peers ?? []),
    transport: transport as ITransport,
    outbox: mockOutbox(),
    hlc: new HLC(nodeId),
    antiEntropyIntervalMs: 0,
    heartbeatIntervalMs: 3_600_000,
    dlqScanIntervalMs: 0,
    outboxHousekeepingIntervalMs: 0,
    healthConfig: { highLagThresholdMs: 60_000, checkIntervalMs: 3_600_000 },
    ...options.overrides,
  } as ConstructorParameters<typeof FederationManager>[1];
  const manager = new FederationManager(mockReplication(), config);
  const created = { manager, transport, registryKey };
  open.push(created);
  return created;
}

/** Two managers sharing one registry, so each is reachable from the other. */
function pair(options: { overrides?: Record<string, unknown> } = {}): { a: Node; b: Node } {
  const registryKey = `fm-${Math.random().toString(36).slice(2)}`;
  const build = (nodeId: string, peers: string[]): Node => {
    const transport = new InProcessTransport({ nodeId, registryKey });
    const config = {
      nodeId,
      dc: nodeId === 'node-a' ? 'dc-east' : 'dc-west',
      replicationConfig: replicationConfig(nodeId, peers),
      transport: transport as ITransport,
      outbox: mockOutbox(),
      hlc: new HLC(nodeId),
      antiEntropyIntervalMs: 0,
      heartbeatIntervalMs: 3_600_000,
      dlqScanIntervalMs: 0,
      outboxHousekeepingIntervalMs: 0,
      healthConfig: { highLagThresholdMs: 60_000, checkIntervalMs: 3_600_000 },
      ...options.overrides,
    } as ConstructorParameters<typeof FederationManager>[1];
    const created = { manager: new FederationManager(mockReplication(), config), transport, registryKey };
    open.push(created);
    return created;
  };
  return { a: build('node-a', ['node-b']), b: build('node-b', ['node-a']) };
}

function frame(type: string, from: string, to: string, payload: Uint8Array): InboundMessage {
  return {
    messageId: `${type}-${Math.random().toString(36).slice(2)}`,
    sourcePeerId: from,
    targetPeerId: to,
    payload,
    timestamp: new HLC(from).now(),
    createdAt: Date.now(),
    receivedAt: Date.now(),
    type,
  };
}

function heartbeatBody(nodeId: string, dcId: string, seq = 1): HeartbeatBody {
  return {
    dcId,
    nodeId,
    seq,
    sentAt: Date.now(),
    hlc: { wallTime: Date.now(), logical: 1, nodeId },
    appliedCount: 0,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

afterEach(async () => {
  for (const created of open) {
    await created.manager.stop();
    created.transport.destroy();
  }
  open.length = 0;
  for (const transport of spares) transport.destroy();
  spares.length = 0;
});

// ── Routing ──

describe('FederationManager — control-plane routing', () => {
  it('owns a protocol for every control family, and refuses one before start', async () => {
    const { manager } = node('node-a');

    // Before `start()` there is nothing to hand out. Throwing is the point: a
    // caller that got `undefined` back would dereference it on the next line.
    expect(() => manager.getAntiEntropyProtocol()).toThrow(/Call start\(\) first/);
    expect(() => manager.getHeartbeat()).toThrow(/Call start\(\) first/);
    expect(() => manager.getBootstrap()).toThrow(/Call start\(\) first/);
    expect(() => manager.getConflictResolver()).toThrow(/Call start\(\) first/);
    expect(() => manager.getProtocolStatus()).not.toThrow();

    const before = manager.getProtocolStatus();
    expect(before).toEqual({ antiEntropy: null, heartbeat: null, bootstrap: null, lsn: 0 });

    await manager.start();

    expect(manager.getAntiEntropyProtocol()).toBeInstanceOf(Object);
    expect(manager.getHeartbeat()).toBeInstanceOf(Object);
    expect(manager.getBootstrap()).toBeInstanceOf(Object);
    expect(manager.getConflictResolver()).toBeInstanceOf(Object);

    const after = manager.getProtocolStatus();
    expect(after.lsn).toBe(0);
    expect(after.antiEntropy?.sweeps).toBe(0);
    expect(after.heartbeat?.selfSeq).toBe(0);
    expect(after.bootstrap?.chunksReceived).toBe(0);
  });

  it('routes a heartbeat frame to the heartbeat protocol instead of the dedup ring', async () => {
    const { manager } = node('node-a');
    await manager.start();

    const beat = buildHeartbeatFrame(
      'hb-1',
      'node-b',
      'node-a',
      heartbeatBody('node-b', 'dc-west'),
      new HLC('node-b').now(),
    );

    // `protocol`, not `applied`: a heartbeat is not a change, and the dedup ring
    // would answer it with the wrong vocabulary — `duplicate` means "I have this
    // change", which is not what a repeated interval is.
    expect(await manager.applyInbound({ ...beat, receivedAt: Date.now() })).toBe('protocol');
    expect(manager.getHeartbeat().getStatus().received).toBe(1);
    expect(manager.getHeartbeat().getStatus().peers['node-b']).toMatchObject({ seq: 1 });
  });

  it('routes a digest request to the anti-entropy protocol', async () => {
    const subject = node('node-a');
    peerOn(subject.registryKey, 'node-b');
    await subject.manager.start();

    const digest = await subject.manager.getAntiEntropy().buildDigest('default');
    const request = buildSummaryRequest(
      'ae-req-1',
      'node-b',
      'node-a',
      { kind: 'request', shardId: 'default', digest },
      new HLC('node-b').now(),
    );

    expect(await subject.manager.applyInbound({ ...request, receivedAt: Date.now() })).toBe('protocol');
    await waitFor(
      () => subject.manager.getAntiEntropyProtocol().getStatus().repliesSent === 1,
      3_000,
      'the digest reply',
    );
    // The requester's root is remembered, so a status page can show what the peer
    // claimed rather than only that a frame arrived.
    expect(subject.manager.getAntiEntropyProtocol().getStatus().peers['node-b']).toMatchObject({
      root: digest.root,
    });
  });

  it('routes a bootstrap request to the bootstrap protocol', async () => {
    const subject = node('node-a');
    peerOn(subject.registryKey, 'node-b');
    await subject.manager.start();
    await subject.manager.replicate('k0', 'v0', 'insert');

    const request = buildBootstrapRequest(
      'bs-req-1',
      'node-b',
      'node-a',
      { transferId: 'transfer-1', shardId: 'default', nextChunk: 0, fromLsn: 0 },
      new HLC('node-b').now(),
    );

    expect(await subject.manager.applyInbound({ ...request, receivedAt: Date.now() })).toBe('protocol');
    await waitFor(
      () => subject.manager.getBootstrap().getStatus().chunksSent === 1,
      3_000,
      'the snapshot chunk to be sent',
    );
  });

  it('reports a control frame that no protocol consumed', async () => {
    const { manager } = node('node-a');
    // Not started: every protocol is unbound, so a control frame has no owner.
    // `malformed` rather than a silent drop — "I do not know this frame" is a
    // fact an operator can act on, and silence is not.
    const beat = buildHeartbeatFrame(
      'hb-orphan',
      'node-b',
      'node-a',
      heartbeatBody('node-b', 'dc-west'),
      new HLC('node-b').now(),
    );

    expect(await manager.applyInbound({ ...beat, receivedAt: Date.now() })).toBe('malformed');
    expect(manager.getLastInboundError()).toMatch(/no protocol consumed/);
  });

  it('turns a rejected apply into a diagnostic instead of an unhandled rejection', async () => {
    const { manager } = node('node-a');
    await manager.start();
    // A key that already exists, so an inbound write has to go through conflict
    // resolution — and a strategy that fails is precisely the case the inbound
    // subscription's `catch` exists for: a rejection there would terminate the
    // process on Node >= 15.
    await manager.replicate('shared', 'local', 'insert');
    manager.getConflictResolver().resolve = async () => {
      throw new Error('resolution strategy is unavailable');
    };

    const payload = new TextEncoder().encode(
      encodeEnvelope({
        key: 'shared',
        value: 'remote',
        type: 'update',
        sourceNodeId: 'node-b',
        sourceDc: 'dc-west',
        hlc: { wallTime: Date.now(), logical: 1, nodeId: 'node-b' },
      }),
    );

    // Delivered through `applyInbound` rather than the transport: this asserts the
    // contract the subscription relies on, and the subscription is a one-line
    // adapter over exactly this call.
    await expect(manager.applyInbound(frame('replicate', 'node-b', 'node-a', payload))).rejects.toThrow(
      /resolution strategy is unavailable/,
    );

    // And the same rejection, arriving through the transport, becomes a recorded
    // reason instead of an unhandled rejection.
    const peer = new InProcessTransport({ nodeId: 'node-b', registryKey: (open[0] as Node).registryKey });
    try {
      await peer.send(frame('replicate', 'node-b', 'node-a', payload));
      await waitFor(
        () => (manager.getLastInboundError() ?? '').includes('resolution strategy is unavailable'),
        3_000,
        'the failure to be recorded',
      );
    } finally {
      peer.destroy();
    }
  });
});

// ── Handoff ──

describe('FederationManager — handing off to a bootstrapping peer', () => {
  it('brings a peer up to date from its own log, and advances the peer position', async () => {
    const { a, b } = pair();
    await a.manager.start();
    await b.manager.start();

    await a.manager.replicate('k0', 'v0', 'insert');
    await a.manager.replicate('k1', 'v1', 'insert');
    expect(a.manager.getLsn()).toBe(2);

    const transferId = await b.manager.bootstrapFrom('node-a');
    await waitFor(() => b.manager.getBootstrap().getStatus().completed.length === 1, 3_000, 'the transfer to finish');

    // The receiving side now holds both keys, in its own store *and* in its own
    // handoff log — a peer that bootstraps has to be able to hand off in turn, or
    // a third datacenter could never join through it.
    expect(b.manager.getBootstrap().getStatus().completed[0]).toMatchObject({
      transferId,
      peerId: 'node-a',
      entriesApplied: 2,
    });
    expect(b.manager.getLsn()).toBe(2);
    expect(b.manager.getLocalStore().has('k0')).toBe(true);
    expect(b.manager.getLocalStore().has('k1')).toBe(true);
  });

  it('defaults to the first configured target when no peer is named', async () => {
    const { a, b } = pair();
    await a.manager.start();
    await b.manager.start();
    await a.manager.replicate('only', 'v', 'insert');

    // No argument: the overwhelming majority of callers have one target and
    // reading the topology to find its id is how a rebuild script ends up with a
    // hard-coded peer.
    await b.manager.bootstrapFrom();
    await waitFor(() => b.manager.getBootstrap().getStatus().completed.length === 1, 3_000, 'the transfer');

    expect(b.manager.getBootstrap().getStatus().completed[0]).toMatchObject({ peerId: 'node-a' });
  });

  it('refuses a handoff position the log has already dropped', async () => {
    const subject = node('node-a', { overrides: { handoffLogLimit: 2 } });
    peerOn(subject.registryKey, 'node-b');
    await subject.manager.start();
    for (let i = 0; i < 3; i += 1) await subject.manager.replicate(`k${i}`, `v${i}`, 'insert');

    // Three changes, a two-entry log: position 1 is gone. A peer asking from there
    // is asking for a range this node cannot produce, and answering `[]` would
    // report a finished handoff over a hole.
    const stale = buildBootstrapDone(
      'bs-done-stale',
      'node-b',
      'node-a',
      { transferId: 'transfer-old', shardId: 'default', highWaterMark: 0 },
      new HLC('node-b').now(),
    );
    expect(await subject.manager.applyInbound({ ...stale, receivedAt: Date.now() })).toBe('protocol');

    await waitFor(() => subject.manager.getBootstrap().getStatus().lastError !== null, 3_000, 'the refusal');
    expect(subject.manager.getBootstrap().getStatus().lastError).toMatch(/past the requested position 0/);
  });

  it('bounds the handoff log at its configured length', async () => {
    const { manager } = node('node-a', { overrides: { handoffLogLimit: 2 } });
    await manager.start();
    for (let i = 0; i < 5; i += 1) await manager.replicate(`k${i}`, `v${i}`, 'insert');

    // The position keeps counting even though the log forgets: a peer's floor is a
    // number, not an array index, and renumbering after a trim would make an old
    // floor mean a new change.
    expect(manager.getLsn()).toBe(5);

    const source = manager['buildBootstrapSource']();
    expect(await source.currentLsn()).toBe(5);
    expect((await source.entriesAfter(3, 10)).map((record) => record.lsn)).toEqual([4, 5]);
  });
});

// ── Housekeeping and diagnostics ──

describe('FederationManager — housekeeping and diagnostics', () => {
  it('prunes the outbox on its interval and reports what it removed', async () => {
    const outbox = mockOutbox();
    outbox.housekeeping = vi.fn(() => ({ delivered: 4, deadLettered: 1 }));
    const { manager } = node('node-a', { overrides: { outbox, outboxHousekeepingIntervalMs: 10 } });
    await manager.start();

    const pruned: Array<{ delivered: number; deadLettered: number }> = [];
    manager['emitter'].on('outbox-pruned', (removed: { delivered: number; deadLettered: number }) =>
      pruned.push(removed),
    );

    await waitFor(() => pruned.length > 0, 3_000, 'the outbox to be pruned');

    // The only place an outbox entry is deleted for good, so the count has to be
    // reported: a prune nobody can see is indistinguishable from data loss.
    expect(pruned[0]).toEqual({ delivered: 4, deadLettered: 1 });
  });

  it('records a housekeeping failure rather than throwing from a timer', async () => {
    const outbox = mockOutbox();
    outbox.housekeeping = () => {
      throw new Error('outbox is locked');
    };
    const { manager } = node('node-a', { overrides: { outbox, outboxHousekeepingIntervalMs: 10 } });
    await manager.start();

    // A throw out of a timer would be an uncaught exception. Recorded instead, so
    // the operator sees the failure and the process survives it.
    await waitFor(
      () => (manager.getLastInboundError() ?? '').includes('outbox is locked'),
      3_000,
      'the housekeeping failure',
    );
    expect(manager.getLastInboundError()).toMatch(/Error: outbox is locked/);
  });

  it('records a housekeeping failure that is not an Error object', async () => {
    const outbox = mockOutbox();
    outbox.housekeeping = () => {
      // eslint-disable-next-line no-throw-literal -- the case under test is a store that fails with a value rather than an Error
      throw 'outbox is locked';
    };
    const { manager } = node('node-a', { overrides: { outbox, outboxHousekeepingIntervalMs: 10 } });
    await manager.start();

    // A string thrown from a store is still a failure that has to be readable;
    // `err.message` on a string is `undefined`, so the reason is taken verbatim.
    await waitFor(() => manager.getLastInboundError() === 'outbox is locked', 3_000, 'the housekeeping failure');
  });

  it('records a confirmation the transport could not carry', async () => {
    const transport: ITransport = {
      send: vi.fn().mockRejectedValue(new Error('socket is gone')),
      broadcast: vi.fn().mockResolvedValue(0),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      getConnectedPeers: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({
        peersConnected: 0,
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        uptimeMs: 0,
      }),
    };
    const manager = new FederationManager(mockReplication(), {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: replicationConfig('node-a', ['node-b']),
      transport,
      outbox: mockOutbox(),
      hlc: new HLC('node-a'),
      antiEntropyIntervalMs: 0,
      heartbeatIntervalMs: 3_600_000,
      dlqScanIntervalMs: 0,
      outboxHousekeepingIntervalMs: 0,
      healthConfig: { highLagThresholdMs: 60_000, checkIntervalMs: 3_600_000 },
    });
    await manager.start();
    try {
      const payload = new TextEncoder().encode(
        encodeEnvelope({
          key: 'k',
          value: 'v',
          type: 'insert',
          sourceNodeId: 'node-b',
          sourceDc: 'dc-west',
          hlc: { wallTime: Date.now(), logical: 1, nodeId: 'node-b' },
        }),
      );

      // Applied, and the confirmation failed on the way out. The change is not
      // rolled back: the sender's timeout is what makes the retry, and reporting a
      // failure here would tell a caller its succeeded write did not happen.
      expect(await manager.applyInbound(frame('replicate', 'node-b', 'node-a', payload))).toBe('applied');
      expect(manager.getLastAckError()).toMatch(/socket is gone/);
      expect(manager.getLocalStore().get('k')).toMatchObject({ value: 'v' });
    } finally {
      await manager.stop();
    }
  });

  it('stops reporting recovered targets once unsubscribed', async () => {
    const { manager } = node('node-a');
    await manager.start();

    const seen: string[] = [];
    const off = manager.onTargetRecovered((targetNodeId) => seen.push(targetNodeId));
    manager['emitter'].emit('target-recovered', 'node-b');
    off();
    manager['emitter'].emit('target-recovered', 'node-c');

    expect(seen).toEqual(['node-b']);
  });

  it('takes an envelope with no source datacenter and no frame type', async () => {
    const { manager } = node('node-a');
    await manager.start();

    // A peer that predates the `sourceDc` field, and a transport that leaves the
    // type off: both are answered with `unknown` and the fallback type rather than
    // being rejected, because a legacy producer is a supported peer.
    const payload = new TextEncoder().encode(
      JSON.stringify({
        __fb: 'fb1',
        key: 'legacy',
        value: 'v',
        type: 'insert',
        sourceNodeId: 'node-b',
        hlc: { wallTime: Date.now(), logical: 1, nodeId: 'node-b' },
      }),
    );

    const inbound = { ...frame('replicate', 'node-b', 'node-a', payload), type: undefined };
    const seen: Array<{ sourceDc: string }> = [];
    manager.registerConsumer({
      proposeReplicated: async (entry) => {
        seen.push(entry);
      },
      getHLC: () => new HLC('node-a'),
      onConflict: async () => undefined,
    });

    expect(await manager.applyInbound(inbound)).toBe('applied');
    expect(seen[0]).toMatchObject({ sourceDc: 'unknown' });
  });

  it('declines a change the receiving cluster would not take', async () => {
    const { manager } = node('node-a');
    await manager.start();
    manager.registerConsumer({
      proposeReplicated: async () => {
        throw new Error('no leader');
      },
      getHLC: () => new HLC('node-a'),
      onConflict: async () => undefined,
    });

    const payload = new TextEncoder().encode(
      encodeEnvelope({
        key: 'k',
        value: 'v',
        type: 'insert',
        sourceNodeId: 'node-b',
        sourceDc: 'dc-west',
        hlc: { wallTime: Date.now(), logical: 1, nodeId: 'node-b' },
      }),
    );
    const inbound = frame('replicate', 'node-b', 'node-a', payload);

    expect(await manager.applyInbound(inbound)).toBe('declined');
    expect(manager.getLastInboundError()).toMatch(/no leader/);
    // The id left the dedup ring with the refusal, so the sender's retry is judged
    // on its own — a refusal followed by `duplicate` would be a silent loss with
    // two acknowledgements.
    expect(await manager.applyInbound(inbound)).toBe('declined');
  });

  it('still names the frame family in a heartbeat frame it could not read', async () => {
    const { manager } = node('node-a');
    await manager.start();

    // A control frame whose payload is not this build's encoding: the owner is
    // found by type, so the frame is routed and then refused by the protocol that
    // owns it — not reported as an unknown family.
    expect(
      await manager.applyInbound(frame(HEARTBEAT_TYPE, 'node-b', 'node-a', new TextEncoder().encode('{"seq":1}'))),
    ).toBe('protocol');
    expect(manager.getHeartbeat().getStatus().malformed).toBe(1);
  });
});

// ── Types kept honest ──

describe('FederationManager — frame families are disjoint', () => {
  it('sends a bootstrap done frame of its own type', () => {
    // `AE_SUMMARY_TYPE` and `BOOTSTRAP_REQUEST_TYPE` are dispatched on by string in
    // `applyInbound`, so an accidental collision would make one family's frames
    // reachable only through the other's decoder.
    expect(AE_SUMMARY_TYPE).not.toBe(BOOTSTRAP_REQUEST_TYPE);
    expect(BOOTSTRAP_DONE_TYPE).not.toBe(HEARTBEAT_TYPE);
  });
});
