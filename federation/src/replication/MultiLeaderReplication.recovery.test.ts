/**
 * MultiLeaderReplication — recovery of a target that was written off.
 *
 * Three defects met in this class:
 *
 *   1. `retryFailed()` was a promise: it reset the failure counter, scheduled a
 *      tick, and returned a hard `0`. Its comment said a future iteration would
 *      iterate the dead letter queue. Nothing did.
 *   2. `stop()` unsubscribed `target-connected`, `target-disconnected` and
 *      `high-lag`; there was no `target-recovered`. Worse, the only place that
 *      could have emitted one was the success branch of `doTick()`, and when
 *      every pending entry has been dead-lettered the worker sees an empty
 *      batch — so the branch that reports recovery was unreachable exactly
 *      when recovery mattered.
 *   3. `getStatus()` computed `lagMs` as `now - lastSuccessAt`, which grows on
 *      an idle channel. A target that had been quiet for five minutes after one
 *      successful write reported itself critical.
 *
 * The lag assertions are the reason this file exists: a lag figure that is a
 * clock subtraction cannot distinguish "nothing to send" from "unable to send",
 * and the operator reading it cannot either.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MultiLeaderReplication } from './MultiLeaderReplication';
import { InProcessTransport } from '../transport/InProcessTransport';
import { OutboxStore } from '../storage/OutboxStore';
import { HLC } from '../hlc/HLC';
import type { ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';

interface Fixture {
  replication: MultiLeaderReplication;
  outbox: OutboxStore;
  sender: InProcessTransport;
  receiver: InProcessTransport;
  cleanup: () => void;
}

const cleanups: Array<() => void> = [];

function makeFixture(options: { retryWindowMs?: number; tickMs?: number } = {}): Fixture {
  const key = `recovery-${Math.random().toString(36).slice(2)}`;
  InProcessTransport.resetRegistry(key);

  const sender = new InProcessTransport({ nodeId: 'node-a', registryKey: key });
  const receiver = new InProcessTransport({ nodeId: 'node-b', registryKey: key });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlr-recovery-'));
  const outbox = new OutboxStore({ dataDir: dir, mapSize: 8 * 1024 * 1024, ...options });
  const config: ReplicationConfig = {
    nodeId: 'node-a',
    dc: 'dc-east',
    curveDir: dir,
    tickMs: options.tickMs ?? 10,
    batchSize: 100,
    targets: [
      {
        nodeId: 'node-b',
        dc: 'dc-west',
        address: 'inproc://recovery/node-b',
        topology: 'cross-dc',
        maxBackoffSeconds: 1,
      },
    ],
  };

  const replication = new MultiLeaderReplication({
    transport: sender,
    outbox,
    config,
    hlc: new HLC('node-a'),
  });

  const cleanup = () => {
    replication.stop();
    outbox.close();
    sender.destroy();
    receiver.destroy();
    InProcessTransport.resetRegistry(key);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { replication, outbox, sender, receiver, cleanup };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* already torn down */
    }
  }
});

describe('MultiLeaderReplication — retryFailed revives the dead letter queue', () => {
  it('returns the number of entries it revived, not a hard zero', async () => {
    const fix = makeFixture({ retryWindowMs: 0 });
    fix.receiver.partition(); // the only target is unreachable
    await fix.replication.start();

    await fix.replication.replicate(0, 'a', 'replicate');
    await fix.replication.replicate(0, 'b', 'replicate');
    await waitFor(() => fix.outbox.getDeadLetterStats().count === 2);

    expect(await fix.replication.retryFailed('node-b')).toBe(2);
    expect(fix.outbox.getDeadLetterStats().count).toBe(0);
    expect(await fix.outbox.getPendingCount()).toBe(2);
  });

  it('a revived entry is actually delivered once the peer is back', async () => {
    const fix = makeFixture({ retryWindowMs: 0 });
    fix.receiver.partition();
    await fix.replication.start();

    await fix.replication.replicate(0, 'payload', 'replicate');
    await waitFor(() => fix.outbox.getDeadLetterStats().count === 1);

    fix.receiver.heal();
    await fix.replication.retryFailed('node-b');

    await waitFor(async () => (await fix.outbox.getPendingCount()) === 0);
    expect(fix.outbox.getDeadLetterStats().count).toBe(0);
  });

  it('returns 0 for a target it does not know', async () => {
    const fix = makeFixture();
    await fix.replication.start();
    expect(await fix.replication.retryFailed('node-z')).toBe(0);
  });
});

describe('MultiLeaderReplication — a target that comes back is announced', () => {
  it('emits target-recovered when delivery resumes after a failure', async () => {
    const fix = makeFixture();
    await fix.replication.start();
    const recovered: string[] = [];
    fix.replication.onTargetRecovered((nodeId) => recovered.push(nodeId));

    fix.receiver.partition();
    await fix.replication.replicate(0, 'first', 'replicate');
    // "Pending" is not evidence of a failure — an entry is pending the moment
    // it is written. The premise of this test is that a delivery was *tried and
    // failed*, so it waits for the record of that attempt.
    await waitFor(async () => (await fix.replication.getStatus()).targets[0]?.lastErrorAt !== null);

    fix.receiver.heal();
    // An operator's "try again now" is the deterministic way to reach the next
    // attempt; the worker's own backoff after repeated failures is measured in
    // seconds by design.
    await fix.replication.retryFailed('node-b');
    await waitFor(() => recovered.length > 0);
    expect(recovered).toEqual(['node-b']);
  });

  it('emits it even when every pending entry had already been dead-lettered', async () => {
    // This is the corner the old code could not reach: with nothing pending,
    // `doTick()` took its empty-branch early return and never looked at the
    // link, so the "all dead-lettered" state was indistinguishable from health.
    const fix = makeFixture({ retryWindowMs: 0 });
    fix.receiver.partition();
    await fix.replication.start();
    const recovered: string[] = [];
    fix.replication.onTargetRecovered((nodeId) => recovered.push(nodeId));

    await fix.replication.replicate(0, 'only', 'replicate');
    await waitFor(() => fix.outbox.getDeadLetterStats().count === 1);
    expect(await fix.replication.getPendingCounts()).toEqual({ 'node-b': 0 });

    fix.receiver.heal();
    await waitFor(() => recovered.length > 0);
    expect(recovered).toEqual(['node-b']);
  });

  it('does not announce recovery for a target that never failed', async () => {
    const fix = makeFixture();
    await fix.replication.start();
    const recovered: string[] = [];
    fix.replication.onTargetRecovered((nodeId) => recovered.push(nodeId));

    await fix.replication.replicate(0, 'healthy', 'replicate');
    await waitFor(async () => (await fix.outbox.getPendingCount()) === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recovered).toEqual([]);
  });
});

describe('MultiLeaderReplication — lag is what is owed, not how long ago', () => {
  it('an idle channel that delivered everything has zero lag', async () => {
    const fix = makeFixture();
    await fix.replication.start();
    await fix.replication.replicate(0, 'only', 'replicate');
    await waitFor(async () => (await fix.outbox.getPendingCount()) === 0);

    await new Promise((resolve) => setTimeout(resolve, 120)); // channel stays idle
    const status = await fix.replication.getStatus();
    const target = status.targets[0]!;

    expect(target.pendingCount).toBe(0);
    expect(target.lagMs).toBe(0);
  });

  it('lag is the age of the oldest entry the target still owes', async () => {
    const fix = makeFixture();
    await fix.replication.start();
    fix.receiver.partition();

    await fix.replication.replicate(0, 'stuck', 'replicate');
    await waitFor(async () => (await fix.replication.getPendingCounts())['node-b'] === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const status = await fix.replication.getStatus();
    expect(status.targets[0]!.pendingCount).toBe(1);
    expect(status.targets[0]!.lagMs).toBeGreaterThanOrEqual(50);
  });

  it('reports zero for a target with nothing owed', async () => {
    const fix = makeFixture();
    await fix.replication.start();

    expect(await fix.replication.getPendingCounts()).toEqual({ 'node-b': 0 });
    const status = await fix.replication.getStatus();
    expect(status.targets[0]).toMatchObject({ pendingCount: 0, lagMs: 0 });
  });

  it('a revive does not erase the evidence that the target had been failing', async () => {
    const fix = makeFixture({ retryWindowMs: 0 });
    fix.receiver.partition();
    await fix.replication.start();
    await fix.replication.replicate(0, 'only', 'replicate');
    await waitFor(() => fix.outbox.getDeadLetterStats().count === 1);

    await fix.replication.retryFailed('node-b');
    const status = await fix.replication.getStatus();
    // `lastErrorAt` survives: the operator can still see it had failed.
    expect(status.targets[0]!.lastErrorAt).not.toBeNull();
  });
});
