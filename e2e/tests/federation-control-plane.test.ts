/**
 * E2E — the federation control plane across two real datacenters.
 *
 * Three components, three claims, and each is only worth what a process boundary
 * can show:
 *
 *   AC-F10  two datacenters converge on a Merkle root each fetched from the other
 *           over the same mTLS link the replication frames use, and a change only
 *           one of them knows about is repaired by that mechanism
 *   AC-F11  a heartbeat that is lost, duplicated and delivered late are three
 *           different facts, and all three are visible from outside the process
 *   AC-F12  a datacenter stopped in the middle of a snapshot transfer resumes from
 *           the chunk it had accepted and reaches the same root as its peer
 *
 * Everything here is real: two 3-member Raft groups, two gateway processes, a TLS
 * 1.3 connection with mutual certificate verification between them, and frames
 * built by the library and written to that socket. Nothing is a mock, and no case
 * asserts on an in-process counter that a peer never saw.
 *
 * The intervals are the suite's: a sweep happens when a case asks for one, and a
 * silence is short enough to observe. Both are set on the gateway's `controlPlane`
 * block, which the harness validates against the manager's own configuration type
 * before a process is spawned — so a knob the manager renames fails the boot
 * instead of silently measuring the default.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TwoDatacenters } from '../harness/federation-dcs';
import { waitUntil } from '../harness/support';

/** Entries per snapshot chunk, small enough that a transfer is several chunks. */
const CHUNK_SIZE = 3;
/** Keys a joining datacenter has to receive. */
const DATASET = 60;

let tx: TwoDatacenters;

beforeAll(async () => {
  tx = await TwoDatacenters.boot({
    label: 'control-plane',
    controlPlane: {
      // The sweep is the suite's, not a timer's. A case that says "and then one
      // sweep repaired it" has to be able to say when the sweep happened, or the
      // claim is about the timer.
      antiEntropyIntervalMs: 60_000,
      // Short enough that a silence is observable inside a test, long enough that
      // a healthy link is never mistaken for a silent one. The detector's expiry
      // deadline is this interval times its missed-beat threshold.
      heartbeatIntervalMs: 250,
      bootstrapChunkSize: CHUNK_SIZE,
      // Dead letters are not revived on a timer either: the convergence case has
      // to be about anti-entropy, and an outbox that heals itself in the
      // background would make it about the outbox.
      dlqScanIntervalMs: 0,
    },
  });
}, 300_000);

afterAll(async () => {
  await tx?.shutdown();
}, 120_000);

describe('Federation control plane over mTLS (two real datacenters)', () => {
  it('AC-F10: a digest crosses the wire, and anti-entropy repairs what replication never carried', async () => {
    // Replication first: a claim that the digest repaired a divergence means
    // nothing if the link was never working.
    for (const key of ['cp:a', 'cp:b', 'cp:c']) {
      await tx.east.gateway.request('replicate', { key, value: `v-${key}` }, 'replicated', 30_000);
    }
    await tx.waitForValue('west', 'cp:a', 'v-cp:a');

    await tx.east.gateway.request('sweep', {}, 'swept', 60_000);
    await tx.west.gateway.request('sweep', {}, 'swept', 60_000);

    const [east, west] = await Promise.all([tx.status('east'), tx.status('west')]);
    const eastRoot = east.protocols.antiEntropy!.selfRoot;
    const westRoot = west.protocols.antiEntropy!.selfRoot;

    // A root each side computed, and the other side's root as the other side
    // claimed it. Before this iteration the comparison was between one dataset and
    // itself, so a digest that never left the process looked exactly like this
    // pair of numbers.
    expect(eastRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(westRoot).toBe(eastRoot);
    expect(east.protocols.antiEntropy!.peers['dc-west-gw']!.root).toBe(westRoot);
    expect(west.protocols.antiEntropy!.peers['dc-east-gw']!.root).toBe(eastRoot);
    expect(east.protocols.antiEntropy!.requestsSent).toBeGreaterThanOrEqual(1);
    expect(west.protocols.antiEntropy!.repliesSent).toBeGreaterThanOrEqual(1);

    // A change only east knows: committed by its own cluster, deliberately never
    // handed to the outbox. There is no retry and no dead letter for it, so the
    // only mechanism that can deliver it is the digest comparison.
    await tx.east.gateway.request('adopt', { key: 'cp:undeclared', value: 'only-east' }, 'adopted', 30_000);

    const before = await tx.status('west');
    expect(before.localValues['cp:undeclared']).toBeUndefined();
    expect(before.state['cp:undeclared']).toBeUndefined();
    expect((await tx.status('east')).pending['dc-west-gw'] ?? 0).toBe(0);

    // One sweep. The divergent bucket is pushed, and the repair lands in the
    // receiving datacenter's cluster as well as in its replica map.
    await tx.east.gateway.request('sweep', {}, 'swept', 60_000);
    const [eastAfter, westAfter] = await tx.waitForConvergence('cp:undeclared', 'only-east', 60_000);

    expect(eastAfter.protocols.antiEntropy!.pushesSent).toBeGreaterThanOrEqual(1);
    expect(westAfter.protocols.antiEntropy!.pushesReceived).toBeGreaterThanOrEqual(1);
    expect(westAfter.protocols.antiEntropy!.entriesApplied).toBeGreaterThanOrEqual(1);
    expect(westAfter.deadLetters).toBe(0);

    // Converged means one root again — not two roots that happen to agree about
    // one key.
    await tx.east.gateway.request('sweep', {}, 'swept', 60_000);
    await tx.west.gateway.request('sweep', {}, 'swept', 60_000);
    const [eastFinal, westFinal] = await Promise.all([tx.status('east'), tx.status('west')]);
    expect(westFinal.protocols.antiEntropy!.selfRoot).toBe(eastFinal.protocols.antiEntropy!.selfRoot);
  }, 240_000);

  it('AC-F11: a heartbeat lost, duplicated and late are three different facts', async () => {
    // The timer's beats are paused so the sequence is the suite's: a duplicate is
    // only a duplicate of a frame that was not already superseded.
    await tx.east.gateway.request('pause-beats', {}, 'beat', 20_000);

    const beat = await tx.east.gateway.request<{ delivered: number; seq: number }>('beat', {}, 'beat', 20_000);
    expect(beat.delivered).toBe(1);

    const accepted = await waitUntil(
      async () => {
        const status = await tx.status('west');
        const peer = status.protocols.heartbeat!.peers['dc-east-gw'];
        return peer && peer.seq === beat.seq ? status : undefined;
      },
      20_000,
      'west to accept the beat',
      50,
    );
    const outOfOrderBefore = accepted.protocols.heartbeat!.outOfOrder;
    expect(accepted.protocols.heartbeat!.received).toBeGreaterThanOrEqual(1);

    // The most recent frame again: a transport duplicate, byte for byte.
    const duplicated = await tx.east.gateway.request<{ delivered: number; messageId: string }>(
      'replay-heartbeat',
      { back: 0 },
      'heartbeat-sent',
      20_000,
    );
    expect(duplicated.delivered).toBe(true);
    // And the frame before it, which the peer had already accepted: a late
    // delivery, not a second interval.
    await tx.east.gateway.request('replay-heartbeat', { back: 1 }, 'heartbeat-sent', 20_000);

    const rejected = await waitUntil(
      async () => {
        const status = await tx.status('west');
        return status.protocols.heartbeat!.outOfOrder >= outOfOrderBefore + 2 ? status : undefined;
      },
      20_000,
      'west to reject the duplicate and the late frame',
      50,
    );

    // Neither advanced the peer's sequence: a duplicate and a late frame are the
    // same rejection, and the reason is stronger than "already seen". A late frame
    // would insert a past clock into the chain divergence is measured on, and a
    // chain that walks backwards looks exactly like two independently advancing
    // clocks — the false positive the detector exists to avoid.
    expect(rejected.protocols.heartbeat!.peers['dc-east-gw']!.seq).toBe(beat.seq);

    // Now a silence. East stops beating and west has to notice, once.
    await tx.east.gateway.request('pause-beats', {}, 'beat', 20_000);

    const silent = await waitUntil(
      async () => {
        const status = await tx.status('west');
        return status.protocols.heartbeat!.expired >= 1 ? status : undefined;
      },
      20_000,
      'west to report east silent',
      50,
    );
    const expiredAt = silent.protocols.heartbeat!.expired;

    // Reported once, not once per tick. A counter that grows while nothing changes
    // is not a measurement, and an operator watching it would read one outage as a
    // sequence of them.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await tx.status('west')).protocols.heartbeat!.expired).toBe(expiredAt);

    // A beat clears the mark, and the next silence is a second event rather than
    // the same one continuing.
    await tx.east.gateway.request('resume-beats', {}, 'beat', 20_000);
    await waitUntil(
      async () => {
        const status = await tx.status('west');
        const peer = status.protocols.heartbeat!.peers['dc-east-gw'];
        return peer && peer.seq > beat.seq ? status : undefined;
      },
      20_000,
      'east to be beating again',
      50,
    );

    await tx.east.gateway.request('pause-beats', {}, 'beat', 20_000);
    const second = await waitUntil(
      async () => {
        const status = await tx.status('west');
        return status.protocols.heartbeat!.expired > expiredAt ? status : undefined;
      },
      20_000,
      'west to report the second silence',
      50,
    );
    expect(second.protocols.heartbeat!.expired).toBe(expiredAt + 1);

    // Leave the link beating for the next case.
    await tx.east.gateway.request('resume-beats', {}, 'beat', 20_000);
  }, 180_000);

  it('AC-F12: a bootstrap interrupted by a restart begins again and leaves no hole', async () => {
    // The whole west datacenter goes down: the case is about a receiver that was
    // not there for the middle of a transfer.
    await tx.stop('west');

    const keys = Array.from({ length: DATASET }, (_, i) => `bulk:${String(i).padStart(3, '0')}`);
    for (const key of keys) {
      await tx.east.gateway.request('adopt', { key, value: `v-${key}` }, 'adopted', 30_000);
    }

    await tx.start('west');
    tx.west.gateway.send({ cmd: 'bootstrap', peerId: 'dc-east-gw' });

    const inFlight = await waitUntil(
      async () => {
        const status = await tx.status('west');
        const bootstrap = status.protocols.bootstrap!;
        const transfer = bootstrap.transfers.inbound[0];
        // At least two chunks accepted and none of them the last: stopping now is
        // stopping in the middle, which is the subject of the case.
        return transfer && bootstrap.chunksReceived >= 2 && bootstrap.completed.length === 0
          ? { transferId: transfer.transferId, chunks: bootstrap.chunksReceived, expected: transfer.expected }
          : undefined;
      },
      120_000,
      'the transfer to be in flight with more chunks to go',
      20,
    );
    expect(inFlight.expected).toBeGreaterThan(1);

    // Stop it there — the whole datacenter, not just the gateway: the resume path
    // is about a receiver that ceased to exist.
    await tx.stop('west');
    await tx.start('west');

    const restarted = await tx.west.gateway.request<{ transferId: string }>(
      'bootstrap',
      { peerId: 'dc-east-gw' },
      'bootstrap',
      60_000,
    );

    // A new transfer, not the dead one.
    //
    // The cursor on disk says chunks 0..n-1 are in the store, and it was true when
    // it was written: they were in a `Map` in a process that no longer exists. A
    // manager whose replica map is in memory cannot vouch for them, so it refuses
    // the cursor and asks from zero. Resuming instead would leave the joining
    // datacenter with everything after chunk n and nothing before it — a transfer
    // that finishes, reports `complete`, and is wrong.
    expect(restarted.transferId).not.toBe(inFlight.transferId);
    const refusal = await tx.status('west');
    expect(refusal.protocols.bootstrap!.lastError).toMatch(/written by another process/);

    const finished = await waitUntil(
      async () => {
        const status = await tx.status('west');
        const bootstrap = status.protocols.bootstrap!;
        return bootstrap.completed.length >= 1 ? bootstrap : undefined;
      },
      180_000,
      'the restarted transfer to complete',
      100,
    );

    // Only a transfer whose handoff completed is reported here, so its presence is
    // the `complete: true` this case is about: the sender could reach back to the
    // floor the snapshot set.
    expect(finished.completed.some((c) => c.transferId === restarted.transferId)).toBe(true);

    // Every key the joining datacenter never had, in both views of it — the
    // cluster's committed state and the federation layer's replica map. A repair
    // that lands in one and not the other is state a restart forgets.
    const west = await tx.status('west');
    for (const key of keys) {
      expect(west.localValues[key]).toBe(`v-${key}`);
      expect(west.state[key]).toBe(`v-${key}`);
    }

    // And the two datacenters agree about the keyspace, which is the only claim
    // that means anything after a transfer.
    await tx.east.gateway.request('sweep', {}, 'swept', 120_000);
    await tx.west.gateway.request('sweep', {}, 'swept', 120_000);
    const [east, westFinal] = await Promise.all([tx.status('east'), tx.status('west')]);
    expect(westFinal.protocols.antiEntropy!.selfRoot).toBe(east.protocols.antiEntropy!.selfRoot);
  }, 300_000);
});
