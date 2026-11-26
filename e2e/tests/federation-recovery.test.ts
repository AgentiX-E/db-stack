/**
 * E2E — a dead letter is a queue entry, not a tombstone (real processes, mTLS).
 *
 * Two independent three-node Raft clusters, each with a federation gateway that
 * holds a real LMDB outbox and speaks TLS 1.3 with mutual certificate
 * verification to its peer. Nothing here is in-process: the outage is a set of
 * killed OS processes, the recovery is a cold restart from disk, and the link
 * that has to come back is a TCP socket.
 *
 * What is under test:
 *
 *   AC-F6  a thirty-key burst written at DC-East is committed by DC-West's Raft
 *          group, and DC-East's own change stream delivered all thirty to its
 *          consumer. The second half is the conservation property: `flushBuffer()`
 *          used to hand each handler `events[0]` and report `events.length`, so
 *          thirty changes were delivered as one and counted as thirty.
 *   AC-F7  a datacenter that is down for longer than the outbox retry window
 *          parks its entries in the dead letter queue; when the datacenter comes
 *          back the entries are revived and delivered, with zero loss. Before
 *          this, `retryFailed()` returned a hard `0`, reviving the queue had no
 *          production caller, and the only signal that recovery mattered — the
 *          first successful delivery — was unreachable once the queue emptied
 *          into the dead letter queue.
 *
 * Both federation suites boot through `TwoDatacenters`. This file used to carry
 * its own copy of the boot sequence — a third cluster builder, a third gateway
 * configuration — on the argument that the two suites drove different failure
 * stories. The argument was wrong about what was duplicated: the part that must
 * not drift is the election asymmetry (the gateway is given a 400 ms election
 * timeout against its followers' 2.5 s so it wins the first election
 * deterministically), and two copies of that are two chances to lose it and
 * report the resulting timeout as a replication defect. What this suite actually
 * needs from the fixture is two numbers, and they are options now.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GatewayStatus, TwoDatacenters } from '../harness/federation-dcs';
import { waitUntil } from '../harness/support';

let tx: TwoDatacenters;

beforeAll(async () => {
  tx = await TwoDatacenters.boot({
    label: 'federation-recovery',
    controlPlane: {
      // The recovery story is replication's. A 60 s sweep cannot be the thing that
      // repairs this outage — which is what makes AC-F7 a claim about the dead
      // letter queue rather than about anti-entropy arriving first.
      antiEntropyIntervalMs: 60_000,
    },
    // Short enough that a test can outlast it. The production default is chosen
    // against the longest tolerable outage; a suite that waited for that default
    // would not be a suite anyone runs. The backoff ceiling is sized to the budget
    // so the last attempt is not scheduled after the window has already closed.
    outbox: { retryWindowMs: 1_000, retryBackoffMaxMs: 200 },
    // How often the outbox looks for entries it can revive. The default is 500 ms
    // and this scenario's assertions are about the revival, not about the wait.
    dlqScanIntervalMs: 300,
  });

  // Both links have to exist before anything is written: the assertions below are
  // about what happens to changes that were sent, not about a race between the
  // first write and the first handshake.
  await waitUntil(
    async () => {
      const [east, west] = await Promise.all([tx.status('east'), tx.status('west')]);
      return east.connectedPeers.includes('dc-west-gw') && west.connectedPeers.includes('dc-east-gw');
    },
    45_000,
    'both gateways to hold a TLS link to each other',
    200,
  );
}, 300_000);

afterAll(async () => {
  await tx?.shutdown();
}, 120_000);

describe('Federation recovery (two real clusters, mTLS, cold restarts)', () => {
  it('AC-F5: each gateway runs with the outbox windows the suite set', async () => {
    // The scenario's timing depends on a one-second retry window, so the run has
    // to be able to prove it got one. The gateway used to copy four keys out of
    // the suite's `outbox` block and drop the rest, which is how the window below
    // arrived next to the untouchable two-second default backoff.
    for (const side of ['east', 'west'] as const) {
      const { retention } = await tx.status(side);
      expect(retention.retryWindowMs).toBe(1_000);
      expect(retention.retryBackoffMaxMs).toBe(200);
      expect(retention.dedupMs).toBeGreaterThanOrEqual(retention.retryWindowMs);
    }
  }, 60_000);

  it('AC-F6: a thirty-key burst is committed at the peer, and the change stream delivered thirty', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `burst-${i}`);

    for (const key of keys) {
      await tx.east.gateway.request('replicate', { key, value: `v-${key}` }, 'replicated', 30_000);
    }

    const westState = await waitUntil(
      async () => {
        const { state } = await tx.status('west');
        return keys.every((k) => state[k] === `v-${k}`) ? state : undefined;
      },
      90_000,
      'DC-West to commit all thirty keys',
      250,
    );
    expect(Object.keys(westState)).toEqual(expect.arrayContaining(keys));

    // The change stream is a separate path from the outbox. Both must account
    // for every write: the counters come from the manager, the key list from
    // the consumer that actually received them.
    const eastStatus: GatewayStatus = await waitUntil(
      async () => {
        const status = await tx.status('east');
        return status.cdc.keysDelivered === keys.length ? status : undefined;
      },
      30_000,
      'the DC-East change stream to deliver every captured change',
      100,
    );

    expect(eastStatus.cdc.captured).toBe(keys.length);
    expect(eastStatus.cdc.delivered).toBe(keys.length);
    expect(eastStatus.cdc.handlers).toBe(1);
    expect(eastStatus.cdc.deliveryFailures).toBe(0);
  }, 180_000);

  it('AC-F7: entries written while a datacenter was down are recovered from the dead letter queue', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `outage-${i}`);
    const before = (await tx.status('east')).cdc.captured;

    await tx.stop('west');
    expect(tx.west.gateway.exited).toBe(true);

    for (const key of keys) {
      await tx.east.gateway.request('replicate', { key, value: `v-${key}` }, 'replicated', 30_000);
    }

    // The retry window is one second; the worker backs off but keeps trying, so
    // within a few windows every unacknowledged entry is written off.
    const parked = await waitUntil(
      async () => {
        const status = await tx.status('east');
        return status.deadLetters >= keys.length ? status : undefined;
      },
      60_000,
      'the outbox to write off the entries it cannot deliver',
      200,
    );
    expect(parked.connectedPeers).not.toContain('dc-west-gw');
    // Nothing was deleted: every change is still counted as captured, and the
    // queue is what now holds them.
    expect(parked.cdc.captured).toBe(before + keys.length);

    // Cold restart from disk — new processes, same data directories, same
    // ports, and a fresh TLS handshake.
    await tx.start('west');

    const recovered = await waitUntil(
      async () => {
        const [eastStatus, westStatus] = await Promise.all([tx.status('east'), tx.status('west')]);
        const delivered = keys.every((k) => westStatus.state[k] === `v-${k}`);
        return delivered && eastStatus.deadLetters === 0 ? { eastStatus, westState: westStatus.state } : undefined;
      },
      90_000,
      'the revived entries to reach the restarted datacenter',
      500,
    ).catch(async (err: unknown) => {
      const [eastStatus, westStatus] = await Promise.all([tx.status('east'), tx.status('west')]);
      console.error(
        `[AC-F7] timeout dump: ${JSON.stringify(
          {
            east: {
              pending: eastStatus.pending,
              deadLetters: eastStatus.deadLetters,
              connectedPeers: eastStatus.connectedPeers,
              recoveredTargets: eastStatus.recoveredTargets,
              lastSendError: eastStatus.lastSendError,
            },
            west: {
              isLeader: westStatus.isLeader,
              commitIndex: westStatus.commitIndex,
              stateSize: westStatus.stateSize,
              connectedPeers: westStatus.connectedPeers,
              inboundFrames: westStatus.inboundFrames,
              lastInboundError: westStatus.lastInboundError,
            },
            westStderr: tx.west.gateway.stderrTail.slice(-8),
            eastStderr: tx.east.gateway.stderrTail.slice(-8),
          },
          null,
          2,
        )}`,
      );
      throw err;
    });

    expect(Object.keys(recovered.westState)).toEqual(expect.arrayContaining(keys));
    // The queue is empty in both senses: no dead letters, and nothing pending.
    expect(recovered.eastStatus.pending['dc-west-gw'] ?? 0).toBe(0);
    // And the recovery was announced, which is the signal the old code could not
    // produce once the queue had been written off.
    expect(recovered.eastStatus.recoveredTargets).toContain('dc-west-gw');
  }, 300_000);
});
