/**
 * FederationManager — the sender's budget and the receiver's memory.
 *
 * The manager owns the receiver side of the link: it is the component that
 * remembers a `msgId` and therefore the component that decides whether a retry
 * is a retry. The sender's retry budget lives in the outbox, which the manager
 * cannot see; the replication can, so the manager asks it and refuses to build a
 * ring that would forget a message id before the sender stops repeating it.
 *
 *   FR.1  the ring is built from the configured dedup window
 *   FR.2  a dedup window shorter than the sender's budget is refused, before start
 *   FR.3  the refusal happens in the constructor, so nothing has been wired yet
 *   FR.4  an omitted window is the package default, not the sender's guess
 *   FR.5  inside the window a repeat is a duplicate; past it, the same id is new
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FederationManager } from './FederationManager';
import type {
  IMultiLeaderReplication,
  ReplicationConfig,
  ReplicationStatus,
} from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import { DEFAULT_RETENTION, RetentionViolation, deriveRetention } from '../storage/retention';
import type { RetentionWindows } from '../storage/retention';

const MINUTE = 60_000;
const T0 = Date.parse('2026-05-01T00:00:00.000Z');
let clock = T0;

beforeEach(() => {
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function replicationConfig(): ReplicationConfig {
  return { nodeId: 'node-a', dc: 'dc-east', curveDir: '/tmp/test', targets: [] };
}

function transport(): ITransport {
  return {
    send: vi.fn().mockResolvedValue(true),
    broadcast: vi.fn().mockResolvedValue(1),
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
}

function replication(retention?: RetentionWindows): IMultiLeaderReplication & { start: any } {
  const status: ReplicationStatus = { nodeId: 'node-a', dc: 'dc-east', targets: [] };
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    replicate: vi.fn().mockResolvedValue({ msgId: 'repl:0:uuid' }),
    getStatus: vi.fn().mockResolvedValue(status),
    retryFailed: vi.fn().mockResolvedValue(0),
    getPendingCounts: vi.fn().mockResolvedValue({}),
    onTargetConnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetDisconnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetRecovered: vi.fn().mockReturnValue(vi.fn()),
    isPeerReachable: vi.fn(() => true),
    onHighLag: vi.fn().mockReturnValue(vi.fn()),
    getRetention: vi.fn(() => retention ?? deriveRetention()),
  };
}

/** A replicate frame the manager can decode: `decodeEnvelope` reads this shape. */
function frame(messageId: string): InboundMessage {
  return {
    messageId,
    sourcePeerId: 'node-b',
    targetPeerId: 'node-a',
    type: 'replicate',
    timestamp: { wallTime: BigInt(T0), logical: 0, nodeId: 'node-b' } as never,
    createdAt: T0,
    receivedAt: T0,
    payload: new TextEncoder().encode(JSON.stringify({ key: 'k', value: messageId, sourceNodeId: 'node-b' })),
  };
}

/**
 * An outbox the manager never writes to.
 *
 * `applyInbound` is the receiver path: it resolves the conflict against the
 * local store and never touches the outbox, so the double only has to be
 * complete enough to construct the manager.
 */
function outbox(): IOutboxStore {
  const entry = {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: { wallTime: BigInt(T0), logical: 0, nodeId: 'node-a' },
    type: 'replicate',
    status: 'pending',
    createdAt: T0,
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  } as unknown as OutboxEntry;
  return {
    add: vi.fn().mockResolvedValue(entry),
    fetchOldestPending: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockReturnValue(false),
    getPendingCount: vi.fn().mockResolvedValue(0),
    getPendingStats: vi.fn(() => ({})),
    getDeadLetterEntries: vi.fn(() => []),
    retryDeadLetters: vi.fn(() => 0),
    housekeeping: vi.fn(() => ({ delivered: 0, deadLettered: 0 })),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      pendingCount: 0,
      deliveredCount: 0,
      oldestDeliveredTimestamp: null,
    }),
    getRetention: () => deriveRetention(),
  } as unknown as IOutboxStore;
}

function config(extra: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-a',
    dc: 'dc-east',
    replicationConfig: replicationConfig(),
    transport: transport(),
    outbox: outbox(),
    ...extra,
  };
}

describe('FederationManager — retention windows', () => {
  it('FR.1: the ring is built from the configured dedup window', () => {
    const repl = replication(deriveRetention({ retryWindowMs: 2 * MINUTE, dedupMs: 10 * MINUTE }));
    const manager = new FederationManager(repl, config({ dedupWindowMs: 10 * MINUTE }));
    expect(manager.getRetention().dedupMs).toBe(10 * MINUTE);
    expect(manager.getRetention().retryWindowMs).toBe(2 * MINUTE);
  });

  it('FR.2: a dedup window shorter than the sender budget is refused', () => {
    const repl = replication(deriveRetention({ retryWindowMs: 10 * MINUTE, dedupMs: 10 * MINUTE }));
    expect(() => new FederationManager(repl, config({ dedupWindowMs: 5 * MINUTE }))).toThrow(RetentionViolation);
  });

  it('FR.3: the refusal happens before anything is wired or started', () => {
    const repl = replication(deriveRetention({ retryWindowMs: 10 * MINUTE, dedupMs: 10 * MINUTE }));
    let caught: unknown;
    try {
      new FederationManager(repl, config({ dedupWindowMs: MINUTE }));
    } catch (error) {
      caught = error;
    }
    expect((caught as RetentionViolation).rule).toBe('dedup-covers-retry');
    expect(repl.start).not.toHaveBeenCalled();
    expect(repl.getStatus).not.toHaveBeenCalled();
  });

  it('FR.4: an omitted window is the package default', () => {
    const repl = replication();
    const manager = new FederationManager(repl, config());
    expect(manager.getRetention().dedupMs).toBe(DEFAULT_RETENTION.dedupMs);
  });

  it('FR.5: inside the window a repeat is a duplicate; past it the id is new', async () => {
    const repl = replication(deriveRetention({ retryWindowMs: MINUTE, dedupMs: 2 * MINUTE }));
    const manager = new FederationManager(repl, config({ dedupWindowMs: 2 * MINUTE }));

    expect(await manager.applyInbound(frame('m-1'))).toBe('applied');
    expect(await manager.applyInbound(frame('m-1'))).toBe('duplicate');

    // Still inside the window: the sender may still be retrying this id.
    clock = T0 + MINUTE;
    expect(await manager.applyInbound(frame('m-1'))).toBe('duplicate');

    // Past it: every retry the sender could have made has already arrived.
    clock = T0 + 3 * MINUTE;
    expect(await manager.applyInbound(frame('m-1'))).toBe('applied');
  });
});
