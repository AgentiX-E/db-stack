/**
 * CDC relay — one process per datacenter, on both ends of a real change stream.
 *
 * `sender` role (the producing DC)
 *   1. Opens the change log a *different* process wrote (`change-writer.mjs`).
 *   2. Tails it with `WalTailCDCEngine`, resuming after its own checkpoint.
 *   3. Ships every change to the peer DC with `ExactlyOnceCDCPipeline` over
 *      `TcpSecureTransport` — TLS 1.3 with mutual certificate verification.
 *   4. Delivers the same change to an HTTP sink through `CDCSubscriptionPump`
 *      and `HttpCDCSink`, over a real socket.
 *
 * `receiver` role (the consuming DC)
 *   1. Accepts the TLS connection, deduplicates inbound frames with a
 *      `DedupRing`, and appends each accepted change to a file on disk.
 *   2. Reports what it applied, so the test asserts on committed bytes rather
 *      than on an in-memory counter.
 *
 * Both roles answer `status` with their own counters *and* the conservation
 * identity, so the acceptance test can check the ledger against a process that
 * really ran rather than against a status object built for the occasion.
 *
 * IPC contract
 * ------------
 *   parent → relay : { cmd: 'status' } | { cmd: 'stop' }
 *   relay  → parent : { type: 'ready' } | { type: 'status', data } | { type: 'error', data }
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  CDCSubscriptionPump,
  CDCPublicationRegistry,
  ExactlyOnceCDCPipeline,
  FileChangeLogReader,
  HttpCDCSink,
  TcpSecureTransport,
  WalTailCDCEngine,
  pipelineConservation,
  pumpConservation,
  renderPipelineMetrics,
  renderPumpMetrics,
} from '@agentix-e/db-federation';

const RAW = process.env.CDC_RELAY_CONFIG;
if (!RAW) {
  process.stderr.write('[relay] CDC_RELAY_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);

function send(message) {
  if (process.send) process.send(message);
}

function stage(name) {
  process.stderr.write(`[relay ${cfg.role}:${cfg.nodeId}] ${name}\n`);
}

let transport;
let engine;
let pipeline;
let pump;
let appliedFd = null;
let applied = 0;
/** Sends the pump attempted and the transport refused, for this process's lifetime. */
let refusals = 0;
/**
 * How many inbound changes this node is willing to apply — `Infinity` unless the
 * test asked for a hold.
 *
 * A frame beyond the limit is dropped **before** the dedup ring sees it, which is
 * what a write the kernel accepted and the peer never received looks like from
 * the receiving end: nothing arrived. The sender's frame sat in a socket and the
 * local kernel reported success. That is the case `outboxDelivered` used to get
 * wrong, so it is the case this process has to be able to produce.
 */
let applyLimit = cfg.applyLimit ?? Infinity;
/** Frames that reached this process and were never applied, retries included. */
let held = 0;

function appendApplied(event) {
  const line = `${JSON.stringify({
    lsn: event.lsn,
    table: event.tableName,
    operation: event.operation,
    txId: event.txId,
    values: event.newValues,
  })}\n`;
  appendFileSync(appliedFd, line);
  fsyncSync(appliedFd);
  applied += 1;
}

function transportConfig() {
  return {
    nodeId: cfg.nodeId,
    transportNodeId: cfg.transportNodeId,
    listen: cfg.listen,
    peers: [
      {
        nodeId: cfg.peer.nodeId,
        host: cfg.peer.host,
        port: cfg.peer.port,
        transportNodeId: cfg.peer.transportNodeId,
      },
    ],
    tls: { cert: cfg.tls.cert, key: cfg.tls.key, ca: cfg.tls.ca },
    connectTimeoutMs: 5_000,
    initialRetryMs: 50,
    maxRetryMs: 1_000,
  };
}

async function startReceiver() {
  mkdirSync(cfg.dir, { recursive: true });
  appliedFd = openSync(cfg.appliedFile, 'a');

  // The transport exists before the pipeline because the pipeline needs it to
  // answer: a confirmation is a frame, and a node without a transport cannot
  // send one. The pipeline's own outbox stays empty — a receiver produces
  // nothing — so its pump has nothing to ship.
  transport = new TcpSecureTransport(transportConfig());
  pipeline = new ExactlyOnceCDCPipeline({
    nodeId: cfg.nodeId,
    cdcConfig: { nodeId: cfg.nodeId },
    outboxConfig: { dataDir: join(cfg.dir, 'outbox') },
    checkpointDir: join(cfg.dir, 'outbox'),
    dedupTtlMs: 900_000,
    transport,
    pumpIntervalMs: 1_000,
  });
  await pipeline.start();

  transport.onMessage((message) => {
    if (message.type === 'cdc_ack') return;
    if (applied >= applyLimit) {
      held += 1;
      return;
    }
    const result = pipeline.processInbound(message);
    if (result.event) appendApplied(result.event);
    // After `appendApplied`, which fsyncs: the confirmation says *applied*, and a
    // duplicate is answered too — it was applied on the first attempt, and the
    // sender must be allowed to stop retrying it.
    void pipeline.acknowledge(message);
  });
  stage('transport-start');
  await transport.start();

  send({ type: 'ready', data: { listen: transport.getLocalAddress() } });
}

async function startSender() {
  mkdirSync(cfg.dir, { recursive: true });

  // Resume where the last run stopped, read before the engine exists: the
  // engine's cursor decides what the tail reads, so it cannot be corrected
  // afterwards. This is the order a deployment has to use, and the reason
  // `readCheckpoint` is a static.
  const checkpointDir = join(cfg.dir, 'outbox');
  const checkpoint = ExactlyOnceCDCPipeline.readCheckpoint(checkpointDir);
  const resumeFrom = ExactlyOnceCDCPipeline.resumePosition(checkpoint);

  const reader = await FileChangeLogReader.open({ dir: cfg.logDir });
  engine = new WalTailCDCEngine({
    reader,
    nodeId: cfg.nodeId,
    startAfterLsn: resumeFrom,
    pollIntervalMs: cfg.pollIntervalMs ?? 10,
  });
  engine.watchTable(cfg.table);

  transport = new TcpSecureTransport(transportConfig());
  stage('transport-start');
  await transport.start();

  pipeline = new ExactlyOnceCDCPipeline({
    nodeId: cfg.nodeId,
    cdcConfig: { nodeId: cfg.nodeId },
    engine,
    outboxConfig: {
      dataDir: checkpointDir,
      // Two budgets, and the time one is the real one: `maxRetries` is an attempt
      // cap that a deployment may set when it wants three strikes, while the window
      // is how long a peer may be away before changes start moving to the dead
      // letter. A test that intends an outage of minutes says so here.
      ...(cfg.outboxMaxRetries === undefined ? {} : { maxRetries: cfg.outboxMaxRetries }),
      ...(cfg.outboxRetryWindowMs === undefined ? {} : { retryWindowMs: cfg.outboxRetryWindowMs }),
      mapSize: 32 * 1024 * 1024,
    },
    checkpointDir,
    transport,
    remoteNodeId: cfg.peer.nodeId,
    pumpIntervalMs: cfg.pumpIntervalMs ?? 20,
    pumpBatchSize: 32,
    // Short enough that a test which holds the peer down does not wait five
    // seconds per cycle to learn that nothing answered.
    ackTimeoutMs: cfg.ackTimeoutMs ?? 1_000,
  });
  // Every refused send is a `pump_error`; the count is what makes "a refusal happened"
  // an observation rather than an assumption about the run.
  pipeline.onEvent((event) => {
    if (event.type === 'pump_error') refusals += 1;
  });
  await pipeline.start();

  if (cfg.sink) {
    const registry = new CDCPublicationRegistry({ nodeId: cfg.nodeId, engine });
    await registry.createPublication('cdc', [cfg.table]);
    await registry.createSubscription('webhook', 'cdc', cfg.sink.url);
    pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: () =>
        new HttpCDCSink({
          url: cfg.sink.url,
          timeoutMs: cfg.sink.timeoutMs ?? 2_000,
          probe: { method: 'GET' },
        }),
      maxEmitAttempts: 5,
      retryBaseMs: 25,
    });
    await pump.start();
  }

  send({ type: 'ready', data: { resumeFrom } });
}

async function status() {
  const base = {
    role: cfg.role,
    nodeId: cfg.nodeId,
    transport: transport?.getStats() ?? null,
  };
  const metrics = await pipeline.getMetrics();

  if (cfg.role === 'receiver') {
    return {
      ...base,
      applied,
      appliedFile: cfg.appliedFile,
      deduped: metrics.totalDeduped,
      delivered: metrics.totalDelivered,
      held,
      applyLimit,
    };
  }

  const pumpStatus = pump ? pump.getStatus() : null;
  return {
    ...base,
    engine: engine.getStatus(),
    pump: pumpStatus,
    pumpConservation: pumpStatus ? pumpConservation(pumpStatus) : null,
    metrics,
    refusals,
    pipelineConservation: pipelineConservation(metrics),
    checkpoint: pipeline.getCheckpoint(),
    resumePosition: ExactlyOnceCDCPipeline.resumePosition(pipeline.getCheckpoint()),
    exposition: [
      pumpStatus ? renderPumpMetrics(pumpStatus, { node: cfg.nodeId }) : '',
      renderPipelineMetrics(metrics, { node: cfg.nodeId }),
    ]
      .join('')
      .trimEnd(),
  };
}

async function main() {
  if (cfg.role === 'receiver') await startReceiver();
  else await startSender();

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'status') {
        send({ type: 'status', data: await status() });
      } else if (msg.cmd === 'release') {
        applyLimit = Infinity;
        send({ type: 'released', data: { applied, held } });
      } else if (msg.cmd === 'stop') {
        if (pump) await pump.stop();
        if (pipeline) await pipeline.cleanup();
        transport?.destroy();
        if (appliedFd !== null) closeSync(appliedFd);
        send({ type: 'stopped' });
        setTimeout(() => process.exit(0), 20);
      }
    } catch (err) {
      send({ type: 'error', data: err instanceof Error ? err.message : String(err) });
    }
  });
}

process.on('SIGTERM', () => {
  try {
    transport?.destroy();
  } catch {
    /* shutting down anyway */
  }
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`[relay ${cfg.role}] fatal: ${err?.stack ?? err}\n`);
  send({ type: 'error', data: String(err?.message ?? err), fatal: true });
  process.exit(1);
});
