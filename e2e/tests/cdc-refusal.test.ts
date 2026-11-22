/**
 * AC-C20 — the CDC pump across a refused send and the peer's return.
 *
 * `AC-C15` asserts that forty real records reach the other datacenter once, in order. It
 * cannot make a send *fail*: the inversion that produced the ordering bug — entry 13
 * refused, entries 14 and 15 sent, 13's retry landing after them — was a timing accident
 * on a loaded runner. `AC 47.11` reproduces it in-process with a transport that refuses
 * exactly once, and an in-process transport is a stand-in for the wire rather than the
 * wire.
 *
 * This suite takes the peer away and gives it back: a second datacenter, TLS between the
 * two, and the receiving relay stopped while a batch is written. Every send in that window
 * is refused by `TcpSecureTransport` rather than buffered, the pump keeps the entries, and
 * the sender counts the refusals itself — so "a refusal happened" is an observation about
 * the run rather than an assumption about it.
 *
 * What each case is for:
 *
 *   AC-C20 the system is up and the first batch is applied in order
 *   AC-C21 with the receiver stopped, the next batch stays **pending** rather than being
 *          marked delivered, and nothing reaches the log — the refusal is counted by the
 *          sender, so the premise is asserted rather than assumed
 *   AC-C22 the receiver returns, the batch that waited is applied, and the whole log is
 *          exactly once and in write order across the refusal
 *
 * What this suite does *not* do, and the reason it is a finding rather than an omission:
 * cutting the connection *mid-batch* — a proxy that forwards one chunk and then destroys
 * both sockets — does not produce a refusal at all. `transport.send()` answers `true` for a
 * frame the local kernel accepts and the peer never reads, the outbox marks it delivered,
 * and it is gone: on the run that tried it, twenty entries were reported delivered while
 * thirteen were applied, with `refusals: 0` and `deadLetterCount: 0`. Delivering at least
 * once across a reset needs the receiver to confirm the frame — an ack, not a write — which
 * is a protocol change registered as P3-66, and this suite will grow its fourth case when
 * that lands.
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
  spawnChangeWriter,
  waitUntil,
} from '../harness/support';

const certs = makeCertificates(2);
const dirs: string[] = [];
const processes: ChildNode[] = [];

const TABLE = 'refusal_orders';
const FIRST_BATCH = 12;
const SECOND_BATCH = 8;
const THIRD_BATCH = 6;

interface SenderStatus {
  metrics: { totalProduced: number; pendingCount: number; outboxDelivered: number; deadLetterCount: number };
  pipelineConservation: { unaccounted: number; balanced: boolean };
  checkpoint: { lastConfirmedLSN: Record<string, string> };
  transport: { peersConnected: number } | null;
  refusals: number;
}

interface AppliedRow {
  lsn: string;
  table: string;
  operation: string;
  txId: string;
  values: { id: number; payload: string } | null;
}

const state: {
  writer?: ChildNode;
  sender?: ChildNode;
  receiver?: ChildNode;
  appliedFile?: string;
  receiverConfig?: Record<string, unknown>;
} = {};

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

/** The write order the writer assigned, read back from what was applied. */
function writeOrder(rows: readonly AppliedRow[]): number[] {
  return rows.map((row) => row.values!.id);
}

/**
 * Write a batch and wait for *that* batch's `done`.
 *
 * Matched from the message count onward, for the reason `ChildNode.request` documents:
 * every `write` is answered with a `done`, and a wait that matched the first `done` in the
 * buffer would answer the second batch with the first batch's length — a test that passes
 * while the records are still unwritten.
 */
async function writeBatch(writer: ChildNode, records: number, expectedTotal: number): Promise<void> {
  const start = writer.messages.length;
  writer.send({ cmd: 'write', records });
  const done = await writer.waitFor(
    (m) => m.type === 'done' && writer.messages.indexOf(m) >= start,
    60_000,
    `the batch of ${records} written`,
  );
  expect(done.data).toMatchObject({ length: expectedTotal });
}

afterAll(async () => {
  for (const child of processes) {
    if (!child.exited) await child.terminate();
  }
  for (const dir of dirs) removeTempDir(dir);
});

describe('CDC across a refused send and a returning peer', () => {
  it('AC-C20: the system is up and the first batch is applied in order', async () => {
    const [eastPort, westPort] = await getFreePorts(2);
    const logDir = makeTempDir('refusal-log');
    const eastDir = makeTempDir('refusal-east');
    const westDir = makeTempDir('refusal-west');
    dirs.push(logDir, eastDir, westDir);

    const writer = track(spawnChangeWriter({ dir: logDir, table: TABLE, nodeId: 'east' }, 'writer'));
    const ready = await writer.waitForType('ready', 30_000);
    expect(ready.data).toMatchObject({ length: 0, lastLsn: null });

    const appliedFile = join(westDir, 'applied.jsonl');
    const receiverConfig = {
      role: 'receiver',
      nodeId: 'dc-west',
      transportNodeId: 2,
      dir: westDir,
      appliedFile,
      listen: { host: '127.0.0.1', port: westPort },
      peer: { nodeId: 'dc-east', host: '127.0.0.1', port: eastPort, transportNodeId: 1 },
      tls: certs.nodes[1],
    };
    const receiver = track(spawnCdcRelay(receiverConfig, 'receiver'));
    await receiver.waitForType('ready', 40_000);

    const sender = track(
      spawnCdcRelay(
        {
          role: 'sender',
          nodeId: 'dc-east',
          transportNodeId: 1,
          dir: eastDir,
          logDir,
          table: TABLE,
          listen: { host: '127.0.0.1', port: eastPort },
          peer: { nodeId: 'dc-west', host: '127.0.0.1', port: westPort, transportNodeId: 2 },
          tls: certs.nodes[0],
          pollIntervalMs: 10,
          pumpIntervalMs: 20,
          // The outage below lasts longer than the outbox's default retry budget — three
          // attempts, which at a 20 ms pump interval is 60 ms of peer absence — and a
          // change in the dead-letter queue is not a refusal this suite is about: it is a
          // change thrown away. That budget is P3-67; here the case needs the entries to
          // still be there when the receiver comes back.
          outboxMaxRetries: 100_000,
        },
        'sender',
      ),
    );
    const senderReady = await sender.waitForType('ready', 40_000);
    expect(senderReady.data).toMatchObject({ resumeFrom: null });

    await writeBatch(writer, FIRST_BATCH, FIRST_BATCH);
    await waitUntil(
      async () => readJsonl<AppliedRow>(appliedFile).length >= FIRST_BATCH,
      60_000,
      `${FIRST_BATCH} changes applied in dc-west`,
      50,
      () => readJsonl<AppliedRow>(appliedFile).length,
    );

    expect(writeOrder(readJsonl<AppliedRow>(appliedFile))).toEqual(
      Array.from({ length: FIRST_BATCH }, (_, i) => i + 1),
    );
    expect((await sender.status<SenderStatus>()).refusals).toBe(0);

    Object.assign(state, { writer, sender, receiver, appliedFile, receiverConfig });
  }, 180_000);

  it('AC-C21: with the receiver stopped the next batch stays pending, and nothing is applied', async () => {
    const { writer, sender, receiver, appliedFile } = state as Required<typeof state>;
    const before = readJsonl<AppliedRow>(appliedFile).length;
    expect(before).toBe(FIRST_BATCH);

    await receiver.terminate();
    expect(receiver.exited).toBe(true);

    // Wait for the *sender* to notice before writing anything: a closed socket is not the
    // same event as a refused send, and a frame written in between can still be accepted
    // by the local kernel. No connected peer is the state in which `send()` answers false
    // instead of buffering.
    await waitUntil(
      async () => (await sender.status<SenderStatus>()).transport?.peersConnected === 0,
      60_000,
      'the sender to notice that its peer is gone',
      50,
      () => sender.status<SenderStatus>(),
    );

    await writeBatch(writer, SECOND_BATCH, before + SECOND_BATCH);

    // The refusal has to be visible as *pending* entries: a pump that marked them
    // delivered would show `pendingCount: 0` here and lose them on the next restart.
    await waitUntil(
      async () => {
        const status = await sender.status<SenderStatus>();
        return status.metrics.pendingCount >= SECOND_BATCH && status.refusals > 0;
      },
      60_000,
      'the second batch pending after refusals',
      50,
      () => sender.status<SenderStatus>(),
    );

    const status = await sender.status<SenderStatus>();
    expect(status.metrics.totalProduced).toBe(before + SECOND_BATCH);
    expect(status.metrics.deadLetterCount).toBe(0);
    // Everything produced before the outage was handed over; the batch written into a
    // peerless datacenter was not.
    expect(status.metrics.outboxDelivered).toBe(before);
    // And the applied log has not moved: nothing was written while the peer was away.
    expect(readJsonl<AppliedRow>(appliedFile)).toHaveLength(before);
  }, 120_000);

  it('AC-C22: the receiver returns, and every record is applied once, in write order', async () => {
    const { sender, appliedFile } = state as Required<typeof state>;
    const total = FIRST_BATCH + SECOND_BATCH;

    // The same port, the same directory, the same applied file: a receiver that comes back
    // where it was, which is the ordinary shape of a restart.
    const receiver = track(spawnCdcRelay(state.receiverConfig!, 'receiver-again'));
    await receiver.waitForType('ready', 40_000);

    await waitUntil(
      async () => readJsonl<AppliedRow>(appliedFile).length >= total,
      90_000,
      `all ${total} changes applied after the peer returned`,
      50,
      async () => ({
        applied: readJsonl<AppliedRow>(appliedFile).length,
        sender: await sender.status<SenderStatus>(),
      }),
    );

    const applied = readJsonl<AppliedRow>(appliedFile);
    // Exactly once: the batch that could not be sent was retried, not duplicated.
    expect(applied).toHaveLength(total);
    expect(new Set(applied.map((row) => row.lsn)).size).toBe(total);
    // And in the order the writer assigned: 13..20 follow 1..12 although every one of
    // their first attempts was refused.
    expect(writeOrder(applied)).toEqual(Array.from({ length: total }, (_, i) => i + 1));

    const status = await sender.status<SenderStatus>();
    expect(status.metrics.pendingCount).toBe(0);
    expect(status.metrics.outboxDelivered).toBe(total);
    expect(status.metrics.deadLetterCount).toBe(0);
    // The conservation identity, on the sender that lived through the refusal: what it
    // produced is what it delivered, and nothing is unaccounted for.
    expect(status.pipelineConservation).toMatchObject({ unaccounted: 0, balanced: true });
  }, 180_000);
});
