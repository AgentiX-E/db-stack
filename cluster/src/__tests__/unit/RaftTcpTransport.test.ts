/**
 * RaftTcpTransport — Unit Tests
 *
 * Strategy: Test ONLY public API surface that doesn't start() the transport.
 * No _processData tests (requires TLS module which hangs the fork).
 * No async Promise-based event tests (vitest fork timer issue).
 *
 * Acceptance Criteria:
 *   AC 32.1: Constructor config / self + peer registration
 *   AC 32.2: register() node management
 *   AC 32.3: getStatus() before start
 *   AC 32.4: getCircuitBreakerMetrics() when pool is null
 *   AC 32.5: sendToPeer() is no-op when stopped
 *   AC 32.6: send() is no-op when stopped
 *   AC 32.10: TLS config validation (start() throws)
 *   AC 32.11: unregister() forgets a peer, its queue and its socket
 *   AC 32.12: unregister() refuses to forget this node itself
 *   AC 32.13: awaitPeerConnection() answers from the pool, within its budget
 *   AC 32.14: awaitPeerConnection() is false without a pool or when dials keep failing
 *   AC 32.15: a stop ends a wait that is in flight, rather than the budget ending it
 *   AC 32.16: a wait begun while the pool is shutting down does not dial it
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RaftTcpTransport, type RaftNodeConfig } from '../../consensus/transport/RaftTcpTransport';
import { MessageCodec } from '../../consensus/transport/MessageCodec';
import { bounded } from '../support/awaitBound';

/**
 * Start and stop, bounded.
 *
 * Both are promises the product resolves, which means both are promises a mutation
 * can leave unresolved — and a case that waits on one of those is a case the runner
 * has to time out instead of one that fails. `bounded` makes the difference visible
 * (see `../support/awaitBound`).
 */
const startWithin = (t: RaftTcpTransport) => bounded(t.start(), 'transport.start()');
const stopWithin = (t: RaftTcpTransport) => bounded(t.stop(), 'transport.stop()');

function validConfig(overrides: any = {}) {
  return {
    node: { id: 1, host: '127.0.0.1', port: 9001 },
    peers: [
      { id: 2, host: '127.0.0.1', port: 9002 },
      { id: 3, host: '127.0.0.1', port: 9003 },
    ],
    tls: {
      cert: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
      key: '-----BEGIN KEY-----\nMOCK\n-----END KEY-----',
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    },
    ...overrides,
  };
}

describe('AC 32.1: Constructor', () => {
  it('stores config and registers self + peers', () => {
    const t = new RaftTcpTransport(validConfig());
    expect(t).toBeInstanceOf(RaftTcpTransport);
    expect(t).toBeInstanceOf(EventEmitter);
    expect(t.getStatus().totalPeers).toBe(2);
    expect(t.getStatus().started).toBe(false);
  });

  it('accepts empty peers', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    expect(t.getStatus().totalPeers).toBe(0);
  });
});

describe('AC 32.2: register()', () => {
  it('adds a node', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    t.register({ id: 5, host: '10.0.0.5', port: 9005 });
    expect(t.getStatus().totalPeers).toBe(1);
  });

  it('updates existing node', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [{ id: 2, host: 'old', port: 9002 }] }));
    t.register({ id: 2, host: 'new', port: 9999 });
    expect(t.getStatus().totalPeers).toBe(1);
  });
});

describe('AC 32.3: getStatus()', () => {
  it('returns correct initial state, including the transport’s own counters', () => {
    const t = new RaftTcpTransport(validConfig());
    expect(t.getStatus()).toEqual({
      connectedPeers: [],
      totalPeers: 2,
      started: false,
      bufferedFrames: {},
      droppedFrames: 0,
    });
  });
});

describe('AC 32.4: getCircuitBreakerMetrics()', () => {
  it('returns [] when pool is null', () => {
    expect(new RaftTcpTransport(validConfig()).getCircuitBreakerMetrics()).toEqual([]);
  });
});

describe('AC 32.5: sendToPeer()', () => {
  it('no-op when stopped', () => {
    expect(() => new RaftTcpTransport(validConfig()).sendToPeer(2, Buffer.from('x'))).not.toThrow();
  });

  it('no-op after stop()', async () => {
    const t = new RaftTcpTransport(validConfig());
    await stopWithin(t);
    expect(() => t.sendToPeer(2, Buffer.from('x'))).not.toThrow();
  });
});

describe('AC 32.6: send()', () => {
  it('no-op when stopped', async () => {
    await expect(
      new RaftTcpTransport(validConfig()).send(1, [{ msgType: 0, from: '1', to: '2', term: '1' }]),
    ).resolves.toBeUndefined();
  });

  it('skips self messages', async () => {
    const t = new RaftTcpTransport(validConfig());
    await expect(t.send(1, [{ msgType: 0, from: '1', to: '1', term: '1' }])).resolves.toBeUndefined();
  });
});

describe('AC 32.10: TLS config validation', () => {
  it('rejects empty cert', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: '', key: 'k', ca: 'c' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
  it('rejects empty key', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: 'c', key: '', ca: 'c' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
  it('rejects empty ca', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: 'c', key: 'k', ca: '' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
});

describe('AC 32.11–32.14: peer lifecycle', () => {
  function withPool(t: RaftTcpTransport, pool: any): RaftTcpTransport {
    (t as any).pool = pool;
    return t;
  }

  it('AC 32.11 — unregister forgets the peer, its buffered frames and its socket', () => {
    const t = new RaftTcpTransport(validConfig());
    const removeNode = vi.fn();
    withPool(t, { removeNode });
    (t as any)._pendingMessages.set(2, [Buffer.from('queued')]);

    t.unregister(2);

    expect(t.getStatus().totalPeers).toBe(1);
    expect(removeNode).toHaveBeenCalledWith(2);
    expect((t as any)._pendingMessages.has(2)).toBe(false);
  });

  it('AC 32.12 — unregister refuses to forget this node itself', () => {
    const t = new RaftTcpTransport(validConfig());
    const removeNode = vi.fn();
    withPool(t, { removeNode });

    t.unregister(1);

    // Forgetting self would make `_getPeerList()` list the node as its own peer.
    expect(removeNode).not.toHaveBeenCalled();
    expect(t.getStatus().totalPeers).toBe(2);
  });

  it('AC 32.13 — awaitPeerConnection answers from the pool', async () => {
    const t = new RaftTcpTransport(validConfig());
    withPool(t, { getConnection: vi.fn(async () => ({ connected: true })) });

    await expect(bounded(t.awaitPeerConnection(2, 50), 'awaitPeerConnection')).resolves.toBe(true);
  });

  it('AC 32.14 — awaitPeerConnection is false without a pool, and after the budget on failures', async () => {
    const noPool = new RaftTcpTransport(validConfig());
    await expect(bounded(noPool.awaitPeerConnection(2, 50), 'awaitPeerConnection')).resolves.toBe(false);

    const t = new RaftTcpTransport(validConfig());
    const getConnection = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    withPool(t, { getConnection, stop: vi.fn(async () => undefined) });
    const startedAt = Date.now();

    try {
      await expect(bounded(t.awaitPeerConnection(2, 120), 'awaitPeerConnection')).resolves.toBe(false);
      // It retried inside the budget instead of trusting one refusal.
      expect(getConnection.mock.calls.length).toBeGreaterThan(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    } finally {
      // A wait that outlived its budget while the transport was live keeps retrying
      // after the case that noticed it has ended, because the step is a timer and
      // timers hold the event loop. `_stopped` is what ends one, so the case ends the
      // transport whether it passed or failed: a mutant that never lets the budget
      // expire would otherwise leave a chain nothing owns, and the run outlives the
      // verdict (P3-75).
      await stopWithin(t);
    }
  });

  it('AC 32.15 — a transport stopped mid-wait answers false instead of spending the rest of the budget', async () => {
    // The member-add path calls this while a shutdown may be in flight. A wait that
    // outlives the transport it is waiting on is a caller held for a socket nothing
    // will open, and on a leader that is re-elected it is a stale dial competing with
    // the new one.
    const t = new RaftTcpTransport(validConfig());
    const getConnection = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    withPool(t, { getConnection, stop: vi.fn(async () => undefined) });

    const pending = t.awaitPeerConnection(2, 30_000);
    // Let the first attempt fail and the step into the budget begin.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stoppedAt = Date.now();
    await stopWithin(t);

    await expect(pending).resolves.toBe(false);
    // Milliseconds, not the remaining 29.9 s: the answer came from the stop, and
    // the difference is what a membership change waits through on a draining node.
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  });

  it('AC 32.16 — a wait begun while the pool is shutting down does not dial it', async () => {
    // `stop()` lowers the flag before it awaits the pool, and the pool closes its
    // sockets after — so between the two there is a window in which the pool exists
    // and is on its way out. A dial in that window is a connection created against a
    // transport that has already answered "stopped", which is the one state the
    // shutdown order exists to avoid.
    const t = new RaftTcpTransport(validConfig());
    const getConnection = vi.fn(async () => ({ connected: true }));
    let finishPoolStop!: () => void;
    const poolStopped = new Promise<void>((resolve) => {
      finishPoolStop = resolve;
    });
    withPool(t, { getConnection, stop: () => poolStopped });

    const stopping = t.stop();
    // The pool is still here — `stop()` is waiting on it — and the transport is not.
    expect((t as any).pool).not.toBeNull();

    await expect(bounded(t.awaitPeerConnection(2, 60_000), 'awaitPeerConnection')).resolves.toBe(false);
    expect(getConnection).not.toHaveBeenCalled();

    finishPoolStop();
    await stopping;
  });
});
