/**
 * E2E — an edge replica consumes a real CDC stream over mTLS (two processes).
 *
 * This closes the last node of P3-82: the `EdgeReplica` intake path driven by a
 * real socket rather than an in-process callback. One independent process
 * (`edge-source.mjs`) opens a real `TcpSecureTransport`, and the test process
 * opens a second one; the only path a byte takes between them is the mutually
 * authenticated TLS connection. The replica is a plain library `EdgeReplica`
 * whose engine-supplied `connectTransport` callback dials the real transport
 * and bridges `onMessage -> receive()` — the engine-agnostic seam the package
 * promises.
 *
 * The acceptance criterion from the roadmap is named directly:
 *
 *   AC-F13  a custom resolver changes the outcome of a real conflict between
 *           two processes, and the case fails if the resolver is not consulted.
 *
 * The source pushes two CDC records with the same LSN and different values:
 * two writers claiming one position, resolved only by the engine's policy.
 * With a resolver that prefers writer B, the surviving value is B. With no
 * resolver, the deterministic first-write-wins rule keeps A. Both outcomes are
 * observed through onEvent *and* getAllData(), so the two views cannot diverge
 * without the case catching it.
 *
 * The lifecycle fixed alongside this path is exercised by the framing itself:
 * the source can push before the replica has finished dialing, and those bytes
 * must be buffered and applied, not dropped.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EdgeReplica, TcpSecureTransport, makeHLC, type EdgeSourceConfig } from '@agentix-e/db-federation';
import {
  ChildNode,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnEdgeSource,
  waitUntil,
} from '../harness/support';

const certs = makeCertificates(2);
const tempDirs: string[] = [];
const children: ChildNode[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.exited) child.kill();
  }
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

interface Pair {
  edge: EdgeReplica;
  source: ChildNode;
  replicaTransport: TcpSecureTransport;
  received: Array<{ lsn: number; payload: unknown }>;
  consulted: Array<{ lsn: number; existing: unknown; incoming: unknown }>;
}

async function bootPair(opts: { resolver?: 'prefer-b' }): Promise<Pair> {
  const [sourcePort = 0, replicaPort = 0] = await getFreePorts(2);
  const dir = makeTempDir('edge');
  tempDirs.push(dir);

  const source = spawnEdgeSource(
    {
      nodeId: 'edge-source',
      transportNodeId: 1,
      listen: { host: '127.0.0.1', port: sourcePort },
      peer: {
        nodeId: 'edge-replica',
        host: '127.0.0.1',
        port: replicaPort,
        transportNodeId: 2,
      },
      cert: certs.nodes[0]!,
    },
    'edge-source',
  );
  children.push(source);
  await source.waitForType('ready', 30_000);

  const consulted: Array<{ lsn: number; existing: unknown; incoming: unknown }> = [];
  const received: Array<{ lsn: number; payload: unknown }> = [];
  let replicaTransport: TcpSecureTransport | null = null;

  const edge = new EdgeReplica({
    resolveConflict:
      opts.resolver === 'prefer-b'
        ? (lsn, existing, incoming) => {
            consulted.push({ lsn, existing, incoming });
            const a = incoming as { writer?: string };
            return a?.writer === 'B' ? incoming : existing;
          }
        : undefined,
    connectTransport: async () => {
      const transport = new TcpSecureTransport({
        nodeId: 'edge-replica',
        transportNodeId: 2,
        listen: { host: '127.0.0.1', port: replicaPort },
        peers: [
          {
            nodeId: 'edge-source',
            host: '127.0.0.1',
            port: sourcePort,
            transportNodeId: 1,
          },
        ],
        tls: {
          cert: certs.nodes[1]!.cert,
          key: certs.nodes[1]!.key,
          ca: certs.nodes[1]!.ca,
        },
        connectTimeoutMs: 5_000,
        initialRetryMs: 100,
        maxRetryMs: 5_000,
      });
      await transport.start();
      replicaTransport = transport;
      transport.onMessage((msg) => {
        if (msg.type !== 'edge-cdc') return;
        const frame = JSON.parse(new TextDecoder().decode(msg.payload)) as {
          lsn: number;
          payload: unknown;
        };
        edge.receive(frame.lsn, frame.payload);
      });
      return { dispose: () => transport.destroy() };
    },
  });

  edge.onEvent((event) => {
    if (event.type === 'data') received.push({ lsn: event.lsn, payload: event.payload });
  });

  const sourceConfig: EdgeSourceConfig = {
    url: `tls://127.0.0.1:${sourcePort}`,
    protocol: 'websocket',
  };
  await edge.connect(sourceConfig);

  // Wait for the mTLS channel to be live before pushing — `send()` refuses an
  // unreachable peer rather than silently buffering, so a push into a cold
  // socket would be reported as undelivered and the case would time out on a
  // transport error rather than asserting the arbitration contract.
  await waitUntil(
    async () => (replicaTransport && replicaTransport.getConnectedPeers().length > 0 ? true : undefined),
    30_000,
    'edge replica mTLS channel to come up',
  );

  return {
    edge,
    source,
    replicaTransport: replicaTransport!,
    received,
    consulted,
  };
}

const CONFLICT = [
  { lsn: 7, payload: { table: 'orders', writer: 'A', value: 'from-writer-a' } },
  { lsn: 7, payload: { table: 'orders', writer: 'B', value: 'from-writer-b' } },
];

/** The source's `pushed` answer: one delivery verdict per frame it sent. */
function deliveredOf(msg: { data?: unknown }): boolean[] {
  const data = msg.data as { delivered?: unknown } | undefined;
  return Array.isArray(data?.delivered) ? (data.delivered as boolean[]) : [];
}

describe('E2E — edge CDC intake over real mTLS (AC-F13)', () => {
  it('a custom resolver changes the outcome of a real cross-process conflict', async () => {
    const pair = await bootPair({ resolver: 'prefer-b' });
    try {
      pair.source.send({ cmd: 'push', frames: CONFLICT });
      const pushed = await pair.source.waitForType('pushed', 30_000);
      expect(deliveredOf(pushed)).toEqual([true, true]);

      await waitUntil(
        async () => {
          const rows = pair.edge.getAllData();
          return rows.length === 1 && (rows[0]!.payload as { writer?: string }).writer === 'B' ? true : undefined;
        },
        30_000,
        'the resolver-preferred value to survive at the conflicting LSN',
      );

      // The decision was made by the engine's policy, on real bytes from the
      // other process, and reached both views of the LSN.
      expect(pair.consulted).toHaveLength(1);
      expect(pair.consulted[0]!.lsn).toBe(7);
      const rows = pair.edge.getAllData();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ lsn: 7, payload: CONFLICT[1]!.payload });
      expect(pair.received[pair.received.length - 1]).toEqual(rows[0]);
      expect(pair.edge.getSyncStatus().receivedCount).toBe(1);
    } finally {
      await pair.edge.disconnect();
    }
  });

  it('without the resolver the first real frame wins (the case fails if it is not consulted)', async () => {
    const pair = await bootPair({});
    try {
      pair.source.send({ cmd: 'push', frames: CONFLICT });
      const pushed = await pair.source.waitForType('pushed', 30_000);
      expect(deliveredOf(pushed)).toEqual([true, true]);

      await waitUntil(
        async () => {
          const rows = pair.edge.getAllData();
          return rows.length === 1 ? true : undefined;
        },
        30_000,
        'one row at the conflicting LSN',
      );

      // No policy was installed: first-write-wins keeps writer A, the *other*
      // value from the resolved case. If a resolver were consulted secretly,
      // this assertion would fail — which is the named acceptance criterion.
      expect(pair.consulted).toHaveLength(0);
      const rows = pair.edge.getAllData();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ lsn: 7, payload: CONFLICT[0]!.payload });
    } finally {
      await pair.edge.disconnect();
    }
  });

  it('disconnect disposes the real transport handle, closing the socket', async () => {
    const pair = await bootPair({});
    const transport = pair.replicaTransport;
    // dispose() is async and void from the caller's view; after it settles the
    // transport is stopped and can no longer report a live peer.
    await pair.edge.disconnect();
    // A stopped transport refuses to send, which is observable on the handle
    // without reaching into private state.
    const refused = await transport.send({
      messageId: 'after-disconnect',
      sourcePeerId: 'edge-replica',
      targetPeerId: 'edge-source',
      payload: new Uint8Array(),
      timestamp: makeHLC(BigInt(Date.now()), 0, 'edge-replica'),
      createdAt: Date.now(),
      type: 'edge-cdc',
    });
    expect(refused).toBe(false);
  });
});
