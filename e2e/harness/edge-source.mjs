/**
 * Edge CDC source — a real process that speaks mTLS to an edge replica.
 *
 * The edge replica is a read-only follower that consumes a primary cluster's
 * change stream. To prove the intake path works against a real socket rather
 * than an in-process callback, this harness opens a real `TcpSecureTransport`,
 * accepts the replica's TLS connection, and pushes frames over the wire.
 *
 * The frames it sends are chosen by the parent so a suite can stage a genuine
 * two-writer conflict: two CDC records carrying the same LSN with different
 * values. That is the case the engine-supplied `resolveConflict` callback has
 * to arbitrate — the outcome must differ depending on which policy the engine
 * installed, and a replica that never consulted the policy keeps the first
 * value. Nothing here resolves the conflict: the harness only puts real bytes
 * on a real TLS socket, in the order the parent names.
 *
 * IPC contract
 * ------------
 *   parent → source : { cmd: 'push', frames: [{ lsn, payload }, ...] }
 *                     { cmd: 'stop' }
 *   source → parent : { type: 'ready', data: { listen } }
 *                     { type: 'pushed', data: { count } }
 *                     { type: 'error', data: { message } }
 */

import { TcpSecureTransport, makeHLC } from '@agentix-e/db-federation';

const RAW = process.env.EDGE_SOURCE_CONFIG;
if (!RAW) {
  process.stderr.write('[edge-source] EDGE_SOURCE_CONFIG missing\n');
  process.exit(2);
}
const cfg = JSON.parse(RAW);

function send(message) {
  process.send?.(message);
}

function stage(name) {
  process.stderr.write(`[edge-source ${cfg.nodeId}] ${name}\n`);
}

const transport = new TcpSecureTransport({
  nodeId: cfg.nodeId,
  transportNodeId: cfg.transportNodeId,
  listen: { host: cfg.listen.host, port: cfg.listen.port },
  peers: [
    {
      nodeId: cfg.peer.nodeId,
      host: cfg.peer.host,
      port: cfg.peer.port,
      transportNodeId: cfg.peer.transportNodeId,
    },
  ],
  tls: {
    cert: cfg.cert.cert,
    key: cfg.cert.key,
    ca: cfg.cert.ca,
  },
  connectTimeoutMs: 5_000,
  initialRetryMs: 100,
  maxRetryMs: 5_000,
});

stage('transport-start');
await transport.start();

send({ type: 'ready', data: { listen: transport.getLocalAddress() } });

/** Put one CDC record on the wire. LSN and payload are verbatim from the parent. */
async function pushFrame(frame) {
  const body = JSON.stringify({ lsn: frame.lsn, payload: frame.payload });
  const message = {
    messageId: `edge-${frame.lsn}-${Math.random().toString(36).slice(2)}`,
    sourcePeerId: cfg.nodeId,
    targetPeerId: cfg.peer.nodeId,
    payload: new TextEncoder().encode(body),
    timestamp: makeHLC(BigInt(Date.now()), 0, cfg.nodeId),
    createdAt: Date.now(),
    type: 'edge-cdc',
  };
  return transport.send(message);
}

process.on('message', async (msg) => {
  if (!msg || !msg.cmd) return;
  try {
    if (msg.cmd === 'push') {
      const frames = Array.isArray(msg.frames) ? msg.frames : [];
      const delivered = [];
      for (const frame of frames) {
        delivered.push(await pushFrame(frame));
      }
      send({ type: 'pushed', data: { count: delivered.length, delivered } });
    } else if (msg.cmd === 'stop') {
      transport.destroy();
      send({ type: 'stopped' });
      setTimeout(() => process.exit(0), 50);
    }
  } catch (err) {
    send({ type: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
  }
});
