/**
 * BatchedRaftTransport Unit Tests
 *
 * Tests all BatchedRaftTransport logic via mocked RaftTcpTransport — no real ports.
 *
 * Mock strategy:
 *   - RaftTcpTransport is replaced by a mock class that records sendToPeer calls
 *     and exposes a simulateMessage() hook to trigger onIncoming().
 *   - Use real timers with small requestTimeoutMs (100-200ms) for timeout tests.
 *   - Headers, encoding, and requestId collision are tested directly.
 *
 * Acceptance criteria:
 *   AC 8.1 — Concurrent 100 RPCs — send() resolves with correct response mapping
 *   AC 8.2 — Timeout — send() rejects with timeout error after configurable delay
 *   AC 8.3 — Transport stop cleanup — all pending promises rejected
 *   AC 8.4 — requestId uniqueness — no collision in 10000 consecutive calls
 *   AC 8.5 — direction=response routing — response matched to correct pending
 *   AC 8.6 — Handler error resilience — handler rejection does not crash transport
 *   AC 8.7 — Multiple concurrent requests — each gets correct response
 *   AC 8.8 — Response after timeout — ignored (pending already cleaned)
 *   AC 8.9 — isStarted() reflects lifecycle
 *   AC 8.10 — sendToPeer with invalid peerId rejects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageHandler, RPCMessage } from '@maboke123/raft-core';

// ── Mock RaftTcpTransport ────────────────────────────────────────────────────

const mockSendToPeer = vi.fn();
let mockHandlers: Array<(msg: any, fromPeerId: string) => void> = [];

vi.mock('../../consensus/transport/RaftTcpTransport', () => ({
  RaftTcpTransport: class {
    sendToPeer = mockSendToPeer;
    on(event: string, cb: any) {
      if (event === 'message') mockHandlers.push(cb);
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    waitForConnections = vi.fn().mockResolvedValue(undefined);
  },
}));

// ── SUT ──────────────────────────────────────────────────────────────────────

import { BatchedRaftTransport } from '../../consensus/transport/BatchedRaftTransport';
import { MessageCodec } from '../../consensus/transport/MessageCodec';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(overrides?: Partial<RPCMessage>): RPCMessage {
  return {
    type: 'AppendEntries',
    direction: 'request',
    payload: { term: 1, leaderId: '1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 },
    ...overrides,
  } as unknown as RPCMessage;
}

function makeResponseMsg(requestId: string, overrides?: Record<string, unknown>): any {
  return {
    requestId,
    msg: {
      type: 'AppendEntries',
      direction: 'response',
      payload: { term: 1, success: true, ...overrides },
    },
  };
}

function makeHandlerMsg(requestId?: string): any {
  return requestId
    ? {
        requestId,
        msg: {
          type: 'RequestVote',
          direction: 'request',
          payload: { term: 1, candidateId: '1', lastLogIndex: 0, lastLogTerm: 0 },
        },
      }
    : {
        type: 'RequestVote',
        direction: 'request',
        payload: { term: 1, candidateId: '1', lastLogIndex: 0, lastLogTerm: 0 },
      };
}

/** An InstallSnapshot request chunk as raft-core sends it. */
function snapshotChunk(offset: number, done: boolean): RPCMessage {
  return {
    type: 'InstallSnapshot',
    direction: 'request',
    payload: {
      term: 1,
      leaderId: '1',
      lastIncludedIndex: 12,
      lastIncludedTerm: 1,
      offset,
      done,
      data: Buffer.alloc(4, offset % 256),
      config: { voters: [], learners: [] },
    },
  } as unknown as RPCMessage;
}

function parseRequestId(call: any): string {
  const payload: Buffer = call[1];
  const json = payload.subarray(5).toString('utf-8');
  return JSON.parse(json).requestId;
}

function simulateIncoming(msg: any, fromPeerId = '2'): void {
  for (const h of mockHandlers) h(msg, fromPeerId);
}

describe('BatchedRaftTransport (Unit)', () => {
  let transport: BatchedRaftTransport;

  function createTransport(requestTimeoutMs = 200): BatchedRaftTransport {
    return new BatchedRaftTransport(
      {
        node: { id: 1, host: '127.0.0.1', port: 0 },
        peers: [{ id: 2, host: '127.0.0.1', port: 0 }],
        tls: { cert: '', key: '', ca: '' },
      },
      requestTimeoutMs,
    );
  }

  beforeEach(async () => {
    mockHandlers = [];
    mockSendToPeer.mockClear();
    transport = createTransport(200);
    await transport.start();
  });

  afterEach(async () => {
    try {
      await transport.stop();
    } catch {
      /* rejections from pending cleanup */
    }
    // Wait for any lingering microtasks (stop() rejections) to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  // ── AC 8.1: Concurrent 100 RPCs ──────────────────────────────────────

  it('AC 8.1 — resolves 100 concurrent send() with correct response mapping', async () => {
    const promises: Promise<RPCMessage>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(transport.send('2', makeMsg()));
    }

    // Allow microtasks to flush so requestIds are assigned
    await new Promise((r) => setImmediate(r));

    expect(mockSendToPeer).toHaveBeenCalledTimes(100);

    // Extract requestIds and verify uniqueness
    const requestIds = mockSendToPeer.mock.calls.map(parseRequestId);
    expect(new Set(requestIds).size).toBe(100);
    expect(requestIds.length).toBe(100);

    // Respond to each request with a unique value
    for (let i = 0; i < 100; i++) {
      simulateIncoming(makeResponseMsg(requestIds[i]!, { matchIndex: i }));
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 100; i++) {
      expect((results[i] as any).payload.matchIndex).toBe(i);
    }
  }, 10000);

  // ── AC 8.2: Timeout ──────────────────────────────────────────────────

  it('AC 8.2 — send() rejects with timeout error after configurable delay', async () => {
    const sendPromise = transport.send('2', makeMsg());
    await expect(sendPromise).rejects.toThrow(/timeout/i);
  }, 10000);

  // ── AC 8.3: Transport stop cleanup ───────────────────────────────────

  it('AC 8.3 — stop() rejects all pending promises', async () => {
    const promises: Promise<RPCMessage>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(transport.send('2', makeMsg()));
    }

    await new Promise((r) => setImmediate(r));
    expect(mockSendToPeer).toHaveBeenCalledTimes(10);

    // Wait a tiny bit for timers to register, then stop
    await transport.stop();

    const results = await Promise.allSettled(promises);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBe(10);
    for (const r of rejected) {
      if (r.status === 'rejected') expect(r.reason.message).toMatch(/stopped/i);
    }
  }, 10000);

  // ── AC 8.4: requestId uniqueness ────────────────────────────────────

  it('AC 8.4 — no requestId collision in 10000 consecutive calls', async () => {
    for (let i = 0; i < 10000; i++) {
      transport.send('2', makeMsg()).catch(() => {});
    }
    await new Promise((r) => setImmediate(r));

    expect(mockSendToPeer).toHaveBeenCalledTimes(10000);

    const requestIds = mockSendToPeer.mock.calls.map(parseRequestId);
    expect(new Set(requestIds).size).toBe(10000);
  }, 15000);

  // ── AC 8.5: direction=response routing ──────────────────────────────

  it('AC 8.5 — response message routed to correct pending request', async () => {
    const sendPromise = transport.send('2', makeMsg());
    await new Promise((r) => setImmediate(r));

    const requestId = parseRequestId(mockSendToPeer.mock.calls[0]);

    simulateIncoming(makeResponseMsg(requestId, { success: true }));

    const result = await sendPromise;
    expect((result as any).payload.success).toBe(true);
  }, 5000);

  // ── AC 8.6: Handler error resilience ────────────────────────────────

  it('AC 8.6 — handler rejection does not crash transport', async () => {
    const handler: MessageHandler = async () => {
      throw new Error('Handler failure');
    };
    transport.onMessage(handler);

    // Simulate incoming request — should not crash
    expect(() => simulateIncoming(makeHandlerMsg('req-1'), '2')).not.toThrow();

    // Transport should still be usable for sending
    transport.send('2', makeMsg()).catch(() => {}); // fire-and-forget, will be cleaned by afterEach
    await new Promise((r) => setImmediate(r));
    expect(mockSendToPeer).toHaveBeenCalled();
  }, 5000);

  // ── AC 8.7: Multiple concurrent requests ────────────────────────────

  it('AC 8.7 — multiple concurrent requests each get correct response', async () => {
    const count = 20;
    const promises: Promise<RPCMessage>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(transport.send('2', makeMsg()));
    }

    await new Promise((r) => setImmediate(r));
    expect(mockSendToPeer).toHaveBeenCalledTimes(count);

    const requestIds = mockSendToPeer.mock.calls.map(parseRequestId);
    expect(requestIds.length).toBe(count);

    // Respond to each with its own index
    for (let i = 0; i < count; i++) {
      simulateIncoming(makeResponseMsg(requestIds[i]!, { index: i }));
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < count; i++) {
      expect((results[i] as any).payload.index).toBe(i);
    }
  }, 10000);

  // ── AC 8.8: Response after timeout ──────────────────────────────────

  it('AC 8.8 — response after timeout is ignored', async () => {
    const sendPromise = transport.send('2', makeMsg());
    await new Promise((r) => setImmediate(r));

    const requestId = parseRequestId(mockSendToPeer.mock.calls[0]);

    // Wait for timeout
    await expect(sendPromise).rejects.toThrow(/timeout/i);

    // Response arrives late — should not crash
    expect(() => simulateIncoming(makeResponseMsg(requestId, { success: true }))).not.toThrow();
  }, 10000);

  // ── AC 8.9: isStarted() lifecycle ───────────────────────────────────

  it('AC 8.9 — isStarted() reflects lifecycle', async () => {
    // Stop the beforeEach one
    await transport.stop().catch(() => {});

    const t = createTransport(200);
    expect(t.isStarted()).toBe(false);

    await t.start();
    expect(t.isStarted()).toBe(true);

    // Idempotent start
    await t.start();
    expect(t.isStarted()).toBe(true);

    await t.stop();
    expect(t.isStarted()).toBe(false);
  }, 5000);

  it('frames an InstallSnapshot chunk as bytes, so the peer can install it', async () => {
    // The batch frame is built by `MessageCodec`. It used to be built here with a
    // local copy of the header and a bare `JSON.stringify`, which turned the
    // chunk's `data` into `{type: 'Buffer', data: […]}`: a plain object whose
    // `.length` is `undefined`. raft-core drops such a chunk
    // (`if (request.data.length > 0)`) and the follower never installs a
    // snapshot, so this asserts the wire bytes, not the in-memory object.
    const chunk = Buffer.from([0, 1, 2, 250, 255]);
    void transport
      .send('2', {
        type: 'InstallSnapshot',
        direction: 'request',
        payload: {
          term: 1,
          leaderId: '1',
          lastIncludedIndex: 9,
          lastIncludedTerm: 1,
          offset: 0,
          done: true,
          data: chunk,
        },
      } as unknown as RPCMessage)
      .catch(() => undefined);

    await new Promise((resolve) => setImmediate(resolve));
    const frame = mockSendToPeer.mock.calls[0]![1] as Buffer;
    const decoded = MessageCodec.decode<{ msg: { payload: { data: Buffer } } }>(frame.subarray(4));

    expect(Buffer.isBuffer(decoded.msg.payload.data)).toBe(true);
    expect(decoded.msg.payload.data.equals(chunk)).toBe(true);
  });

  // ── AC 38.1–38.5: one snapshot transfer per peer ────────────────────

  it('AC 38.1 — refuses a second snapshot transfer while one is in progress', async () => {
    // raft-core starts `sendSnapshot` from its heartbeat loop, which does not
    // await peers and holds no per-peer guard. A second transfer's first chunk
    // resets the receiver's chunk assembly (`offset === 0`), so the accepted
    // transfer's next chunk arrives at an offset the receiver no longer expects
    // and both fail. Refusing the newcomer is the only outcome that lets the
    // snapshot arrive at all.
    const first = transport.send('2', snapshotChunk(0, false)).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(transport.send('2', snapshotChunk(0, true))).rejects.toThrow(/second snapshot transfer/i);
    // The refusal is local: nothing competing went on the wire.
    expect(mockSendToPeer).toHaveBeenCalledTimes(1);

    await transport.stop();
    await first;
  }, 5000);

  it('AC 38.2 — the accepted transfer keeps sending its later chunks', async () => {
    const first = transport.send('2', snapshotChunk(0, false)).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const second = transport.send('2', snapshotChunk(4096, false)).catch(() => undefined);
    const third = transport.send('2', snapshotChunk(8192, true)).catch(() => undefined);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSendToPeer).toHaveBeenCalledTimes(3);

    await transport.stop();
    await Promise.all([first, second, third]);
  }, 5000);

  it('AC 38.3 — a finished transfer releases the peer immediately', async () => {
    const done = transport.send('2', snapshotChunk(0, true));
    await new Promise((resolve) => setImmediate(resolve));
    const requestId = parseRequestId(mockSendToPeer.mock.calls[0]!);
    simulateIncoming({
      requestId,
      msg: { type: 'InstallSnapshot', direction: 'response', payload: { term: 1, success: true } },
    });
    await expect(done).resolves.toBeDefined();

    // The next transfer starts from offset 0 again: this is what a retry after a
    // successful install looks like when the follower is still behind.
    const retry = transport.send('2', snapshotChunk(0, true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSendToPeer).toHaveBeenCalledTimes(2);
    await transport.stop();
    await retry.catch(() => undefined);
  }, 5000);

  it('AC 38.4 — a failed chunk releases the peer so the retry can start over', async () => {
    const failed = transport.send('2', snapshotChunk(0, false));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(failed).rejects.toThrow(/timeout/i);

    // No claim may outlive the transfer it belonged to: the leader aborts on a
    // failed chunk and retries from offset 0 on the next heartbeat.
    const retry = transport.send('2', snapshotChunk(0, true)).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSendToPeer).toHaveBeenCalledTimes(2);
    await transport.stop();
    await retry;
  }, 10_000);

  it('AC 38.5 — a claim left idle past the lease does not block a new transfer', async () => {
    // A leader can be left holding a transfer it never finished (it stepped down
    // between chunks). Without an expiry that abandoned claim would block every
    // future snapshot to the peer for the life of the process.
    const stale = transport.send('2', snapshotChunk(0, false));
    await new Promise((resolve) => setImmediate(resolve));
    const requestId = parseRequestId(mockSendToPeer.mock.calls[0]!);
    simulateIncoming({
      requestId,
      msg: { type: 'InstallSnapshot', direction: 'response', payload: { term: 1, success: true } },
    });
    await expect(stale).resolves.toBeDefined();

    // requestTimeoutMs is 200 in this suite, so the lease is 400ms.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const fresh = transport.send('2', snapshotChunk(0, true)).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSendToPeer).toHaveBeenCalledTimes(2);
    await transport.stop();
    await fresh;
  }, 10_000);

  // ── AC 8.10: sendToPeer with invalid peerId ─────────────────────────

  it('AC 8.10 — send() with invalid peerId rejects', async () => {
    await expect(transport.send('not-a-number', makeMsg())).rejects.toThrow(/invalid peer/i);
    await expect(transport.send('', makeMsg())).rejects.toThrow(/invalid peer/i);
  }, 5000);
});
