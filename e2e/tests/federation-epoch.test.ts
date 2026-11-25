/**
 * E2E — a datacenter restored from an older backup cannot write its past back
 * into its peer (real processes, mTLS).
 *
 * Two independent three-node Raft clusters, each with a federation gateway over
 * a real LMDB outbox and a TLS 1.3 link with mutual certificate verification.
 * The rollback is real: the west gateway is stopped, and started again as an
 * *older incarnation* of itself — the same node id, the same data directory, a
 * lower epoch — which is exactly what restoring a datacenter from a backup or
 * redeploying it on a rolled-back image produces.
 *
 * What is under test:
 *
 *   AC-F8  a change from a rolled-back incarnation is refused by name, reaches
 *          no key at the peer, and is still on the sender's queue afterwards —
 *          the refusal is an answer, not a dropped frame.
 *   AC-F9  the same datacenter restarted at its current incarnation delivers the
 *          change it was refused, without an operator re-enqueuing anything.
 *
 * The fixture duplicates `federation-recovery.test.ts` deliberately: the two
 * suites drive different failure stories and a shared fixture would have to be
 * parameterised in both directions.
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
  state: Record<string, string>;
  pending: Record<string, number>;
  connectedPeers: string[];
  deadLetters: number;
  lastInboundError: string | null;
  epochStatus: {
    self: number | null;
    peers: Record<string, number>;
    refused: number;
    advanced: number;
    epochless: number;
  };
}

/** The west gateway's incarnations. The second is the one from before the restore. */
const WEST_CURRENT_EPOCH = 9_000;
const WEST_RESTORED_EPOCH = 5_000;

function buildCluster(prefix: string, baseDir: string, ports: number[]): ClusterNodeSpec[] {
  const specs: ClusterNodeSpec[] = [1, 2, 3].map((id, index) => ({
    id,
    host: '127.0.0.1',
    port: ports[index]!,
    dataDir: join(baseDir, `${prefix}-node-${id}`),
    cert: certs.nodes[index]!,
    peers: [],
    // The gateway (node 1) wins the election on every cold boot: it also owns the
    // federation stack, and the inbound apply path refuses to run on a follower.
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
  /** The incarnation this gateway stamps on every frame it sends. */
  epoch: number;
}

function gatewayConfig(opts: GatewayOptions, listenPort: number): Record<string, unknown> {
  const self = opts.nodes.find((n) => n.id === 1)!;
  return {
    nodeId: opts.nodeId,
    dc: opts.dc,
    transportNodeId: opts.transportNodeId,
    epoch: opts.epoch,
    listen: { host: '127.0.0.1', port: listenPort },
    peer: opts.peer,
    dataDir: join(opts.baseDir, `${opts.dc}-gateway`),
    outboxDir: join(opts.baseDir, `${opts.dc}-gateway`, 'outbox'),
    stateFile: join(opts.baseDir, `${opts.dc}-gateway`, 'gateway-state.json'),
    federationCert: certs.nodes[opts.certIndex]!,
    // Long enough that a refused entry is still on the queue when the case
    // asserts it, which is the whole point of AC-F8's second half: a refusal
    // that emptied the queue would be a delivery nobody made.
    outbox: { retryWindowMs: 60_000, retryBackoffMaxMs: 200 },
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
let westBase: { label: string; specs: ClusterNodeSpec[]; config: Record<string, unknown> };
let westListenPort: number;

describe('Federation epoch (two real clusters, mTLS, a datacenter rolled back)', () => {
  beforeAll(async () => {
    const ports = await getFreePorts(6);
    const fedPorts = await getFreePorts(2);
    const baseDir = makeTempDir('federation-epoch');
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
          epoch: 7_000,
        },
        fedPorts[0]!,
      ),
      gateway: undefined as unknown as ChildNode,
      followers: [],
    };

    westListenPort = fedPorts[1]!;
    westBase = {
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
          epoch: WEST_CURRENT_EPOCH,
        },
        westListenPort,
      ),
    };

    east = await bootCluster(east);
    west = await bootCluster(westBase);
    processes.push(east.gateway, ...east.followers, west.gateway, ...west.followers);

    // Both links have to exist before anything is written: the cases below are
    // about what happens to changes that were sent, not about a race between the
    // first write and the first handshake.
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

  it('AC-F8: a rolled-back datacenter is refused by name, and its change reaches no key', async () => {
    // The current incarnation speaks first, so the peer has a watermark to
    // compare against. Without this the rollback would be the first frame the
    // east coast ever saw from the west, and "older than what" would have no
    // answer — which is the honest limit of the mechanism, stated in the case.
    await west.gateway.request('replicate', { key: 'before-restore', value: 'v1' }, 'replicated', 30_000);
    await waitUntil(
      async () => (await east.gateway.status<GatewayStatus>()).state['before-restore'] === 'v1',
      60_000,
      'the current incarnation’s change to land at DC-East',
      100,
    );

    const heard = await east.gateway.status<GatewayStatus>();
    expect(heard.epochStatus.peers['dc-west-gw']).toBe(WEST_CURRENT_EPOCH);

    // The datacenter is restored from an older backup: same node id, same data
    // directory, an incarnation the east coast has already moved past.
    await stopCluster(west);
    west = await bootCluster({
      ...westBase,
      config: { ...westBase.config, epoch: WEST_RESTORED_EPOCH },
    });
    processes.push(west.gateway, ...west.followers);

    await west.gateway.request('replicate', { key: 'resurrected', value: 'from-the-past' }, 'replicated', 30_000);

    const refused = await waitUntil(
      async () => {
        const status = await east.gateway.status<GatewayStatus>();
        return status.epochStatus.refused >= 1 ? status : undefined;
      },
      60_000,
      'DC-East to refuse a frame from the restored incarnation',
      100,
    );

    // Not applied: the key the rebuild had undone stays undone.
    expect(refused.state['resurrected']).toBeUndefined();
    // Named, with both numbers, so an operator reading the sender's queue knows
    // which side is behind rather than which side is broken.
    expect(refused.lastInboundError).toContain('epoch 5000');
    expect(refused.lastInboundError).toContain('9000');
    expect(refused.epochStatus.peers['dc-west-gw']).toBe(WEST_CURRENT_EPOCH);

    // And the change is still owed by the sender: the refusal was answered on the
    // wire, so the entry it answers stays in the queue instead of being retired.
    const sender = await west.gateway.status<GatewayStatus>();
    expect(sender.pending['dc-east-gw'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(sender.deadLetters).toBe(0);
  }, 300_000);

  it('AC-F9: the same datacenter at its current incarnation delivers what was refused', async () => {
    // Redeployed on the right image. Nothing is re-enqueued: the entry the peer
    // refused is still on the outbox, and the retry is what delivers it.
    await stopCluster(west);
    west = await bootCluster({ ...westBase, config: { ...westBase.config, epoch: WEST_CURRENT_EPOCH } });
    processes.push(west.gateway, ...west.followers);

    const delivered = await waitUntil(
      async () => {
        const [eastStatus, westStatus] = await Promise.all([
          east.gateway.status<GatewayStatus>(),
          west.gateway.status<GatewayStatus>(),
        ]);
        const landed = eastStatus.state['resurrected'] === 'from-the-past';
        const drained = (westStatus.pending['dc-east-gw'] ?? 0) === 0;
        return landed && drained ? { eastStatus, westStatus } : undefined;
      },
      90_000,
      'the refused change to be delivered by the correct incarnation',
      250,
    );

    // The watermark did not move backwards through any of this: the restored
    // incarnation was refused, and the current one was already current.
    expect(delivered.eastStatus.epochStatus.peers['dc-west-gw']).toBe(WEST_CURRENT_EPOCH);
    expect(delivered.eastStatus.epochStatus.refused).toBeGreaterThanOrEqual(1);
    expect(delivered.westStatus.deadLetters).toBe(0);
  }, 300_000);
});
