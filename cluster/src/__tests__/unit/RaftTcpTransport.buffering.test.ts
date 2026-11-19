/**
 * RaftTcpTransport — frame buffering: the cap, the flush, and what happens when
 * a flush fails.
 *
 * Iteration 51 removed `ConnectionPool.sendTo()` / `broadcast()`, the second
 * send path nobody called. The pool's pending queue went with them, so the
 * transport's buffer is the only one left and has to carry the properties the
 * dead queue claimed: a bound, a policy for what is discarded, and a record of
 * every discard. These cases pin those properties, and the retry the flush used
 * to skip — before this iteration a write failure during a flush destroyed both
 * the socket and the frames the buffer had just been drained of.
 *
 *   AC 34.72: a peer's buffer stops at 1024 frames, evicting the oldest, and
 *             every eviction is counted and emitted
 *   AC 34.73: the retained window is the newest frames, in order
 *   AC 34.74: a successful flush writes in order, clears the buffer and clears
 *             the failure counter
 *   AC 34.75: a failed flush re-buffers the undelivered tail at the head, keeps
 *             its order, loses nothing, and closes the socket
 *   AC 34.76: after MAX_FLUSH_ATTEMPTS failures the batch is dropped in the open
 *             (counted + emitted as `flush-failed`) rather than retried forever
 *   AC 34.77: re-buffering obeys the same cap, so a full buffer cannot grow
 *   AC 34.78: getStatus() publishes the buffer depth per peer and the drop count
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const poolInstances: any[] = [];
  const poolCtor = vi.fn((_opts: any) => {
    const inst = {
      tryGetConnection: vi.fn(() => null),
      getConnection: vi.fn(async () => ({ write: vi.fn(async () => {}) })),
      onIncoming: vi.fn(async () => null),
      addNode: vi.fn(),
      removeNode: vi.fn(),
      stop: vi.fn(async () => {}),
      getCircuitBreakerMetrics: vi.fn(() => []),
      connectedPeers: [],
      onConnectionCreated: null as null | ((peerId: number, conn: any) => void),
    };
    poolInstances.push(inst);
    return inst;
  });

  const tlsState = {
    createServer: vi.fn(() => {
      const server: any = {
        on: vi.fn(),
        once: vi.fn((_ev: string, cb: () => void) => cb()),
        listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
        address: vi.fn(() => ({ port: 9001 })),
        close: vi.fn((cb?: () => void) => cb?.()),
      };
      return server;
    }),
  };

  return { poolCtor, poolInstances, tlsState };
});

vi.mock('node:tls', () => ({
  default: { createServer: mocks.tlsState.createServer },
}));

vi.mock('../../consensus/transport/ConnectionPool', () => ({
  ConnectionPool: mocks.poolCtor,
}));

import { RaftTcpTransport } from '../../consensus/transport/RaftTcpTransport';
import type { FramesDroppedEvent } from '../../consensus/transport/RaftTcpTransport';

const CAP = 1024;

function validConfig(): any {
  return {
    node: { id: 1, host: '127.0.0.1', port: 9001 },
    peers: [
      { id: 2, host: '127.0.0.1', port: 9002 },
      { id: 3, host: '127.0.0.1', port: 9003 },
    ],
    tls: { cert: 'CERT', key: 'KEY', ca: 'CA' },
  };
}

function priv(t: RaftTcpTransport): any {
  return t as any;
}

function frame(label: string): Buffer {
  return Buffer.from(label, 'utf-8');
}

/** A connection double that records the order of its writes. */
function connection(write: (data: Buffer) => Promise<void> = async () => {}): any {
  return { write: vi.fn(write), close: vi.fn() };
}

beforeEach(() => {
  mocks.poolInstances.length = 0;
  mocks.poolCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A started transport whose pool never reports a live connection. */
async function transport(): Promise<RaftTcpTransport> {
  const t = new RaftTcpTransport(validConfig());
  await t.start();
  priv(t).pool.tryGetConnection = vi.fn(() => null);
  return t;
}

describe('AC 34.72: the buffer is bounded per peer', () => {
  it('stops at 1024 frames, evicts the oldest, and counts each eviction', async () => {
    const t = await transport();
    const dropped: FramesDroppedEvent[] = [];
    t.on('frames-dropped', (e: FramesDroppedEvent) => dropped.push(e));

    const overflow = 6;
    const total = CAP + overflow;
    for (let i = 0; i < total; i++) {
      priv(t)._doSendFrame(2, frame(`f${i}`), false);
    }

    expect(priv(t)._pendingMessages.get(2)).toHaveLength(CAP);
    expect(t.getStatus().bufferedFrames[2]).toBe(CAP);
    expect(t.getStatus().droppedFrames).toBe(overflow);
    expect(dropped).toHaveLength(overflow);
    expect(dropped[0]).toMatchObject({ peerId: 2, count: 1, reason: 'buffer-full' });
    // One `count` per eviction, not one per frame in the batch.
    expect(dropped.reduce((sum, e) => sum + e.count, 0)).toBe(overflow);

    await t.stop();
  });

  it('keeps one peer’s overflow from touching another peer’s buffer', async () => {
    const t = await transport();
    for (let i = 0; i < CAP + 1; i++) {
      priv(t)._doSendFrame(2, frame(`f${i}`), false);
    }
    priv(t)._doSendFrame(3, frame('only'), false);

    expect(t.getStatus().bufferedFrames).toEqual({ 2: CAP, 3: 1 });
    expect(priv(t)._pendingMessages.get(3)![0]).toEqual(frame('only'));

    await t.stop();
  });
});

describe('AC 34.73: which frames survive the cap', () => {
  it('retains the newest window, in order', async () => {
    const t = await transport();
    for (let i = 0; i < CAP + 3; i++) {
      priv(t)._doSendFrame(2, frame(`f${i}`), false);
    }

    const kept = priv(t)._pendingMessages.get(2)!;
    // The three oldest went; f3 is the new head and the order is unchanged.
    expect(kept[0]).toEqual(frame('f3'));
    expect(kept[CAP - 1]).toEqual(frame(`f${CAP + 2}`));

    await t.stop();
  });

  it('never buffers a heartbeat — a dropped one is retried by the next tick', async () => {
    const t = await transport();
    priv(t)._doSendFrame(2, frame('hb'), true);
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    await t.stop();
  });
});

describe('AC 34.74: a flush that works', () => {
  it('writes in order, clears the buffer and clears the failure counter', async () => {
    const t = await transport();
    priv(t)._pendingMessages.set(2, [frame('a'), frame('b'), frame('c')]);
    priv(t)._flushAttempts.set(2, 2);
    const conn = connection();

    priv(t)._flushPending(2, conn);

    await vi.waitFor(() => expect(conn.write).toHaveBeenCalledTimes(3));
    expect(conn.write.mock.calls.map((c: any[]) => c[0].toString())).toEqual(['a', 'b', 'c']);
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    await vi.waitFor(() => expect(priv(t)._flushAttempts.has(2)).toBe(false));
    expect(conn.close).not.toHaveBeenCalled();
    expect(t.getStatus().droppedFrames).toBe(0);

    await t.stop();
  });

  it('does nothing when the peer has no buffered frames', async () => {
    const t = await transport();
    const conn = connection();
    priv(t)._flushPending(2, conn);
    expect(conn.write).not.toHaveBeenCalled();
    await t.stop();
  });
});

describe('AC 34.75: a flush that fails keeps the frames', () => {
  it('re-buffers the undelivered tail at the head, in order, and closes the socket', async () => {
    const t = await transport();
    priv(t)._pendingMessages.set(2, [frame('a'), frame('b'), frame('c')]);
    let calls = 0;
    const conn = connection(async () => {
      calls += 1;
      if (calls === 2) throw new Error('socket gone');
    });

    priv(t)._flushPending(2, conn);

    await vi.waitFor(() => expect(conn.close).toHaveBeenCalled());
    // 'a' reached the socket; 'b' and 'c' did not and are back where they were.
    const kept = priv(t)._pendingMessages.get(2)!;
    expect(kept.map((b: Buffer) => b.toString())).toEqual(['b', 'c']);
    expect(priv(t)._flushAttempts.get(2)).toBe(1);
    expect(t.getStatus().droppedFrames).toBe(0);
    expect(t.getStatus().bufferedFrames[2]).toBe(2);

    await t.stop();
  });

  it('records one verdict per batch even when every write rejects', async () => {
    const t = await transport();
    priv(t)._pendingMessages.set(2, [frame('a'), frame('b'), frame('c')]);
    const conn = connection(async () => {
      throw new Error('socket gone');
    });

    priv(t)._flushPending(2, conn);

    await vi.waitFor(() => expect(conn.close).toHaveBeenCalled());
    expect(priv(t)._flushAttempts.get(2)).toBe(1);
    // Three rejections, one re-buffer: the batch is not triplicated.
    expect(
      priv(t)
        ._pendingMessages.get(2)!
        .map((b: Buffer) => b.toString()),
    ).toEqual(['a', 'b', 'c']);

    await t.stop();
  });
});

describe('AC 34.76: retries are bounded', () => {
  it('drops the batch in the open after three failed flush attempts', async () => {
    const t = await transport();
    const dropped: FramesDroppedEvent[] = [];
    t.on('frames-dropped', (e: FramesDroppedEvent) => dropped.push(e));

    const failing = connection(async () => {
      throw new Error('socket gone');
    });
    priv(t)._pendingMessages.set(2, [frame('a')]);

    // Attempt 1 and 2 put the batch back; attempt 3 gives up on it.
    for (let attempt = 1; attempt <= 3; attempt++) {
      priv(t)._flushPending(2, failing);
      await vi.waitFor(() => expect(failing.close).toHaveBeenCalledTimes(attempt));
    }

    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    expect(t.getStatus().droppedFrames).toBe(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ peerId: 2, count: 1, reason: 'flush-failed' });
    // The counter resets, so the peer's next batch starts with a clean slate.
    expect(priv(t)._flushAttempts.has(2)).toBe(false);

    await t.stop();
  });

  it('a success between failures resets the count, so a flaky peer is not dropped', async () => {
    const t = await transport();
    const failing = connection(async () => {
      throw new Error('socket gone');
    });

    priv(t)._pendingMessages.set(2, [frame('a')]);
    priv(t)._flushPending(2, failing);
    await vi.waitFor(() => expect(failing.close).toHaveBeenCalledTimes(1));
    priv(t)._flushPending(2, failing);
    await vi.waitFor(() => expect(failing.close).toHaveBeenCalledTimes(2));
    expect(priv(t)._flushAttempts.get(2)).toBe(2);

    const working = connection();
    priv(t)._flushPending(2, working);
    await vi.waitFor(() => expect(priv(t)._flushAttempts.has(2)).toBe(false));
    expect(t.getStatus().droppedFrames).toBe(0);

    // Two more failures would have exhausted the budget had the success not counted.
    priv(t)._pendingMessages.set(2, [frame('b')]);
    priv(t)._flushPending(2, failing);
    await vi.waitFor(() => expect(priv(t)._flushAttempts.get(2)).toBe(1));

    await t.stop();
  });
});

describe('AC 34.77: re-buffering obeys the cap', () => {
  it('does not grow past the cap when frames arrive while a flush is in flight', async () => {
    const t = await transport();
    const dropped: FramesDroppedEvent[] = [];
    t.on('frames-dropped', (e: FramesDroppedEvent) => dropped.push(e));

    for (let i = 0; i < CAP; i++) {
      priv(t)._doSendFrame(2, frame(`f${i}`), false);
    }
    const conn = connection(async () => {
      throw new Error('socket gone');
    });

    // The flush drains the buffer and issues its writes; a live leader keeps
    // proposing in the same tick, so the fresh buffer already has frames in it
    // by the time the rejection arrives.
    priv(t)._flushPending(2, conn);
    priv(t)._doSendFrame(2, frame('n0'), false);
    priv(t)._doSendFrame(2, frame('n1'), false);

    await vi.waitFor(() => expect(conn.close).toHaveBeenCalledTimes(1));

    const kept = priv(t)._pendingMessages.get(2)!;
    expect(kept).toHaveLength(CAP);
    // The cap kept the newest, so the two oldest of the failed batch went.
    expect(kept[0]).toEqual(frame('f2'));
    expect(kept[CAP - 1]).toEqual(frame('n1'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ count: 2, reason: 'buffer-full' });
    expect(t.getStatus().droppedFrames).toBe(2);

    await t.stop();
  });
});

describe('AC 34.78: the counters are published', () => {
  it('reports buffer depth per peer and the monotonic drop count', async () => {
    const t = await transport();
    expect(t.getStatus()).toMatchObject({ bufferedFrames: {}, droppedFrames: 0 });

    priv(t)._doSendFrame(2, frame('a'), false);
    priv(t)._doSendFrame(3, frame('b'), false);
    expect(t.getStatus().bufferedFrames).toEqual({ 2: 1, 3: 1 });

    for (let i = 0; i < CAP + 2; i++) {
      priv(t)._doSendFrame(2, frame(`x${i}`), false);
    }
    // One frame plus CAP + 2 more is one past the cap, so three were evicted.
    expect(t.getStatus()).toMatchObject({ bufferedFrames: { 2: CAP, 3: 1 }, droppedFrames: 3 });

    // Discards are not undone by a later flush: the count is a record, not a gauge.
    priv(t)._flushPending(2, connection());
    await vi.waitFor(() => expect(t.getStatus().bufferedFrames).toEqual({ 3: 1 }));
    expect(t.getStatus().droppedFrames).toBe(3);

    await t.stop();
  });
});

describe('AC 34.79: the failure paths around delivery are reported, not swallowed', () => {
  it('a frame that fails to decode emits decode-error for its peer', async () => {
    const t = await transport();
    const errors: Array<{ peerId: number; error: unknown }> = [];
    t.on('decode-error', (e: { peerId: number; error: unknown }) => errors.push(e));
    priv(t)._processData = vi.fn(() => Promise.reject(new Error('bad frame')));

    let onData: ((data: Buffer) => void) | null = null;
    const conn = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') onData = cb;
      }),
      write: vi.fn(async () => {}),
    };
    priv(t).pool.onConnectionCreated(2, conn);
    expect(onData).not.toBeNull();

    (onData as unknown as (data: Buffer) => void)(Buffer.from('garbage'));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.peerId).toBe(2);

    await t.stop();
  });

  it('reports connect-error when the first dial to a peer throws', async () => {
    const t = new RaftTcpTransport(validConfig());
    const errors: Array<{ peerId: number }> = [];
    t.on('connect-error', (e: { peerId: number }) => errors.push(e));
    // start() dials every peer once; a rejecting dial must be reported, not
    // left as an unhandled rejection inside start()'s loop.
    vi.spyOn(priv(t), '_initiateConnection').mockRejectedValue(new Error('dial refused'));

    await t.start();

    await vi.waitFor(() => expect(errors.length).toBe(2));
    expect(errors.map((e) => e.peerId).sort()).toEqual([2, 3]);

    await t.stop();
  });

  it('the health check retries a peer with no live connection, and says so when the retry fails', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    priv(t).pool.tryGetConnection = vi.fn(() => null);
    const dial = vi.spyOn(priv(t), '_initiateConnection').mockRejectedValue(new Error('still refused'));

    vi.advanceTimersByTime(500);
    // The timer's own catch is what a background failure has instead of a caller.
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('Health check reconnect failed'))).toBe(true),
    );
    expect(dial).toHaveBeenCalled();

    vi.useRealTimers();
    warn.mockRestore();
    await t.stop();
  });
});
