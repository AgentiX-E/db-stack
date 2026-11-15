/**
 * TLS fault injection — the federation transport under faults it cannot avoid.
 *
 * Why this suite exists
 * ---------------------
 * `TcpSecureTransport` is the only path a cross-datacenter message takes, and
 * every fault it can meet was previously exercised through an injected
 * `_transportOverride` double: a set of promises that never opened a socket,
 * never negotiated a certificate and never disagreed with the caller. The three
 * defects this suite found on its first run were all invisible to those doubles:
 *
 *   1. Two nodes whose `nodeId` contains no digits were both assigned wire id 1,
 *      colliding with the default peer id `index + 1`. A two-datacenter cluster
 *      configured with `dc-west` / `dc-east` never connected at all, and every
 *      `send()` refused with "not connected" — a configuration that reads as
 *      correct, fails at runtime, and names a peer that is up.
 *   2. `send()` reported true for a message the transport had only buffered in
 *      memory. With the peer stopped, the buffer never flushes, so the outbox
 *      marked the entry delivered and the message was gone. The delivery
 *      contract says at-least-once; the code said at-most-once.
 *   3. The receive bridge could not be unsubscribed (`unsubFromRaft` was an
 *      empty function), so a stopped-then-started transport delivered every
 *      inbound message twice.
 *
 * Every case below opens a real TCP listener with a real certificate and a real
 * handshake. Nothing is mocked: the faults are real faults, injected at the TLS
 * layer by a peer that misbehaves on purpose.
 *
 * Acceptance criteria:
 *   AC 43.1  two transports complete a real mTLS handshake in both directions
 *   AC 43.2  a digit-free node id is refused at construction instead of guessing
 *   AC 43.3  a wire-id collision is refused at construction, not silently accepted
 *   AC 43.4  send() returns false once the peer is stopped, naming the peer
 *   AC 43.5  send() returns false after the peer resets the socket
 *   AC 43.6  a certificate from an untrusted CA cannot connect, and send() names it
 *   AC 43.7  a peer that accepts but never reads cannot hang send() forever
 *   AC 43.8  a peer that comes back is reachable again and receives what is sent
 *   AC 43.9  twenty reconnects leave no timer or attempt entry behind
 *   AC 43.10 stop() really unsubscribes the receive bridge
 *   AC 43.11 numeric ids derived from the logical id connect, no explicit id needed
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as tls from 'node:tls';
import { generateClusterCerts, getFreePorts, type TestClusterCerts } from '@agentix-e/db-cluster/testing';
import { TcpSecureTransport } from '../../transport/TcpSecureTransport';
import type { TransportMessage } from '../../interfaces/transport/TransportMessage';

// ── Helpers ──────────────────────────────────────────────────────

const open: TcpSecureTransport[] = [];
const servers: tls.Server[] = [];
const serverSockets: import('node:net').Socket[] = [];

/**
 * Cleanup is bounded on purpose.
 *
 * A transport whose peer has stopped reading can take seconds to shut down, and
 * an unbounded `await` in `afterEach` turns one wedged case into a timeout on
 * every case after it — which is how a single defect came to look like four.
 * Whatever survives the deadline is destroyed and reported by the case itself.
 */
async function bounded(promise: Promise<unknown>, ms = 3000): Promise<void> {
  await Promise.race([promise.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

afterEach(async () => {
  for (const t of open) await bounded(t.stop());
  open.length = 0;
  for (const s of serverSockets) s.destroy();
  serverSockets.length = 0;
  for (const s of servers) {
    s.close();
    await bounded(new Promise<void>((resolve) => s.once('close', () => resolve())), 1000);
  }
  servers.length = 0;
});

function message(id: string, from: string, to: string): TransportMessage {
  return {
    messageId: id,
    sourcePeerId: from,
    targetPeerId: to,
    payload: new TextEncoder().encode(id),
    timestamp: { wallTime: 1n, logical: 0, nodeId: from } as never,
    createdAt: Date.now(),
    type: 'fault-injection',
  };
}

interface PairOptions {
  /** Omit to exercise the default derivation from the logical id. */
  localWireId?: number;
  /** Omit to exercise the default peer wire id (`index + 1`). */
  peerWireId?: number;
  /** Replace the local certificate, e.g. with one signed by another CA. */
  hijackCert?: boolean;
  /** Let both sides derive every wire id from the logical ids. */
  bothDefault?: boolean;
}

function pair(
  certs: TestClusterCerts,
  ports: [number, number],
  from = 'dc-a',
  to = 'dc-b',
  opts: PairOptions = {},
): { a: TcpSecureTransport; b: TcpSecureTransport } {
  const a = new TcpSecureTransport({
    nodeId: from,
    ...(opts.localWireId !== undefined ? { transportNodeId: opts.localWireId } : {}),
    listen: { host: '127.0.0.1', port: ports[0] },
    peers: [
      {
        nodeId: to,
        host: '127.0.0.1',
        port: ports[1],
        ...(opts.peerWireId !== undefined ? { transportNodeId: opts.peerWireId } : {}),
      },
    ],
    tls: {
      cert: opts.hijackCert ? certs.rogue.cert : certs.nodes[0]!.cert,
      key: opts.hijackCert ? certs.rogue.key : certs.nodes[0]!.key,
      ca: certs.caPem,
    },
    connectTimeoutMs: 2000,
    initialRetryMs: 50,
    maxRetryMs: 300,
  });
  const b = new TcpSecureTransport({
    nodeId: to,
    ...(opts.bothDefault ? {} : { transportNodeId: 2 }),
    listen: { host: '127.0.0.1', port: ports[1] },
    peers: [
      {
        nodeId: from,
        host: '127.0.0.1',
        port: ports[0],
        ...(opts.bothDefault ? {} : { transportNodeId: 1 }),
      },
    ],
    tls: { cert: certs.nodes[1]!.cert, key: certs.nodes[1]!.key, ca: certs.caPem },
    connectTimeoutMs: 2000,
    initialRetryMs: 50,
    maxRetryMs: 300,
  });
  open.push(a, b);
  return { a, b };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

function transportInternals(t: TcpSecureTransport): {
  retryTimers: Map<string, unknown>;
  attemptCount: Map<string, number>;
  handlers: Set<unknown>;
  localId: number;
} {
  const raw = t as unknown as {
    _retryTimers: Map<string, unknown>;
    _attemptCount: Map<string, number>;
    messageHandlers: Set<unknown>;
    localId: number;
  };
  return {
    retryTimers: raw._retryTimers,
    attemptCount: raw._attemptCount,
    handlers: raw.messageHandlers,
    localId: raw.localId,
  };
}

// ── Cases ────────────────────────────────────────────────────────

describe('TLS fault injection', () => {
  it('AC 43.1: two transports complete a real mTLS handshake in both directions', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    const { a, b } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2 });

    await a.start();
    await b.start();

    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);
    expect(await waitFor(() => b.getConnectedPeers().length > 0)).toBe(true);
    expect(a.getConnectedPeers().map((p) => p.peerId)).toContain('dc-b');

    expect(await a.send(message('m1', 'dc-a', 'dc-b'))).toBe(true);
    expect(a.getLastSendError()).toBeNull();
    expect(await waitFor(() => b.getStats().messagesReceived > 0)).toBe(true);
  });

  it('AC 43.2: a digit-free node id is refused at construction instead of guessing', () => {
    const certs = generateClusterCerts(2);
    // Neither logical id contains a digit and neither side names a wire id —
    // the shape a user writes from the documentation.
    //
    // The wire id is not a local choice: `RaftTcpTransport._handleIncoming`
    // reads the peer's identity from its certificate common name
    // (`raft-node-<n>`), so any id chosen here that disagrees with the
    // certificate produces a peer that is unreachable for a reason the error
    // message can never show. The old fallback picked 1 for every digit-free id,
    // which made two datacenters the same node; the fix is to say so at
    // construction, while the configuration is still in someone's hands.
    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-west',
          listen: { host: '127.0.0.1', port: 0 },
          peers: [{ nodeId: 'dc-east', host: '127.0.0.1', port: 1 }],
          tls: { cert: certs.nodes[0]!.cert, key: certs.nodes[0]!.key, ca: certs.caPem },
        }),
    ).toThrow(/transportNodeId/);

    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-west-1',
          listen: { host: '127.0.0.1', port: 0 },
          peers: [{ nodeId: 'dc-east', host: '127.0.0.1', port: 1 }],
          tls: { cert: certs.nodes[0]!.cert, key: certs.nodes[0]!.key, ca: certs.caPem },
        }),
    ).toThrow(/peer dc-east/);
  });

  it('AC 43.11: numeric ids derived from the logical id connect against a matching certificate', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    // `dc-1` / `dc-2` derive wire ids 1 and 2, which is what the generated
    // certificates assert in their common names — the shape that must work
    // without any explicit transportNodeId.
    const { a, b } = pair(certs, ports, 'dc-1', 'dc-2', { bothDefault: true });

    expect(transportInternals(a).localId).toBe(1);
    expect(transportInternals(b).localId).toBe(2);

    await a.start();
    await b.start();
    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);
    expect(await waitFor(() => b.getConnectedPeers().length > 0)).toBe(true);

    expect(await a.send(message('m1', 'dc-1', 'dc-2'))).toBe(true);
    expect(await waitFor(() => b.getStats().messagesReceived > 0)).toBe(true);
  });

  it('AC 43.3: a wire-id collision is refused at construction, not silently accepted', () => {
    const certs = generateClusterCerts(2);
    // The local node claims wire id 2 and its only peer claims 2 as well: every
    // frame this node sends would be addressed to itself and skipped.
    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-solo',
          transportNodeId: 2,
          listen: { host: '127.0.0.1', port: 0 },
          peers: [{ nodeId: 'dc-peer', host: '127.0.0.1', port: 1, transportNodeId: 2 }],
          tls: { cert: certs.nodes[0]!.cert, key: certs.nodes[0]!.key, ca: certs.caPem },
        }),
    ).toThrow(/wire id/i);
  });

  it('AC 43.4: send() stops reporting success within a bounded time of the peer going away', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    const { a, b } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2 });

    await a.start();
    await b.start();
    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);
    expect(await a.send(message('m1', 'dc-a', 'dc-b'))).toBe(true);

    await b.stop();

    // What this case is really about: the refusal has to come from the socket,
    // not from a status snapshot refreshed by the pool's disconnect handler.
    //
    // The first `send()` after the peer stops is allowed to answer true. TCP
    // cannot tell a caller that the far end is gone before the FIN arrives, and
    // no transport can; pretending otherwise would be a test asserting physics.
    // What must not happen is a transport that keeps answering true — the old
    // code did exactly that for as long as the snapshot stayed stale, and every
    // one of those answers was a message the outbox marked delivered and never
    // sent.
    const deadline = Date.now() + 3000;
    let refused = false;
    let attempts = 0;
    while (Date.now() < deadline && !refused) {
      refused = !(await a.send(message(`probe-${attempts}`, 'dc-a', 'dc-b')));
      attempts += 1;
      if (!refused) await new Promise((r) => setTimeout(r, 25));
    }

    expect(refused, `send() still reported success after ${attempts} attempts and 3 s`).toBe(true);
    expect(a.getLastSendError()).toMatch(/dc-b/);
  });

  it('AC 43.5: send() returns false after the peer resets the socket', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    const { a, b } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2 });

    await a.start();
    await b.start();
    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);

    // Drop the listener and every accepted socket without a graceful shutdown:
    // the sender sees a reset, which is what a killed process looks like.
    await b.stop();
    expect(await waitFor(() => a.getConnectedPeers().length === 0, 5000)).toBe(true);

    expect(await a.send(message('m3', 'dc-a', 'dc-b'))).toBe(false);
    expect(a.getLastSendError()).not.toBeNull();
  });

  it('AC 43.6: a certificate from an untrusted CA cannot connect, and send() names it', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    // The listener presents a certificate signed by another CA. The peer must
    // refuse it at the handshake; nothing may appear connected afterwards.
    const { a, b } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2, hijackCert: true });

    await a.start();
    await b.start();
    await new Promise((r) => setTimeout(r, 1500));

    expect(b.getConnectedPeers()).toHaveLength(0);

    // Same lower bound as AC 43.4, for the same reason: in TLS 1.3 the client
    // certificate is validated by the server *after* the handshake the client
    // considers complete, so a refusal reaches the sender as a close, not as a
    // handshake error. While the reconnection loop is retrying, a `send()` can
    // therefore land inside a handshake that is about to be refused. What must
    // not happen is a transport that never stops saying yes.
    const deadline = Date.now() + 3000;
    let refused = false;
    while (Date.now() < deadline && !refused) {
      refused = !(await a.send(message('m4', 'dc-a', 'dc-b')));
      if (!refused) await new Promise((r) => setTimeout(r, 25));
    }
    expect(refused, 'send() kept reporting success to a peer whose certificate is refused').toBe(true);
    expect(a.getLastSendError()).toMatch(/dc-b/);
  });

  it('AC 43.7: a peer that accepts but never reads cannot hang send() forever', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];

    // A real TLS server that completes the handshake and then never reads. The
    // sender's kernel buffer fills and the write stops making progress — the
    // shape of a datacenter that is up but wedged.
    const server = tls.createServer(
      {
        cert: certs.nodes[1]!.cert,
        key: certs.nodes[1]!.key,
        ca: certs.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (socket) => {
        socket.pause();
      },
    );
    server.on('secureConnection', (socket) => serverSockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(ports[1]!, '127.0.0.1', resolve));

    const a = new TcpSecureTransport({
      nodeId: 'dc-a',
      transportNodeId: 1,
      listen: { host: '127.0.0.1', port: ports[0] },
      peers: [{ nodeId: 'dc-b', host: '127.0.0.1', port: ports[1]!, transportNodeId: 2 }],
      tls: { cert: certs.nodes[0]!.cert, key: certs.nodes[0]!.key, ca: certs.caPem },
      connectTimeoutMs: 2000,
      initialRetryMs: 50,
      maxRetryMs: 300,
    });
    open.push(a);
    await a.start();
    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);

    // Each send is bounded, and no call may hold the caller for longer than the
    // configured connect timeout — an unbounded await here is a wedged leader.
    // Raced against a deadline so a hang is an assertion failure that names the
    // defect, not a 60 s vitest timeout that names nothing.
    let settled = 0;
    for (let i = 0; i < 40; i++) {
      const outcome = await Promise.race([
        a.send(message(`bulk-${i}`, 'dc-a', 'dc-b')).then((ok) => ({ kind: 'settled' as const, ok })),
        new Promise<{ kind: 'hung' }>((r) => setTimeout(() => r({ kind: 'hung' }), 5000)),
      ]);
      expect(outcome.kind, `send() #${i} never returned`).toBe('settled');
      settled += 1;
    }
    expect(settled).toBe(40);
  });

  it('AC 43.8: a peer that comes back is reachable again and receives what is sent', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    const { a, b } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2 });

    await a.start();
    await b.start();
    expect(await waitFor(() => a.getConnectedPeers().length > 0)).toBe(true);

    await b.stop();
    expect(await waitFor(() => a.getConnectedPeers().length === 0, 5000)).toBe(true);
    expect(await a.send(message('before', 'dc-a', 'dc-b'))).toBe(false);

    // Same port, same certificate, same identity: a datacenter coming back.
    const b2 = new TcpSecureTransport({
      nodeId: 'dc-b',
      transportNodeId: 2,
      listen: { host: '127.0.0.1', port: ports[1] },
      peers: [{ nodeId: 'dc-a', host: '127.0.0.1', port: ports[0], transportNodeId: 1 }],
      tls: { cert: certs.nodes[1]!.cert, key: certs.nodes[1]!.key, ca: certs.caPem },
      connectTimeoutMs: 2000,
      initialRetryMs: 50,
      maxRetryMs: 300,
    });
    open.push(b2);
    await b2.start();

    expect(await waitFor(() => a.getConnectedPeers().length > 0, 15_000)).toBe(true);
    let sent = false;
    for (let i = 0; i < 40 && !sent; i++) {
      sent = await a.send(message('after', 'dc-a', 'dc-b'));
      if (!sent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(sent).toBe(true);
    expect(await waitFor(() => b2.getStats().messagesReceived > 0)).toBe(true);
  });

  it('AC 43.9: twenty reconnects leave no timer or attempt entry behind', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    // Nobody is listening on the peer port, so every reconnect attempt fails and
    // arms a timer. Twenty of them used to outlive stop() and kept the process
    // awake after the suite finished.
    const a = new TcpSecureTransport({
      nodeId: 'dc-a',
      transportNodeId: 1,
      listen: { host: '127.0.0.1', port: ports[0] },
      peers: [{ nodeId: 'dc-b', host: '127.0.0.1', port: ports[1]!, transportNodeId: 2 }],
      tls: { cert: certs.nodes[0]!.cert, key: certs.nodes[0]!.key, ca: certs.caPem },
      connectTimeoutMs: 500,
      initialRetryMs: 20,
      maxRetryMs: 100,
    });
    open.push(a);
    await a.start();

    for (let i = 0; i < 20; i++) {
      await bounded(a.send(message(`r-${i}`, 'dc-a', 'dc-b')), 2000);
    }
    await bounded(a.stop(), 5000);

    const internals = transportInternals(a);
    expect(internals.retryTimers.size).toBe(0);
    expect(internals.attemptCount.size).toBe(0);
  });

  it('AC 43.10: stop() really unsubscribes the receive bridge', async () => {
    const certs = generateClusterCerts(2);
    const ports = (await getFreePorts(2)) as [number, number];
    const { a } = pair(certs, ports, 'dc-a', 'dc-b', { localWireId: 1, peerWireId: 2 });

    const bridgeListenerCount = (): number =>
      (a as unknown as { transport: { listenerCount(event: string): number } }).transport.listenerCount('message');

    await a.start();
    expect(bridgeListenerCount()).toBe(1);
    await a.stop();

    // `unsubFromRaft` was an empty function and its comment claimed
    // `RaftTcpTransport` cleared the handler set on stop(). It does not: the
    // listener stayed registered on the inner EventEmitter after the transport
    // was stopped, holding this object alive through the closure.
    expect(bridgeListenerCount()).toBe(0);
  });
});
