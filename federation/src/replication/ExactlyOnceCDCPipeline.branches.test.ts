/**
 * ExactlyOnceCDCPipeline — the arms nothing could reach, and what they said.
 *
 * The per-file coverage gate failed this file at 88.97 % branches while the
 * package average passed, which is the only reason these cases exist: each one
 * is an answer the pipeline gives to a state a deployment can put it in, and
 * three of them were answers written twice.
 *
 *   AC 99.1  a checkpoint whose bookkeeping is not numeric still starts, with the
 *            bookkeeping defaulted — the map decides where the tail resumes
 *   AC 99.2  a checkpoint without a position map is refused, in four shapes
 *   AC 99.3  a file that is not JSON is refused with the same words start() uses
 *   AC 99.4  a checkpoint that cannot be read for a reason other than "absent" is
 *            not a first run
 *   AC 99.5  two identical opaque positions compare equal, not "greater"
 *   AC 99.6  an entry stored without a message id is delivered under its entry id
 *   AC 99.7  an id with no separator is its own position, not a prefix of one
 *   AC 99.8  a transport that rejects with a string still produces a named error
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExactlyOnceCDCPipeline, comparePositions } from './ExactlyOnceCDCPipeline';
import type { CDCPipelineEvent } from './ExactlyOnceCDCPipeline';
import { OutboxStore } from '../storage/OutboxStore';
import { HLC } from '../hlc/HLC';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const checkpointPath = (dir: string): string => join(dir, 'cdc-checkpoint.json');

function writeCheckpoint(dir: string, body: string): void {
  writeFileSync(checkpointPath(dir), body);
}

/** A transport that answers whatever the case needs and records what it was given. */
function transport(answer: () => Promise<boolean> | boolean): {
  transport: ITransport;
  sent: TransportMessage[];
} {
  const sent: TransportMessage[] = [];
  const double: ITransport = {
    async send(message: TransportMessage): Promise<boolean> {
      sent.push(message);
      return answer();
    },
    async broadcast(message: TransportMessage): Promise<number> {
      sent.push(message);
      return 1;
    },
    onMessage(): () => void {
      return () => undefined;
    },
    getConnectedPeers() {
      return [{ peerId: 'dc-b', address: '127.0.0.1:7000', connectedAt: Date.now(), latencyMs: 0 }];
    },
    getStats() {
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
  return { transport: double, sent };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`condition not reached within ${timeoutMs} ms`);
}

describe('ExactlyOnceCDCPipeline — the checkpoint, read by the door a deployment uses', () => {
  it('AC 99.1: a checkpoint whose bookkeeping is not numeric still starts, with the bookkeeping defaulted', () => {
    const dir = makeDir('checkpoint-bookkeeping-');
    // A hand-edited or older-build file: the map is right and the two fields are
    // strings. Refusing to start over them would turn a cosmetic problem into an
    // outage, and the map is the only field that decides anything.
    writeCheckpoint(
      dir,
      JSON.stringify({ lastConfirmedLSN: { orders: '0/00000005' }, updatedAt: 'yesterday', version: '2' }),
    );

    expect(ExactlyOnceCDCPipeline.readCheckpoint(dir)).toEqual({
      lastConfirmedLSN: { orders: '0/00000005' },
      updatedAt: 0,
      version: 1,
    });
  });

  it('AC 99.2: a checkpoint without a position map is refused, in four shapes', () => {
    const dir = makeDir('checkpoint-map-');
    // `null`, a scalar, a map of the wrong type and an empty object: four ways to
    // say "this file does not know where the tail was". Each has to be refused
    // rather than read as "no position yet", which would replay the log.
    for (const body of ['null', '3', '{"lastConfirmedLSN":"0/00000005"}', '{}']) {
      writeCheckpoint(dir, body);
      expect(() => ExactlyOnceCDCPipeline.readCheckpoint(dir), body).toThrow(/no lastConfirmedLSN map/);
    }
  });

  it('AC 99.3: a file that is not JSON is refused with the same words start() uses', () => {
    const dir = makeDir('checkpoint-json-');
    writeCheckpoint(dir, '{ not json');
    // The two doors used to disagree: `start()` explained the consequence and
    // named the file, `readCheckpoint()` let `JSON.parse`'s own SyntaxError out.
    // A caller that reads the checkpoint first would have seen the weaker message.
    expect(() => ExactlyOnceCDCPipeline.readCheckpoint(dir)).toThrow(
      /cdc-checkpoint\.json: checkpoint is not JSON .*refusing to start/,
    );
  });

  it('AC 99.4: a checkpoint that cannot be read for a reason other than "absent" is not a first run', async () => {
    const dir = makeDir('checkpoint-eisdir-');
    // A directory named like the checkpoint: the read fails with EISDIR, which is
    // not "no checkpoint yet". Treating it as absent would overwrite whatever the
    // operator put there and replay the log on top of it.
    mkdirSync(checkpointPath(dir));
    expect(() => ExactlyOnceCDCPipeline.readCheckpoint(dir)).toThrow(/EISDIR/);

    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: join(dir, 'outbox') },
      checkpointDir: dir,
      transport: transport(async () => true).transport,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());
    // `start()` is async, so the refusal arrives as a rejection. Awaiting it is
    // the difference between asserting the refusal and asserting nothing.
    await expect(pipeline.start()).rejects.toThrow(/EISDIR/);

    // And cleaning up after the refusal must not write the empty default over the
    // file that caused it: `stop()` flushed the working copy unconditionally, so
    // the operator's checkpoint was replaced by `{}` exactly when the pipeline
    // said it would not replay from the beginning.
    await pipeline.cleanup();
    expect(
      statSync(checkpointPath(dir)).isDirectory(),
      'the file that caused the refusal was replaced by an invented checkpoint',
    ).toBe(true);
  });

  it('AC 99.5: two identical opaque positions compare equal, not "greater"', () => {
    // The numeric branch was covered; the lexical one had only ever been asked
    // "which comes first". Equal is the answer a resumption relies on: a
    // checkpoint equal to the tail's position must not be advanced past itself.
    expect(comparePositions('tx-a', 'tx-a')).toBe(0);
    expect(comparePositions('tx-a', 'tx-b')).toBe(-1);
    expect(comparePositions('tx-b', 'tx-a')).toBe(1);
  });
});

describe('ExactlyOnceCDCPipeline — entries a producer wrote, not the ones it simulates', () => {
  it('AC 99.6: an entry stored without a message id is delivered under its entry id', async () => {
    const dir = makeDir('pipeline-no-msgid-');
    const outboxDir = join(dir, 'outbox');

    // Written through the public store, by a producer that set no message id —
    // the case the fallback in `messageIdOf` exists for.
    const producer = new OutboxStore({ dataDir: outboxDir });
    const stored = await producer.add({
      targetPeerIds: ['dc-b'],
      payload: new TextEncoder().encode(
        JSON.stringify({ lsn: '0/00000001', tableName: 'orders', operation: 'insert' }),
      ),
      timestamp: new HLC('n1').now(),
      type: 'cdc:0/00000001',
    });
    producer.close();

    const { transport: carrier, sent } = transport(async () => true);
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: outboxDir },
      checkpointDir: outboxDir,
      transport: carrier,
      remoteNodeId: 'dc-b',
      pumpIntervalMs: 10,
    });
    cleanups.push(() => pipeline.cleanup());

    pipeline.start();
    await waitFor(() => sent.length > 0);
    expect(sent[0]?.messageId, 'an entry with no message id lost its identity').toBe(stored.id);
    // The position comes from the id's prefix, which for a store id is `entry` —
    // a string that is not a position, and the reason the checkpoint used to
    // record it for ever.
    expect(sent[0]?.type).toBe('cdc_event:entry');
  });

  it('AC 99.7: an id with no separator is its own position, not a prefix of one', async () => {
    const dir = makeDir('pipeline-offset-');
    const outboxDir = join(dir, 'outbox');

    // A log that numbers its own records (a Kafka offset) has no `lsn:txId`
    // shape. The checkpoint API accepts it, so the pump must not slice it at a
    // separator that is not there.
    const producer = new OutboxStore({ dataDir: outboxDir });
    await producer.add({
      msgId: 'offset-42',
      targetPeerIds: ['dc-b'],
      payload: new TextEncoder().encode(JSON.stringify({ lsn: 'offset-42', tableName: 'orders', operation: 'insert' })),
      timestamp: new HLC('n1').now(),
      type: 'cdc:offset-42',
    });
    producer.close();

    const { transport: carrier, sent } = transport(async () => true);
    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: outboxDir },
      checkpointDir: outboxDir,
      transport: carrier,
      remoteNodeId: 'dc-b',
      pumpIntervalMs: 10,
    });
    cleanups.push(() => pipeline.cleanup());

    pipeline.start();
    await waitFor(() => sent.length > 0);
    expect(sent[0]?.messageId).toBe('offset-42');
    expect(sent[0]?.type).toBe('cdc_event:offset-42');
  });

  it('AC 99.8: a transport that rejects with a string still produces a named error', async () => {
    const dir = makeDir('pipeline-string-throw-');
    const outboxDir = join(dir, 'outbox');

    const producer = new OutboxStore({ dataDir: outboxDir });
    await producer.add({
      msgId: '0/00000009:tx-9',
      targetPeerIds: ['dc-b'],
      payload: new TextEncoder().encode(
        JSON.stringify({ lsn: '0/00000009', tableName: 'orders', operation: 'insert' }),
      ),
      timestamp: new HLC('n1').now(),
      type: 'cdc:0/00000009',
    });
    producer.close();

    // A port is not obliged to throw Errors. This one throws a string, which is
    // the only way the `String(err)` arm of the error renderer is reachable — and
    // it used to be unreachable at three of its four call sites.
    const carrier: ITransport = {
      async send(): Promise<boolean> {
        // eslint-disable-next-line no-throw-literal -- the port rejects with a string
        throw 'socket closed by peer';
      },
      async broadcast(): Promise<number> {
        // eslint-disable-next-line no-throw-literal -- the port rejects with a string
        throw 'socket closed by peer';
      },
      onMessage(): () => void {
        return () => undefined;
      },
      getConnectedPeers() {
        return [];
      },
      getStats() {
        return {
          peersConnected: 0,
          messagesSent: 0,
          messagesReceived: 0,
          bytesSent: 0,
          bytesReceived: 0,
          uptimeMs: 0,
        };
      },
    };

    const pipeline = new ExactlyOnceCDCPipeline({
      nodeId: 'n1',
      cdcConfig: { nodeId: 'n1' },
      outboxConfig: { dataDir: outboxDir },
      checkpointDir: outboxDir,
      transport: carrier,
      remoteNodeId: 'dc-b',
      pumpIntervalMs: 10,
    });
    cleanups.push(() => pipeline.cleanup());

    const errors: string[] = [];
    pipeline.onEvent((event: CDCPipelineEvent) => {
      if (event.type === 'pump_error') errors.push(String(event.error));
    });

    pipeline.start();
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toBe('socket closed by peer');
  });
});
