/**
 * Real Raft cluster node process.
 *
 * Spawned as a separate OS process by the e2e suite. It imports the *published*
 * entry point (`@agentix-e/db-cluster`, i.e. `dist/`), binds a real TLS 1.3
 * listener with mutual certificate verification, and talks to its peers over
 * real TCP sockets. Nothing here is in-process or faked: killing this process
 * is a genuine node crash from the cluster's point of view.
 *
 * IPC contract
 * ------------
 *   parent → node : { cmd: 'propose', data }  | { cmd: 'status' } | { cmd: 'stop' }
 *   node → parent : { type: 'ready' | 'applied' | 'status' | 'error' | 'leader', ... }
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RaftAdapter } from '@agentix-e/db-cluster';

const RAW = process.env.RAFT_NODE_CONFIG;
if (!RAW) {
  process.stderr.write('[raft-node] RAFT_NODE_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);
const applied = [];
/** Committed key/value view of this node's state machine. */
const state = new Map();
let adapter;
let stopped = false;

function send(message) {
  process.send?.(message);
}

async function main() {
  mkdirSync(dirname(cfg.dataDir), { recursive: true });
  mkdirSync(cfg.dataDir, { recursive: true });

  adapter = new RaftAdapter({
    id: cfg.id,
    peers: cfg.peers.map((p) => p.id),
    electionTick: cfg.electionTick ?? 10,
    heartbeatTick: cfg.heartbeatTick ?? 3,
    tickIntervalMs: cfg.tickIntervalMs ?? 50,
    storagePath: `${cfg.dataDir}/raft.db`,
    snapshotInterval: cfg.snapshotInterval ?? 1000,
    environment: 'development',
    preVote: true,
    checkQuorum: true,
    enableInstallSnapshot: false,
  });

  await adapter.init(
    (data) => {
      applied.push(data);
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed.key === 'string') state.set(parsed.key, parsed.value);
      } catch {
        // Opaque payload: consensus still applied it, but it has no key.
      }
      send({ type: 'applied', nodeId: cfg.id, data });
    },
    {
      node: { id: cfg.id, host: cfg.host, port: cfg.port },
      peers: cfg.peers,
      tls: { cert: cfg.cert.cert, key: cfg.cert.key, ca: cfg.cert.ca },
      connectTimeoutMs: 5000,
      initialRetryMs: 100,
      maxRetryMs: 5000,
    },
  );

  send({ type: 'ready', nodeId: cfg.id, data: { port: cfg.port } });

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'propose') {
        if (!(await adapter.isLeader())) {
          send({ type: 'error', nodeId: cfg.id, data: 'not leader' });
          return;
        }
        const result = await adapter.propose(msg.data);
        send({ type: 'proposed', nodeId: cfg.id, data: result });
      } else if (msg.cmd === 'read') {
        send({ type: 'read', nodeId: cfg.id, data: { key: msg.key, value: state.get(msg.key) ?? null } });
      } else if (msg.cmd === 'status') {
        const [isLeader, term, commitIndex] = await Promise.all([
          adapter.isLeader(),
          adapter.getTerm(),
          adapter.getCommitIndex(),
        ]);
        send({
          type: 'status',
          nodeId: cfg.id,
          data: {
            id: cfg.id,
            isLeader,
            term,
            commitIndex,
            appliedCount: applied.length,
            applied: applied.slice(),
            stateSize: state.size,
          },
        });
      } else if (msg.cmd === 'stop') {
        stopped = true;
        adapter.stop();
        send({ type: 'stopped', nodeId: cfg.id });
        setTimeout(() => process.exit(0), 50);
      }
    } catch (err) {
      send({ type: 'error', nodeId: cfg.id, data: err instanceof Error ? err.message : String(err) });
    }
  });
}

process.on('SIGTERM', () => {
  if (!stopped) {
    try {
      adapter?.stop();
    } catch {
      /* shutting down anyway */
    }
  }
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`[raft-node] fatal: ${err?.stack ?? err}\n`);
  send({ type: 'error', nodeId: cfg.id, data: String(err?.message ?? err), fatal: true });
  process.exit(1);
});
