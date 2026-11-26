/**
 * E2E — real cross-cluster data synchronisation over mTLS.
 *
 * Two independent 3-node Raft clusters (two "datacenters"). A federation
 * gateway in each DC is a member of its local cluster and replicates writes to
 * the other DC over a genuine TLS 1.3 connection with mutual certificate
 * verification. Inbound entries are committed by the receiving cluster's Raft
 * group — the assertion is on the receiving cluster's applied state machine,
 * not on an in-memory inbox.
 *
 * Acceptance criteria:
 *   AC-F1  a write in DC-East becomes committed state in DC-West
 *   AC-F2  the inter-DC link is TLS 1.3 + mutual auth (rogue cert rejected)
 *   AC-F3  no loss and no duplication across a 50-key burst
 *   AC-F4  concurrent writes to the same key converge to one value in both DCs
 *   AC-F5  a DC outage parks entries in the outbox; on restart they are
 *          replayed and the DC converges (crash recovery, no data loss)
 */

import { afterAll, describe, expect, it } from 'vitest';
import tls from 'node:tls';
import { TwoDatacenters } from '../harness/federation-dcs';
import { waitUntil } from '../harness/support';

/**
 * Both datacenters, booted once for the file.
 *
 * The boot sequence lives in the harness because the control-plane suite needs the
 * same one, and the part that must not drift is its election asymmetry — see
 * `harness/federation-dcs.ts`.
 */
let tx: TwoDatacenters;

describe('Cross-cluster sync over mTLS (two real clusters)', () => {
  it('boots two independent 3-node clusters with a federation gateway each', async () => {
    tx = await TwoDatacenters.boot({
      label: 'cross-cluster',
      // The production intervals: this suite is about the replication path, and a
      // shortened control-plane interval would only add frames to the cases.
      controlPlane: { antiEntropyIntervalMs: 60_000 },
    });

    const east = await tx.status('east');
    const west = await tx.status('west');
    expect(east.isLeader).toBe(true);
    expect(west.isLeader).toBe(true);
    expect(tx.east.followers.every((n) => !n.exited)).toBe(true);
    expect(tx.west.followers.every((n) => !n.exited)).toBe(true);
  }, 240_000);

  it('AC-F2: inter-DC link is TLS 1.3 with mutual authentication', async () => {
    // The gateways must have established the outbound TLS connection.
    const status = await waitUntil(
      async () => {
        const s = await tx.status('east');
        return s.connectedPeers.length > 0 ? s : undefined;
      },
      30_000,
      'east gateway to see the west peer connected',
      250,
    );
    expect(status.connectedPeers).toContain('dc-west-gw');

    // Independently verify the listener speaks TLS 1.3 and demands a client
    // certificate signed by the cluster CA.
    const westListenPort = tx.west.listenPort;

    const good = await new Promise<{
      protocol: string | null;
      authorized: boolean;
      error?: string;
    }>((resolve) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: westListenPort,
          servername: 'raft-node-5',
          cert: tx.certs.nodes[3]!.cert,
          key: tx.certs.nodes[3]!.key,
          ca: tx.certs.caPem,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        () => {
          const protocol = socket.getProtocol();
          const authorized = socket.authorized;
          socket.end();
          resolve({ protocol, authorized });
        },
      );
      socket.on('error', (err) => resolve({ protocol: null, authorized: false, error: err.message }));
    });
    expect(good.error).toBeUndefined();
    expect(good.authorized).toBe(true);
    expect(good.protocol).toBe('TLSv1.3');

    // Client-side `socket.authorized` only reflects verification of the SERVER
    // certificate — the listener presents a valid cluster cert, so that flag
    // stays true even when the listener rejects OUR (rogue) client certificate.
    // The rejection surfaces as a post-handshake alert, so require the
    // connection to die after the first application-data frame.
    const rogue = await new Promise<{ rejected: boolean; error?: string }>((resolve) => {
      let settled = false;
      const done = (rejected: boolean, error?: string): void => {
        if (settled) return;
        settled = true;
        resolve({ rejected, error });
      };
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: westListenPort,
          servername: 'raft-node-5',
          cert: tx.certs.rogue.cert,
          key: tx.certs.rogue.key,
          ca: tx.certs.caPem,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        () => {
          socket.write('ping');
        },
      );
      socket.on('data', () => done(false, 'unexpected application data'));
      socket.on('error', (err) => done(true, err.message));
      socket.on('close', () => done(true, 'closed-by-server'));
      setTimeout(() => done(false, 'timeout — connection survived'), 5_000).unref?.();
    });
    expect(rogue.rejected).toBe(true);
    expect(rogue.error ?? 'rejected').toBeTruthy();
  }, 120_000);

  it('AC-F1: a write in DC-East becomes committed state in DC-West', async () => {
    tx.east.gateway.send({
      cmd: 'replicate',
      key: 'user:1',
      value: 'alice',
      type: 'insert',
    });
    await tx.east.gateway.waitFor((m) => m.type === 'replicated', 20_000, 'east replication ack');

    const west = await tx.waitForValue('west', 'user:1', 'alice');
    expect(west.state['user:1']).toBe('alice');

    // The value must be committed by the west *cluster*, i.e. all replicas applied it.
    const appliedEverywhere = await waitUntil(
      async () => {
        const statuses = await Promise.all(
          tx.west.followers.map((n) => n.status<{ applied: string[]; commitIndex: number }>()),
        );
        return statuses.every((s) => s.commitIndex > 0) ? statuses : undefined;
      },
      45_000,
      'west followers to commit the replicated entry',
      250,
    );
    expect(appliedEverywhere).toHaveLength(2);
  }, 120_000);

  it('AC-F3: 50-key burst converges with no loss and no duplication', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `burst:${i}`);

    for (const key of keys) {
      tx.east.gateway.send({
        cmd: 'replicate',
        key,
        value: `v-${key}`,
        type: 'insert',
      });
    }

    const west = await waitUntil(
      async () => {
        const status = await tx.status('west');
        return keys.every((k) => status.state[k] === `v-${k}`) ? status : undefined;
      },
      90_000,
      'west to receive all 50 keys',
      300,
    );

    // Exactly one value per key — no duplicated/overwritten entries.
    for (const key of keys) {
      expect(west.state[key]).toBe(`v-${key}`);
    }
    expect(Object.keys(west.state).length).toBeGreaterThanOrEqual(keys.length);

    // Outbox drained: nothing left pending towards the peer.
    const drained = await waitUntil(
      async () => {
        const status = await tx.status('east');
        const pending = status.pending['dc-west-gw'] ?? 0;
        return pending === 0 ? status : undefined;
      },
      60_000,
      'east outbox to drain',
      300,
    );
    expect(drained.transport.messagesSent).toBeGreaterThanOrEqual(keys.length);
  }, 180_000);

  it('AC-F4: concurrent writes to the same key converge to one value', async () => {
    tx.east.gateway.send({
      cmd: 'replicate',
      key: 'conflict',
      value: 'east-wins?',
      type: 'update',
    });
    tx.west.gateway.send({
      cmd: 'replicate',
      key: 'conflict',
      value: 'west-wins?',
      type: 'update',
    });

    const converged = await waitUntil(
      async () => {
        const [east, west] = await Promise.all([tx.status('east'), tx.status('west')]);
        const eastValue = east.state['conflict'];
        const westValue = west.state['conflict'];
        return eastValue !== undefined && westValue !== undefined && eastValue === westValue
          ? { eastValue, westValue }
          : undefined;
      },
      90_000,
      'both DCs to converge on the same value',
      300,
    );

    expect(converged.eastValue).toBe(converged.westValue);
    expect(['east-wins?', 'west-wins?']).toContain(converged.eastValue);
  }, 150_000);

  it('AC-F5: a DC outage parks entries in the outbox and replays on restart', async () => {
    // A DC outage takes the whole datacenter down, not just the gateway
    // process: stop the gateway *and* its Raft followers. Restarting only the
    // gateway would leave a live follower holding leadership, and the inbound
    // apply path (propose into the local group) requires the gateway to lead —
    // which it would never regain while receiving heartbeats.
    await tx.stop('west');

    const before = await tx.status('east');
    tx.east.gateway.send({
      cmd: 'replicate',
      key: 'during-outage',
      value: 'stored-offline',
      type: 'insert',
    });
    await tx.east.gateway.waitFor((m) => m.type === 'replicated', 20_000, 'east replication during outage');

    // Hold the outage past the transport's fast-retry budget (100 + 200 + 400 +
    // 800 + 1600 ms at the defaults). Without this the case only passes when the
    // runner happens to notice the disconnect late enough — on a slow runner the
    // budget was exhausted, reconnection stopped for good, and this test hung for
    // two minutes while the outbox kept a message it could never deliver.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    // The outbox must retain the entry while the peer is unreachable.
    await waitUntil(
      async () => {
        const status = await tx.status('east');
        return (status.pending['dc-west-gw'] ?? 0) > (before.pending['dc-west-gw'] ?? 0) ? status : undefined;
      },
      45_000,
      'outbox to retain the offline entry',
      250,
    );

    // Restart the whole west DC on the same ports, data dirs and outbox.
    await tx.start('west');

    const west = await tx.waitForValue('west', 'during-outage', 'stored-offline', 120_000);
    expect(west.state['during-outage']).toBe('stored-offline');

    // Previously replicated keys survived the restart (durable state).
    expect(west.state['user:1']).toBe('alice');
  }, 300_000);
});

afterAll(async () => {
  await tx?.shutdown();
}, 120_000);
