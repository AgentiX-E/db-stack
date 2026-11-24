/**
 * Federation gateway process — one per datacenter.
 *
 * Responsibilities (all real, no in-process shortcuts):
 *   1. Hosts a Raft member of its *local* cluster (mTLS, 3 nodes).
 *   2. Hosts a `FederationManager` + `MultiLeaderReplication` + LMDB outbox.
 *   3. Replicates writes to the remote DC over `TcpSecureTransport`
 *      (TLS 1.3 + mutual certificate verification).
 *   4. Applies inbound replication frames by proposing them into the local
 *      Raft group, so the data is committed by consensus, not just cached.
 *
 * IPC contract
 * ------------
 *   parent → gateway : { cmd: 'replicate', key, value, type }
 *                    | { cmd: 'status' }
 *                    | { cmd: 'retry-failed' }
 *                    | { cmd: 'stop' }
 *   gateway → parent : { type: 'ready' | 'applied' | 'status' | 'error' | 'replicated' }
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { RaftAdapter } from '@agentix-e/db-cluster';
import { FederationManager, MultiLeaderReplication, OutboxStore, TcpSecureTransport } from '@agentix-e/db-federation';

const RAW = process.env.FEDERATION_GATEWAY_CONFIG;
if (!RAW) {
  process.stderr.write('[gateway] FEDERATION_GATEWAY_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);

/** Committed state machine of the local cluster (fed by Raft apply). */
const state = new Map();

/**
 * Durability for the local state machine.
 *
 * Raft keeps the log, but a restarted process starts with an empty in-memory
 * map and `raft-core` does not replay already-applied entries into the apply
 * handler. Without a checkpoint every restart would forget the DC's committed
 * keys. The snapshot is written atomically (tmp + rename) after each apply.
 */
const STATE_FILE = cfg.stateFile;

function loadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) state.set(k, v);
  } catch {
    // No checkpoint yet — first boot.
  }
}

function persistState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(state)));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    process.stderr.write(`[gateway ${cfg.nodeId}] state persist failed: ${err?.message ?? err}\n`);
  }
}
let adapter;
let transport;
let federation;
let outbox;

/**
 * Keys the local change stream delivered to a registered consumer.
 *
 * The outbox is what crosses the datacenter, so a CDC event that never reaches
 * a consumer is not a data-loss event — but it is a change nobody observed, and
 * `flushBuffer()` used to deliver only the first event of every batch while
 * reporting the whole batch as flushed. Recording what actually arrived makes
 * that claim checkable from outside the process.
 */
const cdcKeys = [];
/** Frames this gateway's transport handed to its inbound subscribers. */
const inboundFrameIds = [];
/** Targets that were failing and are delivering again. */
const recoveredTargets = [];

function send(message) {
  process.send?.(message);
}

/** Startup progress on stderr — the parent forwards it, so a hang is traceable. */
function stage(name) {
  process.stderr.write(`[gateway ${cfg.nodeId}] ${name}\n`);
}

function requireKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('key required');
  return key;
}

/**
 * Propose `data` once this node is the leader, or fail loudly.
 *
 * An inbound replication frame must end up in this cluster's own log. Returning
 * quietly when the node is not the leader — which is what this consumer did —
 * tells `applyInbound` that the change was applied when it was not: the frame
 * is gone from the sender's outbox and from this cluster's log at the same
 * time, and nothing anywhere records the loss. A restarted gateway is a
 * follower for the few hundred milliseconds before it wins its election, so
 * that window is not hypothetical.
 */
async function proposeWhenLeader(key, value, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await adapter.isLeader()) {
      await adapter.propose(JSON.stringify({ key, value }));
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`not leader within ${timeoutMs}ms: inbound entry ${key} was not applied`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Local Raft consumer: propose an inbound remote entry into our own cluster. */
const consumer = {
  async proposeReplicated(entry) {
    const key = entry.key ?? entry.data?.key;
    await proposeWhenLeader(key, entry.data);
  },
  getHLC() {
    return federation?.hlc ?? null;
  },
  async onConflict(conflict) {
    send({ type: 'conflict', nodeId: cfg.nodeId, data: conflict });
  },
};

async function main() {
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.outboxDir, { recursive: true });
  loadState();

  stage('from-local-raft');
  // ── Local Raft membership ──
  adapter = new RaftAdapter({
    id: cfg.raft.id,
    peers: cfg.raft.peers.map((p) => p.id),
    electionTick: cfg.raft.electionTick ?? 10,
    heartbeatTick: cfg.raft.heartbeatTick ?? 3,
    tickIntervalMs: cfg.raft.tickIntervalMs ?? 50,
    storagePath: `${cfg.dataDir}/raft.db`,
    snapshotInterval: 1000,
    environment: 'development',
    preVote: true,
    checkQuorum: true,
    enableInstallSnapshot: false,
  });

  await adapter.init(
    (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed.key === 'string') {
          state.set(parsed.key, parsed.value);
          persistState();
          send({
            type: 'applied',
            nodeId: cfg.nodeId,
            data: { key: parsed.key, value: parsed.value },
          });
        }
      } catch {
        // Non-JSON payloads are still applied by consensus; they simply carry
        // no key/value pair for the gateway's view.
      }
    },
    {
      node: cfg.raft.node,
      peers: cfg.raft.peers,
      tls: {
        cert: cfg.raft.cert.cert,
        key: cfg.raft.cert.key,
        ca: cfg.raft.cert.ca,
      },
      connectTimeoutMs: 5000,
      initialRetryMs: 100,
      maxRetryMs: 5000,
    },
  );

  stage('raft-init');
  // ── Federation transport (cross-DC, mTLS) ──
  transport = new TcpSecureTransport({
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
      cert: cfg.federationCert.cert,
      key: cfg.federationCert.key,
      ca: cfg.federationCert.ca,
    },
    connectTimeoutMs: 5000,
    initialRetryMs: 100,
    maxRetryMs: 5000,
  });

  stage('transport-start');
  await transport.start();

  const outboxConfig = cfg.outbox ?? {};
  outbox = new OutboxStore({
    dataDir: cfg.outboxDir,
    ttlMs: outboxConfig.ttlMs ?? 600_000,
    maxRetries: outboxConfig.maxRetries ?? 10,
    // A retry window that is short enough for a test to outlast it, and long
    // enough that a healthy peer never produces a dead letter.
    retryWindowMs: outboxConfig.retryWindowMs ?? 60_000,
    deadLetterTtlMs: outboxConfig.deadLetterTtlMs ?? 600_000,
    mapSize: 16 * 1024 * 1024,
  });

  const replicationConfig = {
    nodeId: cfg.nodeId,
    dc: cfg.dc,
    targets: [
      {
        nodeId: cfg.peer.nodeId,
        dc: cfg.peer.dc,
        address: `${cfg.peer.host}:${cfg.peer.port}`,
        topology: 'cross-dc',
        maxBackoffSeconds: 1,
      },
    ],
    curveDir: cfg.outboxDir,
    tickMs: 50,
    batchSize: 100,
    maxRetries: 10,
  };

  stage('outbox-ready');
  const replication = new MultiLeaderReplication({
    transport,
    outbox,
    config: replicationConfig,
  });

  federation = new FederationManager(replication, {
    nodeId: cfg.nodeId,
    dc: cfg.dc,
    replicationConfig,
    transport,
    outbox,
    dlqScanIntervalMs: cfg.dlqScanIntervalMs ?? 500,
    outboxHousekeepingIntervalMs: cfg.outboxHousekeepingIntervalMs ?? 0,
  });

  stage('replication-ready');
  // A second subscriber on the same transport, used only for observability: it
  // counts what arrived, so a test can tell "the peer never got the frame" from
  // "the peer got it and did not apply it".
  transport.onMessage((msg) => {
    inboundFrameIds.push(String(msg.messageId));
  });
  federation.registerConsumer(consumer);
  federation.onTargetRecovered((targetNodeId) => {
    recoveredTargets.push(targetNodeId);
  });
  await federation.start();
  // After `start()`: the manager creates its change stream there, so the
  // accessor throws before it. No write has happened yet, so no event is lost
  // between the two statements.
  federation.getCDC().onEvent(async (event) => {
    cdcKeys.push(event.key);
  });

  stage('federation-started');
  send({
    type: 'ready',
    nodeId: cfg.nodeId,
    data: { listen: transport.getLocalAddress(), raftNode: cfg.raft.id },
  });

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'replicate') {
        const key = requireKey(msg.key);
        const result = await federation.replicate(key, String(msg.value), msg.type ?? 'insert');
        send({
          type: 'replicated',
          nodeId: cfg.nodeId,
          data: { key, msgId: result.msgId },
        });
      } else if (msg.cmd === 'status') {
        const [isLeader, term, commitIndex] = await Promise.all([
          adapter.isLeader(),
          adapter.getTerm(),
          adapter.getCommitIndex(),
        ]);
        const stats = transport.getStats();
        send({
          type: 'status',
          nodeId: cfg.nodeId,
          data: {
            nodeId: cfg.nodeId,
            dc: cfg.dc,
            isLeader,
            term,
            commitIndex,
            stateSize: state.size,
            state: Object.fromEntries(state),
            localStore: federation.getLocalStoreSize(),
            transport: stats,
            pending: await replication.getPendingCounts(),
            replication: await replication.getStatus(),
            connectedPeers: transport.getConnectedPeers().map((p) => p.peerId),
            lastSendError: transport.getLastSendError(),
            lastInboundError: federation.getLastInboundError(),
            cdc: { ...federation.getCDC().getDeliveryStats(), keysDelivered: cdcKeys.length },
            inboundFrames: inboundFrameIds.length,
            deadLetters: outbox.getDeadLetterStats().count,
            recoveredTargets: [...recoveredTargets],
          },
        });
      } else if (msg.cmd === 'retry-failed') {
        const revived = await federation.scanDeadLetters();
        send({ type: 'retry-failed', nodeId: cfg.nodeId, data: revived });
      } else if (msg.cmd === 'stop') {
        transport.destroy();
        await federation.stop();
        adapter.stop();
        outbox.close();
        send({ type: 'stopped', nodeId: cfg.nodeId });
        setTimeout(() => process.exit(0), 50);
      }
    } catch (err) {
      send({
        type: 'error',
        nodeId: cfg.nodeId,
        data: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

process.on('SIGTERM', () => {
  try {
    transport?.destroy();
    adapter?.stop();
  } catch {
    /* shutting down anyway */
  }
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`[gateway] fatal: ${err?.stack ?? err}\n`);
  send({
    type: 'error',
    nodeId: cfg.nodeId,
    data: String(err?.message ?? err),
    fatal: true,
  });
  process.exit(1);
});
