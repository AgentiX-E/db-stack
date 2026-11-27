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
 *   parent → node : { cmd: 'propose', data } | { cmd: 'status' } | { cmd: 'stop' }
 *                 | { cmd: 'add' | 'promote' | 'remove', nodeId, address? }
 *   node → parent : { type: 'ready' | 'applied' | 'status' | 'error' | 'leader'
 *                         | 'membership', ... }
 *
 * The membership commands exist because a configuration change is the one
 * operation no single-node unit test can judge: the answer ("committed",
 * "refused because there is no quorum", "refused after the commit timeout") is a
 * property of how the *other* processes answer, and only a real cluster produces
 * one.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RaftAdapter,
  MemoryStorageEngine,
  EngineBackedReplica,
  parseFencingToken,
  formatFencingToken,
  stampFencingTokenOnEntry,
} from '@agentix-e/db-cluster';

const RAW = process.env.RAFT_NODE_CONFIG;
if (!RAW) {
  process.stderr.write('[raft-node] RAFT_NODE_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);
const applied = [];
// Entries proposed through the gated path carry the quorum position the product
// stamped on them. Kept separately so an acceptance case can prove the token
// survived Raft replication and reached the application, not just the leader's
// return value.
const fencedApplied = [];

/**
 * The node's data lives in an engine behind the published SPI, not in a map owned
 * by this script. Everything the acceptance suite asserts about state therefore
 * goes through the same apply/query/snapshot/restore path a real database engine
 * would implement — an in-process map would have hidden a broken SPI.
 */
const engine = new MemoryStorageEngine();
const replica = new EngineBackedReplica({ shardId: 0, engine });

/**
 * Translate this node's command format into the engine's.
 *
 * A payload that is not a `{key, value}` object is replicated but not interpreted;
 * it still consumes an index (`nop`) so the applied index stays contiguous.
 */
function encodeCommand(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.key === 'string' && typeof parsed.value === 'string') {
      return Buffer.from(JSON.stringify({ op: 'put', key: parsed.key, value: parsed.value }), 'utf8');
    }
  } catch {
    // Not JSON: an opaque entry.
  }
  return Buffer.from(JSON.stringify({ op: 'nop' }), 'utf8');
}

/** Encode a key/value read for the reference engine. */
function readRequest(key) {
  return Buffer.from(JSON.stringify({ op: 'get', key }), 'utf8');
}

async function readValue(key) {
  const response = await replica.query(readRequest(key));
  return JSON.parse(response.toString('utf8')).value ?? null;
}

/** Every key the engine currently holds, sorted. */
async function listKeys() {
  const response = await replica.query(Buffer.from(JSON.stringify({ op: 'keys' }), 'utf8'));
  return JSON.parse(response.toString('utf8')).keys;
}

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
    enableInstallSnapshot: cfg.enableInstallSnapshot ?? false,
  });

  // The engine's applied state, not the log, is what has to survive a restart.
  adapter.setApplicationSnapshotHandlers({
    // The boundary is Raft's log position, not the engine's watermark: the two
    // differ by every CONFIG/NOOP entry Raft applied without calling the
    // application, and an envelope stamped below the snapshot's own boundary makes
    // the first post-restore apply look like a jump.
    takeSnapshot: (boundaryIndex) => replica.snapshot(boundaryIndex),
    installSnapshot: (data) => replica.restore(data),
    // The engine's own position. The adapter compares it with Raft's at startup and
    // refuses the node when the engine is behind the log: those entries are already
    // compacted away, so a node that starts anyway answers reads out of a hole.
    appliedIndex: () => replica.lastAppliedIndex(),
  });

  await adapter.init(
    async (data, index, term) => {
      applied.push(data);
      // Read the stamped position back off the wire, the way an engine would
      // before admitting the write to its own resource. Parsing is done with the
      // published reader, not a hand-written split, so a malformed token cannot
      // pass this seam unnoticed.
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed.fencingToken === 'string') {
          fencedApplied.push({
            token: formatFencingToken(parseFencingToken(parsed.fencingToken)),
            key: parsed.key ?? null,
            index,
            term,
          });
        }
      } catch {
        // An opaque payload is a valid entry; it simply carries no token.
      }
      // The node's encoder. The engine is deliberately strict — an unparseable
      // payload is a bug, not a write — so interpreting the application's command
      // format is this process's job, not the middleware's.
      const command = encodeCommand(data);
      await replica.apply({ index, term, command: 'kv', data: command });
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
      } else if (msg.cmd === 'propose:gated') {
        // A write that goes through the product's stamping seam: the token is
        // minted from the quorum position the adapter reports, by the same
        // function RaftGroup.propose uses. This is the hot path the acceptance
        // case exercises over real TLS replication.
        if (!(await adapter.isLeader())) {
          send({ type: 'error', nodeId: cfg.id, data: 'not leader' });
          return;
        }
        const [term, commitIndex] = await Promise.all([adapter.getTerm(), adapter.getCommitIndex()]);
        let stamped;
        try {
          const presented = msg.fencingToken === undefined ? {} : { fencingToken: msg.fencingToken };
          stamped = stampFencingTokenOnEntry(
            { ...presented, key: msg.key, value: msg.value, msgId: msg.msgId },
            term,
            commitIndex,
          );
        } catch (error) {
          send({ type: 'error', nodeId: cfg.id, data: String(error instanceof Error ? error.message : error) });
          return;
        }
        const result = await adapter.propose(JSON.stringify(stamped));
        send({ type: 'proposed:gated', nodeId: cfg.id, data: { ...result, token: stamped.fencingToken } });
      } else if (msg.cmd === 'read') {
        send({
          type: 'read',
          nodeId: cfg.id,
          data: { key: msg.key, value: await readValue(msg.key) },
        });
      } else if (msg.cmd === 'status') {
        // `getStatus` refreshes the snapshot view along the way; `getSnapshotMeta`
        // alone is a cache.
        const [isLeader, term, commitIndex, progress, raftStatus, membership, quorum, keys] = await Promise.all([
          adapter.isLeader(),
          adapter.getTerm(),
          adapter.getCommitIndex(),
          adapter.getProgress(),
          adapter.getStatus(),
          adapter.getMembership(),
          adapter.getQuorumHealth(),
          listKeys(),
        ]);
        send({
          type: 'status',
          nodeId: cfg.id,
          data: {
            id: cfg.id,
            isLeader,
            term,
            commitIndex,
            lastLogIndex: progress.lastLog ?? 0,
            raftApplied: progress.applied ?? 0,
            snapshot: raftStatus?.snapshot ?? null,
            appliedCount: applied.length,
            applied: applied.slice(),
            fencedApplied: fencedApplied.slice(),
            stateSize: keys.length,
            keys,
            appliedIndex: replica.lastAppliedIndex(),
            // The pair the adapter checks at startup and reports on every status:
            // where the application says its state is, and how far that is from the
            // position Raft declares. A non-zero gap means the writes in between are
            // not in the engine and are no longer in the log.
            applicationApplied: raftStatus?.applicationApplied ?? null,
            appliedGap: raftStatus?.appliedGap ?? null,
            engineName: engine.name,
            // The engine's own record of which index it was handed each command
            // at. Comparing it with `applied` separates "raft never gave the
            // command to the application" from "the application was handed it and
            // dropped it", which a key count alone cannot do — and an apply that
            // the replica suppresses as a replay leaves no trace in the log.
            engineIndexes: engine.appliedContexts.map((context) => context.index),
            // Suppressed replays and accepted forward jumps are normal in small
            // numbers; they become the explanation when the key count disagrees
            // with the applied list, because a suppressed apply is silent.
            skippedReplays: replica.skippedReplays,
            forwardJumps: replica.forwardJumps,
            restoreFailure: replica.restoreFailure === null ? null : String(replica.restoreFailure),
            // The two answers a membership change is judged by: what this node
            // believes the committed configuration is, and whether it can still
            // hear a majority. Read from every node, because a change that only
            // one process knows about is not a cluster configuration.
            membership,
            quorum,
          },
        });
      } else if (msg.cmd === 'add' || msg.cmd === 'promote' || msg.cmd === 'remove') {
        const startedAt = Date.now();
        const nodeId = Number(msg.nodeId);
        const result =
          msg.cmd === 'add'
            ? await adapter.addServer(nodeId, String(msg.address ?? ''), msg.asLearner !== false)
            : msg.cmd === 'promote'
              ? await adapter.promoteServer(nodeId)
              : await adapter.removeServer(nodeId);
        send({
          type: 'membership',
          nodeId: cfg.id,
          data: {
            command: msg.cmd,
            request: { nodeId, address: msg.address },
            result,
            // How long the answer took is part of the answer: a refusal that arrives
            // in six milliseconds ("there is no quorum") and one that arrives after
            // five seconds ("the entry never committed") are different facts about
            // the cluster, and only the duration separates them.
            elapsedMs: Date.now() - startedAt,
            membership: await adapter.getMembership(),
          },
        });
      } else if (msg.cmd === 'stop') {
        stopped = true;
        adapter.stop();
        send({ type: 'stopped', nodeId: cfg.id });
        setTimeout(() => process.exit(0), 50);
      }
    } catch (err) {
      send({
        type: 'error',
        nodeId: cfg.id,
        data: err instanceof Error ? err.message : String(err),
      });
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
  send({
    type: 'error',
    nodeId: cfg.id,
    data: String(err?.message ?? err),
    fatal: true,
  });
  process.exit(1);
});
