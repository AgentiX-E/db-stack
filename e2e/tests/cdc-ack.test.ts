/**
 * AC-C23 — a frame the peer never applied is not a delivered change.
 *
 * The finding this suite exists for came out of an attempt to reproduce an ordering bug
 * with a flaky proxy: twenty changes were reported delivered while thirteen were applied,
 * `refusals: 0`, `deadLetterCount: 0`. Nothing had failed as far as the sender could tell,
 * because `TcpSecureTransport.send()` resolved `true` — the local kernel had accepted the
 * bytes for a connection whose peer was gone. The outbox was perfectly consistent about a
 * delivery that had not happened.
 *
 * The instrument that can close that gap is the peer, so the peer answers now
 * (`cdc_ack`), and the sender's "delivered" means "the receiving node applied this".
 *
 * This suite produces that state deterministically instead of hoping for it: the receiving
 * relay is started with `applyLimit`, so it drops every frame past the limit **before**
 * deduplication — which is precisely what "the write was accepted here and never arrived
 * there" looks like from the receiving end. Then it is released.
 *
 *   AC-C23 with the receiver holding after thirteen changes, the sender reports thirteen
 *          delivered, not twenty; the other seven are still pending and none is
 *          dead-lettered
 *   AC-C24 the receiver is released and every one of the twenty is applied once, in write
 *          order, with the sender's count catching up to the receiver's
 *
 * Two real processes, real TLS, a real change log written by a third process.
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

const TABLE = 'ack_orders';
const BATCH = 20;
/** How many changes the receiver is willing to apply before it is released. */
const HELD_AFTER = 13;

interface SenderStatus {
  metrics: {
    totalProduced: number;
    pendingCount: number;
    outboxDelivered: number;
    deadLetterCount: number;
    acksReceived: number;
    ackTimeouts: number;
  };
  pipelineConservation: { unaccounted: number; balanced: boolean };
  refusals: number;
}

interface ReceiverStatus {
  applied: number;
  held: number;
  deduped: number;
  delivered: number;
}

interface AppliedRow {
  lsn: string;
  table: string;
  operation: string;
  txId: string;
  values: { id: number; payload: string } | null;
}

const state: { sender?: ChildNode; receiver?: ChildNode; appliedFile?: string } = {};

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

describe('CDC delivery is the peer’s answer', () => {
  it('AC-C23: changes the receiver never applied are not reported delivered', async () => {
    const [eastPort, westPort] = await getFreePorts(2);
    const logDir = makeTempDir('ack-log');
    const eastDir = makeTempDir('ack-east');
    const westDir = makeTempDir('ack-west');
    dirs.push(logDir, eastDir, westDir);

    const writer = track(spawnChangeWriter({ dir: logDir, table: TABLE, nodeId: 'east' }, 'writer'));
    await writer.waitForType('ready', 30_000);

    const appliedFile = join(westDir, 'applied.jsonl');
    const receiver = track(
      spawnCdcRelay(
        {
          role: 'receiver',
          nodeId: 'dc-west',
          transportNodeId: 2,
          dir: westDir,
          appliedFile,
          listen: { host: '127.0.0.1', port: westPort },
          peer: { nodeId: 'dc-east', host: '127.0.0.1', port: eastPort, transportNodeId: 1 },
          tls: certs.nodes[1],
          // The hold. Everything past this is dropped before the dedup ring sees it, so a
          // retry is processed fresh rather than suppressed as a repeat.
          applyLimit: HELD_AFTER,
        },
        'receiver',
      ),
    );
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
          pumpBatchSize: 32,
          // Short, so the case learns "nothing answered" in a second rather than five.
          ackTimeoutMs: 1_000,
        },
        'sender',
      ),
    );
    await sender.waitForType('ready', 40_000);

    // Handed to the next case *before* any assertion can throw. A fixture assigned on
    // the last line of a case belongs to the case, not to the suite: the run that
    // produced iteration 70's report failed here on an ordering assertion, and the two
    // cases behind it failed on `undefined` instead of on what they are about.
    Object.assign(state, { sender, receiver, appliedFile });

    writer.send({ cmd: 'write', records: BATCH });
    await writer.waitFor((m) => m.type === 'done', 60_000, `the batch of ${BATCH} written`);

    await waitUntil(
      async () => (await receiver.status<ReceiverStatus>()).applied >= HELD_AFTER,
      60_000,
      `${HELD_AFTER} changes applied in dc-west`,
      50,
      () => receiver.status<ReceiverStatus>(),
    );

    // Wait for the first thirteen to be counted as delivered: under both behaviours that
    // happens quickly, and it is the population the assertion below is about.
    await waitUntil(
      async () => (await sender.status<SenderStatus>()).metrics.outboxDelivered >= HELD_AFTER,
      60_000,
      `the sender to report the first ${HELD_AFTER} delivered`,
      50,
      () => sender.status<SenderStatus>(),
    );

    // Then wait for *either* behaviour to show itself, so the assertion below is the thing
    // that fails rather than a timeout: an honest sender gives up waiting on the seven
    // (`ackTimeouts`), and the defect this case was written for counts them delivered at
    // once. A wait on the honest outcome alone took ninety seconds to report a defect the
    // counters could name in one.
    await waitUntil(
      async () => {
        const status = await sender.status<SenderStatus>();
        return status.metrics.ackTimeouts > 0 || status.metrics.outboxDelivered > HELD_AFTER;
      },
      90_000,
      'the sender to account for the seven unanswered frames',
      100,
      async () => ({
        metrics: (await sender.status<SenderStatus>()).metrics,
        applied: readJsonl<AppliedRow>(appliedFile).length,
      }),
    );

    const status = await sender.status<SenderStatus>();
    const applied = readJsonl<AppliedRow>(appliedFile);

    expect(applied.length).toBe(HELD_AFTER);
    // The claim the run of `44999465716`-era code got wrong: delivered means applied.
    expect(status.metrics.outboxDelivered).toBe(applied.length);
    expect(status.metrics.totalProduced).toBe(BATCH);
    // Conservation: nothing was thrown away to make the numbers agree.
    expect(status.metrics.pendingCount).toBe(BATCH - HELD_AFTER);
    expect(status.metrics.deadLetterCount).toBe(0);
    expect(status.metrics.acksReceived).toBeGreaterThanOrEqual(HELD_AFTER);
    expect(status.pipelineConservation).toMatchObject({ unaccounted: 0, balanced: true });

    const receiverStatus = await receiver.status<ReceiverStatus>();
    expect(receiverStatus.applied).toBe(HELD_AFTER);
    // Frames that arrived and were not applied — the reason the sender has nothing to
    // count them as.
    expect(receiverStatus.held).toBeGreaterThan(0);
    expect(receiverStatus.deduped).toBe(0);
  }, 240_000);

  it('AC-C24: released, every change is applied once, in write order', async () => {
    const { receiver, sender, appliedFile } = state as Required<typeof state>;

    receiver.send({ cmd: 'release' });
    await receiver.waitForType('released', 30_000);

    await waitUntil(
      async () => readJsonl<AppliedRow>(appliedFile).length >= BATCH,
      120_000,
      `all ${BATCH} changes applied after the release`,
      50,
      () => readJsonl<AppliedRow>(appliedFile).length,
    );

    // The sender's count catches up to the receiver's, which is the whole point: the two
    // numbers are two processes' answers to the same question.
    await waitUntil(
      async () => (await sender.status<SenderStatus>()).metrics.outboxDelivered === BATCH,
      120_000,
      'the sender to report every change delivered',
      50,
      async () => (await sender.status<SenderStatus>()).metrics,
    );

    const applied = readJsonl<AppliedRow>(appliedFile);
    expect(applied).toHaveLength(BATCH);
    // Exactly once and in the order the log assigned: the held frames were retried, and a
    // retry that was applied twice would show up here as a repeat.
    expect(applied.map((row) => row.values!.id)).toEqual(Array.from({ length: BATCH }, (_, i) => i + 1));
    expect(new Set(applied.map((row) => row.lsn)).size).toBe(BATCH);

    const status = await sender.status<SenderStatus>();
    expect(status.metrics.pendingCount).toBe(0);
    expect(status.metrics.deadLetterCount).toBe(0);
    expect(status.pipelineConservation).toMatchObject({ unaccounted: 0, balanced: true });
  }, 240_000);
});
