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

  // The dedup half of the pipeline: no outbox, no transport — only the ring
  // that decides whether an inbound message has been seen before.
  pipeline = new ExactlyOnceCDCPipeline({
    nodeId: cfg.nodeId,
    cdcConfig: { nodeId: cfg.nodeId },
    outboxConfig: { dataDir: join(cfg.dir, 'outbox') },
    checkpointDir: join(cfg.dir, 'outbox'),
    dedupTtlMs: 900_000,
  });
  await pipeline.start();

  transport = new TcpSecureTransport(transportConfig());
  transport.onMessage((message) => {
    const result = pipeline.processInbound(message);
    if (result.event) appendApplied(result.event);
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
    outboxConfig: { dataDir: checkpointDir, maxRetries: 10, mapSize: 32 * 1024 * 1024 },
    checkpointDir,
    transport,
    remoteNodeId: cfg.peer.nodeId,
    pumpIntervalMs: cfg.pumpIntervalMs ?? 20,
    pumpBatchSize: 32,
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
    };
  }

  const pumpStatus = pump ? pump.getStatus() : null;
  return {
    ...base,
    engine: engine.getStatus(),
    pump: pumpStatus,
    pumpConservation: pumpStatus ? pumpConservation(pumpStatus) : null,
    metrics,
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
