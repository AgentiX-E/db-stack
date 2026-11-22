/**
 * E2E — CDC from a log one process wrote to a sink in another process.
 *
 * Three real processes per run, no in-process shortcuts:
 *
 *   change-writer  →  appends records to `<dir>/changelog.jsonl` and fsyncs each
 *                     one; it stands in for the database engine's WAL
 *   cdc-relay      →  (sender) tails that file, ships each change to the peer DC
 *                     over TLS 1.3 with mutual verification, and delivers the same
 *                     change to an HTTP sink through the subscription pump
 *   cdc-relay      →  (receiver) deduplicates inbound frames and appends what it
 *                     accepted to a file on disk
 *   cdc-sink-server→  a real HTTP receiver that refuses the first request with 503
 *
 * Acceptance criteria:
 *   AC-C15  every record the writer fsynced reaches the other DC, once
 *   AC-C16  the same change reaches the HTTP sink over a real socket, in order,
 *           and a 503 is retried rather than dropped
 *   AC-C17  the sender's own counters satisfy the conservation identity
 *   AC-C18  a sender killed mid-stream resumes from its checkpoint: no change is
 *           lost, none is applied twice
 *   AC-C19  the exposition the sender renders parses as Prometheus text and
 *           agrees with its counters
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChildNode,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnCdcRelay,
  spawnCdcSinkServer,
  spawnChangeWriter,
  waitUntil,
} from '../harness/support';

const certs = makeCertificates(2);
const dirs: string[] = [];
const processes: ChildNode[] = [];

interface SenderStatus {
  engine: { position: string | null; emitted: number; readErrors: number; skipped: number };
  pump: {
    accepted: number;
    delivered: number;
    failed: number;
    dropped: number;
    pending: Record<string, number>;
    projectionFailed: number;
  } | null;
  pumpConservation: { unaccounted: number; balanced: boolean } | null;
  metrics: {
    totalProduced: number;
    outboxDelivered: number;
    pendingCount: number;
    deadLetterCount: number;
  };
  pipelineConservation: { unaccounted: number; balanced: boolean };
  checkpoint: { lastConfirmedLSN: Record<string, string> };
  resumePosition: string | null;
  exposition: string;
  transport: { peersConnected: number } | null;
}

interface ReceiverStatus {
  applied: number;
  deduped: number;
  delivered: number;
}

interface SinkStatus {
  requests: number;
  accepted: number;
  rejected: number;
  events: number;
}

interface AppliedRow {
  lsn: string;
  table: string;
  operation: string;
  txId: string;
  values: { id: number } | null;
}

const TABLE = 'orders';
const FIRST_BURST = 40;
const SECOND_BURST = 10;

function readJsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function track<T extends ChildNode>(child: T): T {
  processes.push(child);
  return child;
}

afterAll(async () => {
  for (const child of processes) {
    if (!child.exited) await child.terminate();
  }
  for (const dir of dirs) removeTempDir(dir);
});

describe('CDC over a real log, TLS and an HTTP sink', () => {
  it('boots the writer, the sink, and both relays', async () => {
    const [eastPort, westPort, sinkPort] = await getFreePorts(3);
    const logDir = makeTempDir('cdc-log');
    const eastDir = makeTempDir('cdc-east');
    const westDir = makeTempDir('cdc-west');
    dirs.push(logDir, eastDir, westDir);

    const writer = track(spawnChangeWriter({ dir: logDir, table: TABLE, nodeId: 'east' }, 'writer'));
    const ready = await writer.waitForType('ready', 30_000);
    expect(ready.data).toMatchObject({ length: 0, lastLsn: null });

    const appliedFile = join(westDir, 'applied.jsonl');
    const receivedFile = join(westDir, 'sink-received.jsonl');
    const sink = track(spawnCdcSinkServer({ port: sinkPort, receivedFile, failFirst: 1 }, 'sink'));
    const sinkReady = await sink.waitForType('ready', 20_000);
    expect((sinkReady.data as { port: number }).port).toBe(sinkPort);

    const receiver = track(
      spawnCdcRelay(
        {
          role: 'receiver',
          nodeId: 'dc-west',
          transportNodeId: 2,
          dir: westDir,
          appliedFile,
          listen: { host: '127.0.0.1', port: westPort },
          peer: {
            nodeId: 'dc-east',
            host: '127.0.0.1',
            port: eastPort,
            transportNodeId: 1,
          },
          tls: certs.nodes[1],
        },
        'receiver',
      ),
    );
    await receiver.waitForType('ready', 40_000);

    const senderConfig = {
      role: 'sender',
      nodeId: 'dc-east',
      transportNodeId: 1,
      dir: eastDir,
      logDir,
      table: TABLE,
      listen: { host: '127.0.0.1', port: eastPort },
      peer: { nodeId: 'dc-west', host: '127.0.0.1', port: westPort, transportNodeId: 2 },
      tls: certs.nodes[0],
      sink: { url: `http://127.0.0.1:${sinkPort}/cdc` },
      pollIntervalMs: 10,
      pumpIntervalMs: 20,
    };
    const sender = track(spawnCdcRelay(senderConfig, 'sender'));
    const senderReady = await sender.waitForType('ready', 40_000);
    expect(senderReady.data).toMatchObject({ resumeFrom: null });

    // Keep the handles for the cases below: this suite is one run of one system.
    Object.assign(state, { writer, sink, receiver, sender, appliedFile, receivedFile, senderConfig });
  }, 120_000);

  it('AC-C15: every record the writer fsynced reaches the other DC, once', async () => {
    state.writer.send({ cmd: 'write', records: FIRST_BURST });
    const done = await state.writer.waitForType('done', 60_000);
    expect(done.data).toMatchObject({ length: FIRST_BURST });

    await waitUntil(
      async () => (await state.receiver.status<ReceiverStatus>()).applied >= FIRST_BURST,
      60_000,
      `${FIRST_BURST} changes applied in dc-west`,
      100,
      () => state.receiver.status<ReceiverStatus>(),
    );

    const applied = readJsonl<AppliedRow>(state.appliedFile);
    expect(applied).toHaveLength(FIRST_BURST);
    const lsns = applied.map((row) => row.lsn);
    expect(new Set(lsns).size).toBe(FIRST_BURST);

    // Two claims, checked separately, because they fail in different places.
    //
    // The writer reports the position of every record as it appends it, so this is the
    // order the *log* assigned — the first claim, and the one the reader cannot be
    // blamed for. A single assertion against `sort()` said "somebody reordered these"
    // and nothing about which side; this run had to be re-read from a CI log to find out.
    const assigned = state.writer.messages
      .filter((message) => message.type === 'written')
      .map((message) => (message.data as { lsn: string }).lsn);
    expect(assigned).toHaveLength(FIRST_BURST);
    expect([...assigned].sort()).toEqual(assigned);

    // The second claim: the order the writer assigned is the order the reader saw and
    // the order the peer committed — the whole point of a single-cursor tail.
    expect(lsns).toEqual(assigned);
    expect(applied[0]).toMatchObject({ table: TABLE, operation: 'insert' });
    expect(applied[0]!.values?.id).toBe(1);
    expect(applied.at(-1)!.values?.id).toBe(FIRST_BURST);
  }, 120_000);

  it('AC-C16: the same changes reach the HTTP sink, in order, and a 503 is retried', async () => {
    await waitUntil(
      async () => (await state.sink.status<SinkStatus>()).events >= FIRST_BURST,
      60_000,
      'the sink to receive every change',
      100,
      () => state.sink.status<SinkStatus>(),
    );

    const sink = await state.sink.status<SinkStatus>();
    // The receiver refused the first request with 503 and the pump tried again:
    // a refused batch is retried, not dropped, and not counted as delivered.
    expect(sink.rejected).toBe(1);
    expect(sink.accepted).toBeGreaterThanOrEqual(FIRST_BURST);

    const received = readJsonl<{ id: string; table: string; data: { id: number } }>(state.receivedFile);
    const ids = received.map((row) => row.id);
    expect(new Set(ids).size).toBe(FIRST_BURST);
    // First-appearance order is the log's order.
    const firstAppearance = received.filter((row, index) => ids.indexOf(row.id) === index);
    const lsnOrder = firstAppearance.map((row) => row.id.split(':')[0]!);
    expect([...lsnOrder].sort()).toEqual(lsnOrder);
    expect(received.every((row) => row.table === TABLE)).toBe(true);
  }, 120_000);

  it('AC-C17: the sender own counters satisfy the conservation identity', async () => {
    const status = await state.sender.status<SenderStatus>();

    expect(status.engine.emitted).toBe(FIRST_BURST);
    expect(status.engine.readErrors).toBe(0);
    expect(status.engine.position).toBe(status.checkpoint.lastConfirmedLSN[TABLE]);

    expect(status.pump).not.toBeNull();
    expect(status.pumpConservation).toMatchObject({ unaccounted: 0, balanced: true });
    expect(status.pipelineConservation).toMatchObject({ unaccounted: 0, balanced: true });
    // Every change is in exactly one of the three places the outbox can put it.
    expect(status.metrics.totalProduced).toBe(FIRST_BURST);
    expect(status.metrics.pendingCount + status.metrics.outboxDelivered + status.metrics.deadLetterCount).toBe(
      FIRST_BURST,
    );
  }, 60_000);

  it('AC-C19: the exposition parses as Prometheus text and agrees with the counters', async () => {
    const status = await state.sender.status<SenderStatus>();
    const lines = status.exposition.split('\n').filter((line) => line.length > 0);

    const samples: Array<{ name: string; labels: string; value: number }> = [];
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      const match = /^(db_federation_[a-z_]+)(\{[^}]*\}) (-?\d+)$/.exec(line);
      expect(match, `unparseable exposition line: ${line}`).not.toBeNull();
      samples.push({ name: match![1]!, labels: match![2]!, value: Number(match![3]) });
    }

    const value = (name: string): number | undefined =>
      samples.find((sample) => sample.name === name && sample.labels.includes('node="dc-east"'))?.value;

    expect(value('db_federation_cdc_pump_accepted_total')).toBe(status.pump!.accepted);
    expect(value('db_federation_cdc_pump_delivered_total')).toBe(status.pump!.delivered);
    expect(value('db_federation_cdc_pump_unaccounted')).toBe(0);
    expect(value('db_federation_cdc_pipeline_produced_total')).toBe(FIRST_BURST);
    expect(value('db_federation_cdc_pipeline_unaccounted')).toBe(0);
    expect(value('db_federation_cdc_pump_pending')).toBe(0);
  }, 60_000);

  it('AC-C18: a sender killed mid-stream resumes from its checkpoint without loss or double apply', async () => {
    const before = readJsonl<AppliedRow>(state.appliedFile);
    const checkpoint = (await state.sender.status<SenderStatus>()).checkpoint;
    // The checkpoint names the writer's last position, not the outbox's local
    // sequence — `entry:12`.split(':')[0] is `entry`, which is what the pump
    // used to record and never advanced past.
    expect(checkpoint.lastConfirmedLSN[TABLE]).toBe(`0/${FIRST_BURST.toString(16).toUpperCase().padStart(8, '0')}`);

    state.sender.kill('SIGKILL');
    await state.sender.waitForExit();

    state.writer.send({ cmd: 'write', records: SECOND_BURST });
    await state.writer.waitForType('done', 60_000);

    const resumed = track(spawnCdcRelay(state.senderConfig, 'sender-restarted'));
    const ready = await resumed.waitForType('ready', 40_000);
    expect(ready.data).toMatchObject({ resumeFrom: checkpoint.lastConfirmedLSN[TABLE] });
    state.sender = resumed;

    await waitUntil(
      async () => (await state.receiver.status<ReceiverStatus>()).applied >= FIRST_BURST + SECOND_BURST,
      60_000,
      'the restarted sender to catch up',
      100,
      () => state.receiver.status<ReceiverStatus>(),
    );

    const applied = readJsonl<AppliedRow>(state.appliedFile);
    expect(applied).toHaveLength(FIRST_BURST + SECOND_BURST);
    const lsns = applied.map((row) => row.lsn);
    // No loss: every position from the first to the last is present.
    expect(new Set(lsns).size).toBe(FIRST_BURST + SECOND_BURST);
    // No double apply: the receiver's dedup ring suppressed anything the sender
    // replayed, and it says so.
    const receiverStatus = await state.receiver.status<ReceiverStatus>();
    expect(receiverStatus.delivered).toBe(FIRST_BURST + SECOND_BURST);
    expect(before.length).toBe(FIRST_BURST);
  }, 180_000);
});

/**
 * Shared handles.
 *
 * Declared after the first case so each case reads as a sentence about one
 * property; the suite is a single system under test, booted once, and vitest
 * runs the cases in file order.
 */
const state = {
  writer: null as unknown as ChildNode,
  sink: null as unknown as ChildNode,
  receiver: null as unknown as ChildNode,
  sender: null as unknown as ChildNode,
  appliedFile: '',
  receivedFile: '',
  senderConfig: {} as Record<string, unknown>,
};
