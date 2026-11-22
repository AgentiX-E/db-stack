/**
 * ExactlyOnceCDCPipeline — the pipeline that could only ever be fed by a stub.
 *
 * `this.cdc = new CDCEngine(...)` was hardcoded, so the one class in the package
 * whose job is to carry a *real* change stream could only be driven by
 * `appendChange()`'s simulated events. These cases wire it to a file log through
 * `WalTailCDCEngine` — the configuration a deployment uses — and check the parts
 * that were only observable once a real engine was in place:
 *
 *   AC 98.1  a record appended to a real log reaches the transport
 *   AC 98.2  appendChange on a log-wired pipeline is refused by name
 *   AC 98.3  the checkpoint orders positions numerically past the eight-digit
 *            boundary, and refuses to compare an LSN with a non-LSN
 *   AC 98.4  a checkpoint that exists and cannot be parsed is refused at start
 *   AC 98.5  advancing the checkpoint leaks no file descriptors
 *   AC 98.6  a throwing event listener does not stop the outbox pump
 *   AC 98.7  getMetrics() reports the outbox's sent count, and it balances
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExactlyOnceCDCPipeline, comparePositions } from './ExactlyOnceCDCPipeline';
import { FileChangeLogReader, FileChangeLogWriter } from './FileChangeLog';
import { WalTailCDCEngine } from './WalTailCDCEngine';
import { pipelineConservation } from '../monitoring/cdc-metrics';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { TransportStats } from '../interfaces/types';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingTransport(): { transport: ITransport; sent: TransportMessage[] } {
  const sent: TransportMessage[] = [];
  const transport: ITransport = {
    async send(message: TransportMessage): Promise<boolean> {
      sent.push(message);
      return true;
    },
    async broadcast(message: TransportMessage): Promise<number> {
      sent.push(message);
      return 1;
    },
    onMessage(): () => void {
      return () => undefined;
    },
    getConnectedPeers() {
      return [{ peerId: 'remote-1', address: '127.0.0.1:7001', connectedAt: Date.now(), latencyMs: 0 }];
    },
    getStats(): TransportStats {
      return {
        peersConnected: 1,
        messagesSent: sent.length,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        uptimeMs: 0,
      };
    },
  };
  return { transport, sent };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`condition not reached within ${timeoutMs} ms`);
}

const change = (table: string, id: number) => ({
  table,
  operation: 'insert' as const,
  newValues: { id },
  txId: `tx-${table}-${id}`,
});

describe('ExactlyOnceCDCPipeline — a real read end', () => {
  it('AC 98.1: a record appended to a real log reaches the transport', async () => {
    const dir = makeDir('pipeline-log-');
    const writer = await FileChangeLogWriter.open({ dir: join(dir, 'log') });
    const reader = await FileChangeLogReader.open({ dir: join(dir, 'log') });
    cleanups.push(async () => {
      await writer.close();
      await reader.close();
    });

    const engine = new WalTailCDCEngine({ reader, nodeId: 'n1', pollIntervalMs: 5 });
    const { transport, sent } = recordingTransport();
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      engine,
      outboxConfig: { dataDir: join(dir, 'outbox') },
      checkpointDir: join(dir, 'outbox'),
      transport,
      remoteNodeId: 'remote-1',
      pumpIntervalMs: 10,
      // The transport here only records; see the note in AC 47's config factory.
      acknowledgement: 'none',
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    await writer.append(change('orders', 1));
    await writer.append(change('orders', 2));
    await waitFor(() => sent.length === 2);

    // The message id is the log's position and the writer's transaction: two
    // processes that agree on nothing else agree on this.
    expect(sent.map((message) => message.messageId)).toEqual(['0/00000001:tx-orders-1', '0/00000002:tx-orders-2']);
    expect(pipeline.getLastConfirmedLSN('orders')).toBe('0/00000002');

    const metrics = await pipeline.getMetrics();
    expect(metrics.totalProduced).toBe(2);
    expect(pipelineConservation(metrics)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 98.2: appendChange on a log-wired pipeline is refused by name', async () => {
    const dir = makeDir('pipeline-refuse-');
    const reader = await FileChangeLogReader.open({ dir: join(dir, 'log') });
    cleanups.push(() => reader.close());
    const engine = new WalTailCDCEngine({ reader, nodeId: 'n1' });
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      engine,
      outboxConfig: { dataDir: join(dir, 'outbox') },
    });
    cleanups.push(() => pipeline.cleanup());

    expect(() =>
      pipeline.appendChange({ tableName: 'orders', operation: 'insert', oldValues: null, newValues: {} }),
    ).toThrow(/changes come from the log/);
  });

  it('AC 98.3: the checkpoint orders positions numerically past the eight-digit boundary', () => {
    // The case the string comparison got wrong: the ninth digit sorts before
    // "A" lexically and after it numerically.
    expect(comparePositions('0/100000000', '0/A0000000')).toBe(1);
    expect(comparePositions('0/A0000000', '0/100000000')).toBe(-1);
    expect(comparePositions('0/00000002', '0/00000002')).toBe(0);
    // Positions that are not this package's LSNs still compare, as text: the
    // checkpoint API is public and a consumer may key it by a Kafka offset.
    expect(comparePositions('offset-2', 'offset-10')).toBe(1);
    expect(() => comparePositions('0/00000002', 'offset-3')).toThrow(/cannot order/);
  });

  it('AC 98.4: a checkpoint that exists and cannot be parsed is refused at start', async () => {
    const dir = makeDir('pipeline-corrupt-');
    const outboxDir = join(dir, 'outbox');
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, 'cdc-checkpoint.json'), '{ not json');

    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: outboxDir },
    });
    cleanups.push(() => pipeline.cleanup());

    // Replaying the whole log is a decision; an unreadable checkpoint must not
    // make it silently, because the operator learns about it as duplicated rows.
    await expect(pipeline.start()).rejects.toThrow(/refusing to start/);
  });

  it('AC 98.5: advancing the checkpoint leaks no file descriptors', async () => {
    const dir = makeDir('pipeline-fds-');
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: join(dir, 'outbox') },
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    const countFds = () => readdirSync('/proc/self/fd').length;
    pipeline.advanceCheckpoint('orders', '0/00000001');
    const before = countFds();
    for (let i = 2; i <= 200; i++) {
      pipeline.advanceCheckpoint('orders', `0/${i.toString(16).toUpperCase().padStart(8, '0')}`);
    }
    const after = countFds();

    // The old flush opened a second descriptor per call and never closed it:
    // 200 checkpoints leaked 200 descriptors, and a pipeline writing at any
    // rate eventually hit EMFILE — reported as "checkpoint is not JSON".
    expect(after - before).toBeLessThanOrEqual(1);
    expect(JSON.parse(readFileSync(join(dir, 'outbox', 'cdc-checkpoint.json'), 'utf8'))).toMatchObject({
      lastConfirmedLSN: { orders: '0/000000C8' },
    });
  });

  it('AC 98.7: two datacenters whose outboxes both start at entry:1 do not deduplicate each other', async () => {
    // The collision the `entry:<sequence>` message id produced: the receiver's
    // DedupRing is keyed by message id, and two independent outboxes both begin
    // at sequence 1. Whichever arrived second was dropped as a duplicate of a
    // change it had never seen.
    const received: string[] = [];
    let dispatched = 0;
    const receiver = new ExactlyOnceCDCPipeline({
      nodeId: 'receiver',
      cdcConfig: { nodeId: 'receiver' },
      outboxConfig: { dataDir: join(makeDir('pipeline-rx-'), 'outbox') },
    });
    cleanups.push(() => receiver.cleanup());
    await receiver.start();

    for (const dc of ['dc-east', 'dc-west']) {
      const dir = makeDir(`pipeline-${dc}-`);
      const { transport } = recordingTransport();
      const sender = new ExactlyOnceCDCPipeline({
        nodeId: dc,
        cdcConfig: { nodeId: dc },
        outboxConfig: { dataDir: join(dir, 'outbox') },
        transport: {
          ...transport,
          async send(message: TransportMessage): Promise<boolean> {
            // Route the batch into the receiver's deduplication path.
            dispatched += 1;
            const result = receiver.processInbound(message);
            if (result.accepted) received.push(`${dc}:${result.event?.txId}`);
            return true;
          },
        },
        remoteNodeId: 'receiver',
        pumpIntervalMs: 10,
        acknowledgement: 'none',
      });
      cleanups.push(() => sender.cleanup());
      await sender.start();
      sender.appendChange({
        tableName: 'orders',
        operation: 'insert',
        oldValues: null,
        newValues: { id: 1 },
      });
    }
    await waitFor(() => dispatched === 2);

    expect(received).toHaveLength(2);
    expect(received.map((entry) => entry.split(':')[0])).toEqual(['dc-east', 'dc-west']);
    // Two different changes, two different transactions — and with the message
    // id taken from the entry's sequence, the second would have been dropped as
    // a duplicate of the first.
    expect(new Set(received).size).toBe(2);
    expect((await receiver.getMetrics()).totalDeduped).toBe(0);
  });

  it('AC 98.8: the checkpoint statics read what start() would read', async () => {
    const dir = makeDir('pipeline-static-');
    const outboxDir = join(dir, 'outbox');

    // No file yet: null, not an empty checkpoint — a caller has to know the
    // difference between "resume from the beginning" and "resume from the file
    // that is not there".
    expect(ExactlyOnceCDCPipeline.readCheckpoint(outboxDir)).toBeNull();
    expect(ExactlyOnceCDCPipeline.resumePosition(null)).toBeNull();

    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(
      join(outboxDir, 'cdc-checkpoint.json'),
      JSON.stringify({
        lastConfirmedLSN: { orders: '0/00000005', audit: '0/00000003' },
        updatedAt: 1_700_000_000_000,
        version: 1,
      }),
    );
    const checkpoint = ExactlyOnceCDCPipeline.readCheckpoint(outboxDir)!;
    expect(checkpoint.lastConfirmedLSN).toEqual({ orders: '0/00000005', audit: '0/00000003' });
    // The earliest, not the latest: the tail has one cursor, and resuming past
    // the lagging table would skip its rows for ever.
    expect(ExactlyOnceCDCPipeline.resumePosition(checkpoint)).toBe('0/00000003');

    // A checkpoint written by an older build has no `updatedAt` and no
    // `version`: they default rather than making the file unreadable.
    writeFileSync(join(outboxDir, 'cdc-checkpoint.json'), JSON.stringify({ lastConfirmedLSN: {} }));
    expect(ExactlyOnceCDCPipeline.readCheckpoint(outboxDir)).toEqual({
      lastConfirmedLSN: {},
      updatedAt: 0,
      version: 1,
    });
    // Nothing confirmed yet: no resume point, not an empty string.
    expect(ExactlyOnceCDCPipeline.resumePosition({ lastConfirmedLSN: {}, updatedAt: 0, version: 1 })).toBeNull();

    // A file with no map is refused rather than treated as empty.
    writeFileSync(join(outboxDir, 'cdc-checkpoint.json'), JSON.stringify({ updatedAt: 1 }));
    expect(() => ExactlyOnceCDCPipeline.readCheckpoint(outboxDir)).toThrow(/no lastConfirmedLSN map/);

    // A file that cannot be read for a reason other than absence is not null.
    const unreadable = join(dir, 'not-a-dir');
    writeFileSync(unreadable, 'x');
    expect(() => ExactlyOnceCDCPipeline.readCheckpoint(unreadable)).toThrow();
  });

  it('AC 98.9: an outbox that refuses an append is reported, not swallowed', async () => {
    const dir = makeDir('pipeline-append-fail-');
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: join(dir, 'outbox') },
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    const failures: string[] = [];
    pipeline.onEvent((event) => {
      if (event.type === 'event_failed') failures.push(String(event.error));
    });

    // Close the store underneath the pipeline: the next append is refused by
    // LMDB, which is the one state where a change is neither shipped nor
    // queued — and it used to be reported by nothing at all.
    (pipeline as unknown as { outbox: { close(): void } }).outbox.close();
    pipeline.appendChange({
      tableName: 'orders',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1 },
    });

    await waitFor(() => failures.length === 1);
    expect(failures[0]).toMatch(/outbox append failed/);
    expect(pipeline.appendError).toBeTruthy();
  });

  it('AC 98.10: an event listener can detach, and the dead-letter surface is reachable', async () => {
    const dir = makeDir('pipeline-detach-');
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: join(dir, 'outbox') },
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    const seen: string[] = [];
    const detach = pipeline.onEvent((event) => seen.push(event.type));
    pipeline.appendChange({ tableName: 'orders', operation: 'insert', oldValues: null, newValues: { id: 1 } });
    // The append is queued, and its `event_produced` is emitted from the queue:
    // detaching before it drains would detach from an event that has not been
    // announced yet, which is a property of the design rather than a race.
    await pipeline.getMetrics();
    detach();
    pipeline.appendChange({ tableName: 'orders', operation: 'insert', oldValues: null, newValues: { id: 2 } });
    await pipeline.getMetrics();

    expect(seen.filter((type) => type === 'event_produced')).toHaveLength(1);
    expect(pipeline.getDeadLetterEntries()).toEqual([]);
    expect(pipeline.retryDeadLetter('dlq:entry:1')).toBe(false);
  });

  it('AC 98.6: a throwing event listener does not stop the outbox pump', async () => {
    const dir = makeDir('pipeline-listener-');
    const { transport, sent } = recordingTransport();
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: join(dir, 'outbox') },
      transport,
      remoteNodeId: 'remote-1',
      pumpIntervalMs: 10,
      // The transport here only records; see the note in AC 47's config factory.
      acknowledgement: 'none',
    });
    cleanups.push(() => pipeline.cleanup());
    pipeline.onEvent(() => {
      throw new Error('an observer that throws must not abort a batch');
    });

    await pipeline.start();
    pipeline.appendChange({ tableName: 'orders', operation: 'insert', oldValues: null, newValues: { id: 1 } });
    await waitFor(() => sent.length === 1);

    expect(sent).toHaveLength(1);
    const metrics = await pipeline.getMetrics();
    expect(metrics.outboxDelivered).toBe(1);
    expect(pipelineConservation(metrics)).toMatchObject({ unaccounted: 0, balanced: true });
  });
});
