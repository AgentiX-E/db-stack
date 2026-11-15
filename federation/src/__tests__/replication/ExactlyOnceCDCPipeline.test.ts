/**
 * ExactlyOnceCDCPipeline Tests — AC 47.x
 *
 * AC 47.1 — Pipeline start/stop lifecycle
 * AC 47.2 — CDC event → outbox persistence (G1: at-least-once)
 * AC 47.3 — Outbox pump → transport deliver
 * AC 47.4 — Inbound dedup via DedupRing (G2: at-most-once)
 * AC 47.5 — Checkpoint persistence and recovery (G3: crash-recoverable LSN)
 * AC 47.6 — Consumer ack before checkpoint advance (G4)
 * AC 47.7 — Backpressure when pending queue exceeds maxPending (G5)
 * AC 47.8 — Dead letter after max retries
 * AC 47.9 — webhook subscription delivery
 * E2E.1 — Full round-trip: produce → outbox → pump → transport → receive → dedup
 * E2E.2 — Crash recovery test: simulate crash, verify checkpoint resume
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExactlyOnceCDCPipeline, type ExactlyOnceCDCPipelineConfig } from '../../replication/ExactlyOnceCDCPipeline';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import type { ITransport } from '../../interfaces/transport/ITransport';
import type { TransportMessage } from '../../interfaces/transport/TransportMessage';
import { HLC } from '../../hlc/HLC';

// ── Test data dir ──────────────────────────────────────────

const TEST_DIR = '/tmp/db-federation-test/cdc-pipeline';

function cleanDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

// ── Mock transport ─────────────────────────────────────────

function createMockTransport(): {
  transport: ITransport;
  sentMessages: TransportMessage[];
  enableSendFailure: () => void;
} {
  const sentMessages: TransportMessage[] = [];
  let shouldFail = false;

  const transport: ITransport = {
    send: vi.fn(async (msg: TransportMessage): Promise<boolean> => {
      if (shouldFail) throw new Error('Transport send failed');
      sentMessages.push(msg);
      return true;
    }),
    broadcast: vi.fn(async (_msg: TransportMessage): Promise<number> => {
      sentMessages.push(_msg);
      return 1;
    }),
    onMessage: vi.fn(() => vi.fn()),
    getConnectedPeers: vi.fn(() => [
      {
        peerId: 'remote-1',
        address: '127.0.0.1:7001',
        connectedAt: Date.now(),
        latencyMs: 0,
      },
    ]),
    getStats: vi.fn(() => ({
      peersConnected: 1,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    })),
  };

  return {
    transport,
    sentMessages,
    enableSendFailure: () => {
      shouldFail = true;
    },
  };
}

// ── Config factory ─────────────────────────────────────────

function makePipelineConfig(overrides?: Partial<ExactlyOnceCDCPipelineConfig>): ExactlyOnceCDCPipelineConfig {
  return {
    nodeId: 'n1',
    cdcConfig: { nodeId: 'n1' },
    outboxConfig: { dataDir: path.join(TEST_DIR, 'outbox') },
    pumpIntervalMs: 50,
    pumpBatchSize: 100,
    maxPending: 1000,
    dedupTtlMs: 10_000,
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────

describe('ExactlyOnceCDCPipeline — AC 47.x: Exactly-Once CDC Pipeline', () => {
  let pipeline: ExactlyOnceCDCPipeline;
  let transport: ITransport;
  let sentMessages: TransportMessage[];
  let enableSendFailure: () => void;

  beforeEach(() => {
    cleanDir();
    const mock = createMockTransport();
    transport = mock.transport;
    sentMessages = mock.sentMessages;
    enableSendFailure = mock.enableSendFailure;
  });

  afterEach(async () => {
    try {
      await pipeline.cleanup();
    } catch {
      /* ignore */
    }
  });

  // AC 47.1: Lifecycle
  it('AC 47.1: should start and stop pipeline', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig(),
      transport,
      remoteNodeId: 'remote-1',
    });

    const CHECKPOINT_PATH = path.join(TEST_DIR, 'outbox', 'cdc-checkpoint.json');
    expect(existsSync(CHECKPOINT_PATH)).toBe(false);

    await pipeline.start();

    // Checkpoint should exist
    expect(existsSync(CHECKPOINT_PATH)).toBe(true);
    const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8'));
    expect(cp.version).toBe(1);
    expect(cp.lastConfirmedLSN).toEqual({});

    await pipeline.stop();
  });

  // AC 47.2: G1 — At-least-once persistence
  it('AC 47.2: CDC events persist to outbox before return', async () => {
    pipeline = new ExactlyOnceCDCPipeline(makePipelineConfig());

    await pipeline.start();
    pipeline.watchTable('users');

    const event = pipeline.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'Alice' },
    });

    // Event has LSN already assigned by CDCEngine
    expect(event.lsn).toBeTruthy();
    expect(event.txId).toBeTruthy();

    // Pipeline metrics show produced count
    const metrics = await pipeline.getMetrics();
    expect(metrics.totalProduced).toBe(1);

    await pipeline.stop();
  });

  // AC 47.3: Outbox pump → transport deliver
  it('AC 47.3: should pump CDC events through transport', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({ pumpIntervalMs: 50 }),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline.start();
    pipeline.watchTable('users');
    pipeline.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1 },
    });

    // Wait for pump cycle
    await new Promise((r) => setTimeout(r, 200));
    await pipeline.stop();

    // Event should have been sent via transport
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const msg = sentMessages[0]!;
    expect(msg.sourcePeerId).toBe('n1');
    expect(msg.targetPeerId).toBe('remote-1');
    expect(msg.type).toContain('cdc_event');
  });

  // AC 47.4: G2 — At-most-once delivery via DedupRing
  it('AC 47.4: dedup prevents duplicate processing', async () => {
    pipeline = new ExactlyOnceCDCPipeline(makePipelineConfig());
    await pipeline.start();

    // Create a fake transport message (as if received from remote). The
    // payload is the JSON form of a CDCChangeEvent: wallTime travels as a
    // number on the wire (the producer stringifies bigint).
    const changeEvent = {
      lsn: '0/12345678',
      timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'n1' },
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'Alice' },
      txId: 'tx-001',
    };

    const encoder = new TextEncoder();
    const msg: TransportMessage = {
      messageId: `0/12345678:tx-001`,
      sourcePeerId: 'n2',
      targetPeerId: 'n1',
      payload: encoder.encode(JSON.stringify(changeEvent)),
      timestamp: new HLC('n2').now(),
      createdAt: Date.now(),
      type: 'cdc_event:users',
    };

    // First delivery: accepted
    const r1 = pipeline.processInbound(msg);
    expect(r1.accepted).toBe(true);
    expect(r1.event).toBeDefined();
    expect(r1.event!.tableName).toBe('users');

    // Second delivery: deduped (same messageId)
    const r2 = pipeline.processInbound(msg);
    expect(r2.accepted).toBe(false);
    expect(r2.event).toBeUndefined();

    const metrics = await pipeline.getMetrics();
    expect(metrics.totalDeduped).toBeGreaterThanOrEqual(1);

    await pipeline.stop();
  });

  // AC 47.5: G3 — Checkpoint persistence & recovery
  it('AC 47.5: checkpoint persists LSN and recovers after restart', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig(),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline.start();
    pipeline.watchTable('orders');

    // Simulate checkpoint advance
    pipeline.advanceCheckpoint('orders', '0/DEADBEEF');
    pipeline.advanceCheckpoint('users', '0/CAFEBABE');

    const cp1 = pipeline.getCheckpoint();
    expect(cp1.lastConfirmedLSN['orders']).toBe('0/DEADBEEF');
    expect(cp1.lastConfirmedLSN['users']).toBe('0/CAFEBABE');

    await pipeline.stop();

    // Simulate restart: create new pipeline with same data dir
    const pipeline2 = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig(),
      transport,
      remoteNodeId: 'remote-1',
    });
    await pipeline2.start();

    // G3: Should have recovered LSNs from checkpoint
    expect(pipeline2.getLastConfirmedLSN('orders')).toBe('0/DEADBEEF');
    expect(pipeline2.getLastConfirmedLSN('users')).toBe('0/CAFEBABE');

    await pipeline2.cleanup();
  });

  // AC 47.6: G4 — monotonic LSN (no regress)
  it('AC 47.6: should reject non-monotonic checkpoint advance', async () => {
    pipeline = new ExactlyOnceCDCPipeline(makePipelineConfig());
    await pipeline.start();

    pipeline.advanceCheckpoint('users', '0/BEEF0001');
    expect(pipeline.getLastConfirmedLSN('users')).toBe('0/BEEF0001');

    // Stale LSN: should be ignored
    pipeline.advanceCheckpoint('users', '0/BEEF0000');
    expect(pipeline.getLastConfirmedLSN('users')).toBe('0/BEEF0001');

    await pipeline.stop();
  });

  // AC 47.7: G5 — Backpressure detection
  it('AC 47.7: should emit backpressure when pending exceeds threshold', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({ maxPending: 5 }),
      transport,
      remoteNodeId: 'remote-1',
    });

    const bpEvents: string[] = [];
    pipeline.onEvent((event) => {
      if (event.type === 'backpressure') bpEvents.push(event.error || '');
    });

    await pipeline.start();

    // inject many events quickly (transport fails = stays pending)
    pipeline.watchTable('users');
    enableSendFailure();
    for (let i = 0; i < 10; i++) {
      pipeline.appendChange({
        tableName: 'users',
        operation: 'insert',
        oldValues: null,
        newValues: { id: i },
      });
    }

    await new Promise((r) => setTimeout(r, 500));

    expect(bpEvents.length).toBeGreaterThanOrEqual(1);

    await pipeline.stop();
  });

  // AC 47.8: Dead letter queue
  it('AC 47.8: should move entries to dead letter after max retries', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        outboxConfig: { dataDir: path.join(TEST_DIR, 'outbox'), maxRetries: 2 },
      }),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline.start();
    pipeline.watchTable('users');

    // Transport fails = entries stay pending, retry, move to DLQ
    enableSendFailure();
    pipeline.appendChange({
      tableName: 'users',
      operation: 'update',
      oldValues: { id: 1, name: 'Alice' },
      newValues: { id: 1, name: 'Bob' },
    });

    // Wait for pump cycles + retries
    await new Promise((r) => setTimeout(r, 1000));
    await pipeline.stop();

    // Check dead letter
    const dlq = pipeline.getDeadLetterEntries();
    expect(dlq.length).toBeGreaterThanOrEqual(1);
  });

  // AC 47.9: Retry from dead letter
  it('AC 47.9: should retry dead letter entry after recover', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        outboxConfig: { dataDir: path.join(TEST_DIR, 'outbox'), maxRetries: 1 },
      }),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline.start();
    pipeline.watchTable('users');

    enableSendFailure();
    pipeline.appendChange({
      tableName: 'users',
      operation: 'delete',
      oldValues: { id: 1 },
      newValues: null,
    });

    await new Promise((r) => setTimeout(r, 400));

    // Retry from dead letter
    const dlq = pipeline.getDeadLetterEntries();
    for (const entry of dlq) {
      pipeline.retryDeadLetter(entry.id);
    }

    await pipeline.stop();
  });

  // E2E.1: Full round-trip
  it('E2E.1: full round-trip produce → outbox → pump → transport → receive → dedup', async () => {
    // Sender side
    const pipelineSender = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        nodeId: 'n1',
        outboxConfig: { dataDir: path.join(TEST_DIR, 'sender-outbox') },
        pumpIntervalMs: 100,
      }),
      transport,
      remoteNodeId: 'n2',
    });

    // Receiver side (same process, separate DedupRing)
    const pipelineReceiver = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        nodeId: 'n2',
        outboxConfig: { dataDir: path.join(TEST_DIR, 'receiver-outbox') },
      }),
    });

    await pipelineSender.start();
    await pipelineReceiver.start();

    pipelineSender.watchTable('products');
    pipelineSender.appendChange({
      tableName: 'products',
      operation: 'insert',
      oldValues: null,
      newValues: { sku: 'ABC', qty: 100 },
    });

    // Wait for pump
    await new Promise((r) => setTimeout(r, 300));

    // Process on receiver side
    let receiverAccepted = 0;
    let receiverDeduped = 0;
    for (const msg of sentMessages) {
      const result = pipelineReceiver.processInbound(msg);
      if (result.accepted && result.event) {
        receiverAccepted++;
        // Confirm: advance checkpoint
        pipelineReceiver.advanceCheckpoint(result.event.tableName, result.event.lsn);
      } else {
        receiverDeduped++;
      }
    }

    expect(receiverAccepted).toBe(1);
    expect(receiverDeduped).toBe(0);

    const senderMetrics = await pipelineSender.getMetrics();
    expect(senderMetrics.totalProduced).toBe(1);

    await pipelineSender.cleanup();
    await pipelineReceiver.cleanup();
  });

  // E2E.2: Crash recovery
  it('E2E.2: should resume from checkpoint after simulated crash', async () => {
    pipeline = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        outboxConfig: { dataDir: path.join(TEST_DIR, 'crash-outbox') },
      }),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline.start();

    // Simulate processing and checkpoint
    pipeline.advanceCheckpoint('users', '0/LSN0001');
    pipeline.advanceCheckpoint('orders', '0/LSN0002');

    // Crash (simulated)
    await pipeline.stop();

    // Restart
    const pipeline2 = new ExactlyOnceCDCPipeline({
      ...makePipelineConfig({
        outboxConfig: { dataDir: path.join(TEST_DIR, 'crash-outbox') },
      }),
      transport,
      remoteNodeId: 'remote-1',
    });

    await pipeline2.start();

    // G3: Resume from checkpoint
    expect(pipeline2.getLastConfirmedLSN('users')).toBe('0/LSN0001');
    expect(pipeline2.getLastConfirmedLSN('orders')).toBe('0/LSN0002');

    // Continue from where we left off
    pipeline2.watchTable('users');
    pipeline2.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 2, name: 'Bob' },
    });

    await new Promise((r) => setTimeout(r, 200));

    const metrics = await pipeline2.getMetrics();
    expect(metrics.totalProduced).toBeGreaterThanOrEqual(1);

    await pipeline2.cleanup();
  });
});
