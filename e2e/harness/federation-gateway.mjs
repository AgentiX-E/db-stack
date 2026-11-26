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
 *                    | { cmd: 'adopt', key, value }
 *                    | { cmd: 'status' }
 *                    | { cmd: 'retry-failed' }
 *                    | { cmd: 'sweep' }
 *                    | { cmd: 'beat' }
 *                    | { cmd: 'pause-beats' }
 *                    | { cmd: 'resume-beats' }
 *                    | { cmd: 'replay-heartbeat', back }
 *                    | { cmd: 'bootstrap', peerId }
 *                    | { cmd: 'stop' }
 *   gateway → parent : { type: 'ready' | 'applied' | 'status' | 'error' | 'replicated'
 *                             | 'adopted' | 'swept' | 'beat' | 'heartbeat-sent' | 'bootstrap' }
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { RaftAdapter } from '@agentix-e/db-cluster';
import {
  FederationManager,
  HEARTBEAT_TYPE,
  MultiLeaderReplication,
  OutboxStore,
  TcpSecureTransport,
} from '@agentix-e/db-federation';

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
    // The incarnation this gateway stamps on every frame. Defaulted by the
    // transport when the suite does not name one; a scenario about a datacenter
    // restored from an older backup has to be able to say which one it is.
    epoch: cfg.epoch,
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

  /**
   * The last heartbeats this process actually wrote, in the order it wrote them.
   *
   * A duplicate and a late frame are things a transport does to a frame, and the
   * only honest way to reproduce them is to send the frame again: the bytes are
   * the product's, not a harness's reconstruction of the wire format. Recording
   * at the transport seam is what makes that possible without the library having
   * to publish a frame builder for a test's convenience.
   */
  const sentHeartbeats = [];
  const federationTransport = new Proxy(transport, {
    get(target, property, receiver) {
      if (property === 'send') {
        return async (message) => {
          if (message?.type === HEARTBEAT_TYPE) {
            sentHeartbeats.push(message);
            if (sentHeartbeats.length > 32) sentHeartbeats.shift();
          }
          return target.send(message);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const outboxConfig = cfg.outbox ?? {};
  outbox = new OutboxStore({
    // Every knob the suite set, forwarded verbatim. This used to be four keys
    // copied by hand (`ttlMs`, `maxRetries`, `retryWindowMs`, `deadLetterTtlMs`)
    // with the rest silently replaced by production defaults — so a suite that
    // shortened the retry window to one second kept the two-second default
    // backoff, and the store refused the pair at boot. The request is validated
    // against the store's own key set in the parent (`assertGatewayConfig`), so
    // what arrives here is already known to be readable.
    ...outboxConfig,
    // Owned by this file: the directory comes from `outboxDir` and the map size
    // is a suite-wide budget, not a property of the scenario.
    dataDir: cfg.outboxDir,
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
    // The recording seam, so `replay-heartbeat` can send the product's own bytes.
    transport: federationTransport,
    outbox,
    dlqScanIntervalMs: cfg.dlqScanIntervalMs ?? 500,
    outboxHousekeepingIntervalMs: cfg.outboxHousekeepingIntervalMs ?? 0,
    // The control plane's intervals, forwarded verbatim from `controlPlane`.
    //
    // A suite that wants to watch a heartbeat expire, or to force a digest round
    // trip in the seconds it has, has to be able to shorten the interval the
    // protocol actually runs with. Copied key by key, a knob the manager renames
    // would keep the production default and the scenario would measure the
    // default instead of what it set — which is exactly the class of defect
    // `assertGatewayConfig` exists to refuse. The parent validates the block
    // against the manager's own configuration type before a process is spawned.
    ...(cfg.controlPlane ?? {}),
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

  // Tell the federation layer what this datacenter's engine already holds.
  //
  // The cluster is what survives a restart — it is checkpointed to `stateFile` and
  // replayed from the Raft log — while the federation layer's replica map is
  // derived state that starts empty. Without this replay the map is a copy of the
  // engine only until the process restarts, and every mechanism that compares the
  // two then compares a full store against a partial one: anti-entropy pushes back
  // keys the datacenter already has, and a bootstrap resumed from a persisted
  // cursor resumes into a map that is missing everything before the cursor.
  //
  // This is the composition root's job, not the library's: the engine is here, and
  // the library's seam for "my engine already has this" is `adoptLocalChange`.
  for (const [key, value] of state) {
    await federation.adoptLocalChange(key, value, 'update');
  }
  stage(`replayed ${state.size} committed keys into the federation layer`);

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
            // What the federation layer believes, key by key.
            //
            // `state` is what the local cluster committed; this is what
            // anti-entropy compares. A repair that lands in one and not the other
            // is state that a restart forgets, and a suite cannot see the
            // difference without being able to read both.
            localValues: Object.fromEntries([...federation.getLocalStore()].map(([key, entry]) => [key, entry.value])),
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
            // What the outbox actually runs with, not what the suite asked for.
            // A scenario that shortens a window needs to be able to assert that
            // the window it got is the one it set — otherwise a knob dropped on
            // the way in turns the suite into a test of the default.
            retention: federation.getRetention(),
            // Which incarnation of each peer this gateway has heard from, and how
            // many frames it refused for being older than one it had already
            // passed: the only way a suite can see the epoch rule working from
            // outside the process.
            epochStatus: federation.getEpochStatus(),
            // The control plane, as the three protocols see it: the root each
            // peer claimed, how many digests were answered, how many heartbeats
            // were dropped as out of order, how far a bootstrap got. A suite that
            // asserts on convergence has to be able to name the mechanism that
            // produced it, or a passing case only shows that *something* worked.
            protocols: federation.getProtocolStatus(),
          },
        });
      } else if (msg.cmd === 'adopt') {
        // A change this datacenter applied without federation seeing it — what
        // an application writing straight into the local engine produces. The
        // write goes to the cluster first, exactly as the application's would,
        // and only then is the federation layer told: the reverse order would
        // claim a commit that had not happened.
        //
        // There is no outbox entry, so no retry and no dead letter can deliver
        // it: the only mechanism that can is anti-entropy, which is what makes
        // the convergence case a test of that mechanism rather than of the
        // outbox.
        const key = requireKey(msg.key);
        await proposeWhenLeader(key, String(msg.value));
        await federation.adoptLocalChange(key, String(msg.value), msg.type ?? 'update');
        send({ type: 'adopted', nodeId: cfg.nodeId, data: { key } });
      } else if (msg.cmd === 'sweep') {
        await federation.getAntiEntropyProtocol().sweep();
        send({
          type: 'swept',
          nodeId: cfg.nodeId,
          data: federation.getAntiEntropyProtocol().getStatus(),
        });
      } else if (msg.cmd === 'beat') {
        const delivered = await federation.getHeartbeat().beat();
        // The sequence is reported because it is the only handle a suite has on
        // the interval it just sent: re-sending the same frame is a duplicate,
        // and re-sending it with a lower number is a late frame.
        send({
          type: 'beat',
          nodeId: cfg.nodeId,
          data: { delivered, seq: federation.getHeartbeat().getStatus().selfSeq },
        });
      } else if (msg.cmd === 'pause-beats') {
        federation.getHeartbeat().stop();
        send({ type: 'beat', nodeId: cfg.nodeId, data: { paused: true } });
      } else if (msg.cmd === 'resume-beats') {
        federation.getHeartbeat().start();
        send({ type: 'beat', nodeId: cfg.nodeId, data: { paused: false } });
      } else if (msg.cmd === 'replay-heartbeat') {
        // Re-send a frame this process already wrote.
        //
        // `back: 0` is the most recent beat, so the peer receives the same interval
        // twice — a transport duplicate. `back: 1` is the one before it, so the peer
        // receives an interval it has already accepted, after a newer one — a late
        // frame. Both are real: the payloads are the product's own, and the socket
        // is the same mutually-authenticated one every other frame takes.
        const back = Number(msg.back ?? 0);
        const index = sentHeartbeats.length - 1 - back;
        if (index < 0) {
          throw new Error(`no heartbeat ${back} beats back (recorded: ${sentHeartbeats.length})`);
        }
        const frame = sentHeartbeats[index];
        const delivered = await transport.send(frame);
        send({
          type: 'heartbeat-sent',
          nodeId: cfg.nodeId,
          data: { delivered, back, messageId: frame.messageId },
        });
      } else if (msg.cmd === 'bootstrap') {
        const transferId = await federation.bootstrapFrom(msg.peerId);
        send({ type: 'bootstrap', nodeId: cfg.nodeId, data: { transferId } });
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
