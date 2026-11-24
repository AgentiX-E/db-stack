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
 * The fixture duplicates `cross-cluster-sync.test.ts` deliberately: the two
 * suites drive different failure stories and a shared fixture would have to be
 * parameterised in both directions. Unifying them is tracked in the roadmap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  type ChildNode,
  type ClusterNodeSpec,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnGateway,
  spawnRaftNode,
  waitUntil,
} from '../harness/support';

const certs = makeCertificates(5);
const dirs: string[] = [];
const processes: ChildNode[] = [];

interface GatewayStatus {
  nodeId: string;
  dc: string;
  isLeader: boolean;
  term: number;
  commitIndex: number;
  stateSize: number;
  state: Record<string, string>;
  pending: Record<string, number>;
  connectedPeers: string[];
  cdc: {
    captured: number;
    delivered: number;
    requeued: number;
    deliveryFailures: number;
    handlers: number;
    keysDelivered: number;
  };
  deadLetters: number;
  recoveredTargets: string[];
  lastSendError: string | null;
  inboundFrames: number;
  retention: {
    retryWindowMs: number;
    retryBackoffMaxMs: number;
    dedupMs: number;
    deadLetterTtlMs: number;
    entryTtlMs: number;
  };
}

function buildCluster(prefix: string, baseDir: string, ports: number[]): ClusterNodeSpec[] {
  const specs: ClusterNodeSpec[] = [1, 2, 3].map((id, index) => ({
    id,
    host: '127.0.0.1',
    port: ports[index]!,
    dataDir: join(baseDir, `${prefix}-node-${id}`),
    cert: certs.nodes[index]!,
    peers: [],
    // The gateway (node 1) wins the election on every cold boot: it also owns
    // the federation stack, and the inbound apply path refuses to run on a
    // follower.
    electionTick: index === 0 ? 4 : 50,
    heartbeatTick: index === 0 ? 2 : 10,
  }));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }
  return specs;
}

interface GatewayOptions {
  nodeId: string;
  dc: string;
  transportNodeId: number;
  certIndex: number;
  peer: { nodeId: string; dc: string; host: string; port: number; transportNodeId: number };
  nodes: ClusterNodeSpec[];
  baseDir: string;
  /**
   * The outbox windows this scenario runs with.
   *
   * A window is not a single number: one backoff has to fit inside the retry
   * budget that schedules it, or the budget is spent sleeping past its own
   * deadline. The suite states both, and the store refuses the pair if a future
   * edit shortens the budget below the ceiling without moving the ceiling too.
   */
  outbox: { retryWindowMs: number; retryBackoffMaxMs: number };
}

function gatewayConfig(opts: GatewayOptions, listenPort: number): Record<string, unknown> {
  const self = opts.nodes.find((n) => n.id === 1)!;
  return {
    nodeId: opts.nodeId,
    dc: opts.dc,
    transportNodeId: opts.transportNodeId,
    listen: { host: '127.0.0.1', port: listenPort },
    peer: opts.peer,
    // The state machine is checkpointed per cluster and survives the restart
    // that AC-F7 performs; a fresh directory per run keeps runs independent.
    dataDir: join(opts.baseDir, `${opts.dc}-gateway`),
    outboxDir: join(opts.baseDir, `${opts.dc}-gateway`, 'outbox'),
    stateFile: join(opts.baseDir, `${opts.dc}-gateway`, 'gateway-state.json'),
    federationCert: certs.nodes[opts.certIndex]!,
    outbox: opts.outbox,
    dlqScanIntervalMs: 300,
    outboxHousekeepingIntervalMs: 0,
    raft: {
      id: 1,
      node: { id: 1, host: self.host, port: self.port },
      peers: self.peers,
      cert: self.cert,
      electionTick: 8,
      heartbeatTick: 2,
      tickIntervalMs: 50,
    },
  };
}

interface Cluster {
  label: string;
  specs: ClusterNodeSpec[];
  config: Record<string, unknown>;
  gateway: ChildNode;
  followers: ChildNode[];
}

async function bootCluster(cluster: Pick<Cluster, 'label' | 'specs' | 'config'>): Promise<Cluster> {
  const gateway = spawnGateway(cluster.config, `${cluster.label}-gateway`);
  const followers = cluster.specs.filter((s) => s.id !== 1).map((spec) => spawnRaftNode(spec));

  await Promise.all([gateway.waitForType('ready', 90_000), ...followers.map((f) => f.waitForType('ready', 60_000))]);

  await waitUntil(
    async () => (await gateway.status<GatewayStatus>()).isLeader,
    45_000,
    `${cluster.label} gateway to become cluster leader`,
    200,
  );

  return { ...cluster, gateway, followers } as Cluster;
}

/** Stop every process in a cluster and wait for the exits — a real outage. */
async function stopCluster(cluster: Cluster): Promise<void> {
  cluster.gateway.send({ cmd: 'stop' });
  await cluster.gateway.waitForType('stopped', 30_000);
  for (const follower of cluster.followers) follower.process.kill('SIGTERM');

  await waitUntil(
    async () => cluster.gateway.exited && cluster.followers.every((f) => f.exited),
    30_000,
    `${cluster.label} processes to exit`,
    100,
  );
}

let east: Cluster;
let west: Cluster;

/** Everything the gateway has committed, as key → value. */
async function committed(cluster: Cluster): Promise<Record<string, string>> {
  return (await cluster.gateway.status<GatewayStatus>()).state;
}

describe('Federation recovery (two real clusters, mTLS, cold restarts)', () => {
  beforeAll(async () => {
    const ports = await getFreePorts(6);
    const fedPorts = await getFreePorts(2);
    const baseDir = makeTempDir('federation-recovery');
    dirs.push(baseDir);

    const eastSpecs = buildCluster('east', baseDir, ports.slice(0, 3));
    const westSpecs = buildCluster('west', baseDir, ports.slice(3, 6));

    east = {
      label: 'east',
      specs: eastSpecs,
      config: gatewayConfig(
        {
          nodeId: 'dc-east-gw',
          dc: 'east',
          transportNodeId: 4,
          certIndex: 3,
          peer: {
            nodeId: 'dc-west-gw',
            dc: 'west',
            host: '127.0.0.1',
            port: fedPorts[1]!,
            transportNodeId: 5,
          },
          nodes: eastSpecs,
          baseDir,
          // Short enough that a test can outlast it. The production default is
          // chosen against the longest tolerable outage; a suite that waited
          // for that default would not be a suite anyone runs. The backoff
          // ceiling is sized to the budget so the last attempt is not scheduled
          // after the window has already closed.
          outbox: { retryWindowMs: 1_000, retryBackoffMaxMs: 200 },
        },
        fedPorts[0]!,
      ),
      gateway: undefined as unknown as ChildNode,
      followers: [],
    };

    west = {
      label: 'west',
      specs: westSpecs,
      config: gatewayConfig(
        {
          nodeId: 'dc-west-gw',
          dc: 'west',
          transportNodeId: 5,
          certIndex: 4,
          peer: {
            nodeId: 'dc-east-gw',
            dc: 'east',
            host: '127.0.0.1',
            port: fedPorts[0]!,
            transportNodeId: 4,
          },
          nodes: westSpecs,
          baseDir,
          outbox: { retryWindowMs: 1_000, retryBackoffMaxMs: 200 },
        },
        fedPorts[1]!,
      ),
      gateway: undefined as unknown as ChildNode,
      followers: [],
    };

    const bootedEast = await bootCluster(east);
    east = bootedEast;
    processes.push(east.gateway, ...east.followers);

    const bootedWest = await bootCluster(west);
    west = bootedWest;
    processes.push(west.gateway, ...west.followers);

    // Both links have to exist before anything is written: the assertions below
    // are about what happens to changes that were sent, not about a race
    // between the first write and the first handshake.
    await waitUntil(
      async () =>
        (await east.gateway.status<GatewayStatus>()).connectedPeers.includes('dc-west-gw') &&
        (await west.gateway.status<GatewayStatus>()).connectedPeers.includes('dc-east-gw'),
      45_000,
      'both gateways to hold a TLS link to each other',
      200,
    );
  }, 300_000);

  afterAll(() => {
    for (const child of processes) {
      if (!child.exited) child.process.kill('SIGKILL');
    }
    for (const dir of dirs.splice(0)) removeTempDir(dir);
  });

  it('AC-F5: each gateway runs with the outbox windows the suite set', async () => {
    // The scenario's timing depends on a one-second retry window, so the run has
    // to be able to prove it got one. The gateway used to copy four keys out of
    // the suite's `outbox` block and drop the rest, which is how the window below
    // arrived next to the untouchable two-second default backoff.
    for (const cluster of [east, west]) {
      const { retention } = await cluster.gateway.status<GatewayStatus>();
      expect(retention.retryWindowMs).toBe(1_000);
      expect(retention.retryBackoffMaxMs).toBe(200);
      expect(retention.dedupMs).toBeGreaterThanOrEqual(retention.retryWindowMs);
    }
  }, 60_000);

  it('AC-F6: a thirty-key burst is committed at the peer, and the change stream delivered thirty', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `burst-${i}`);

    for (const key of keys) {
      await east.gateway.request('replicate', { key, value: `v-${key}` }, 'replicated', 30_000);
    }

    const westState = await waitUntil(
      async () => {
        const state = await committed(west);
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
    const eastStatus = await waitUntil(
      async () => {
        const status = await east.gateway.status<GatewayStatus>();
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
    const before = (await east.gateway.status<GatewayStatus>()).cdc.captured;

    await stopCluster(west);
    expect(west.gateway.exited).toBe(true);

    for (const key of keys) {
      await east.gateway.request('replicate', { key, value: `v-${key}` }, 'replicated', 30_000);
    }

    // The retry window is one second; the worker backs off but keeps trying, so
    // within a few windows every unacknowledged entry is written off.
    const parked = await waitUntil(
      async () => {
        const status = await east.gateway.status<GatewayStatus>();
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
    const rebooted = await bootCluster(west);
    west = rebooted;
    processes.push(west.gateway, ...west.followers);

    const recovered = await waitUntil(
      async () => {
        const [eastStatus, westState] = await Promise.all([east.gateway.status<GatewayStatus>(), committed(west)]);
        const delivered = keys.every((k) => westState[k] === `v-${k}`);
        return delivered && eastStatus.deadLetters === 0 ? { eastStatus, westState } : undefined;
      },
      90_000,
      'the revived entries to reach the restarted datacenter',
      500,
    ).catch(async (err: unknown) => {
      const [eastStatus, westStatus] = await Promise.all([
        east.gateway.status<GatewayStatus>(),
        west.gateway.status<GatewayStatus>(),
      ]);
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
              lastInboundError: (westStatus as unknown as { lastInboundError?: string }).lastInboundError,
            },
            westStderr: west.gateway.stderrTail.slice(-8),
            eastStderr: east.gateway.stderrTail.slice(-8),
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
