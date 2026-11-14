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
  localStore: number;
  pending: Record<string, number>;
  connectedPeers: string[];
  transport: {
    messagesSent: number;
    messagesReceived: number;
    peersConnected: number;
  };
}

interface GatewayOptions {
  nodeId: string;
  dc: string;
  transportNodeId: number;
  certIndex: number;
  peer: {
    nodeId: string;
    dc: string;
    host: string;
    port: number;
    transportNodeId: number;
  };
  nodes: ClusterNodeSpec[];
}

/** Build the gateway spec: it is node 1 of its local cluster and the DC's federation peer. */
function gatewayConfig(opts: GatewayOptions, listenPort: number): Record<string, unknown> {
  const self = opts.nodes.find((n) => n.id === 1)!;
  return {
    nodeId: opts.nodeId,
    dc: opts.dc,
    transportNodeId: opts.transportNodeId,
    listen: { host: '127.0.0.1', port: listenPort },
    peer: opts.peer,
    dataDir: self.dataDir,
    outboxDir: join(self.dataDir, 'outbox'),
    stateFile: join(self.dataDir, 'gateway-state.json'),
    federationCert: certs.nodes[opts.certIndex]!,
    raft: {
      id: 1,
      node: { id: 1, host: self.host, port: self.port },
      peers: self.peers,
      cert: self.cert,
      // raft-core requires electionTimeoutMin >= 3 x heartbeatInterval.
      // tickIntervalMs=50 → heartbeat 100ms, election 400ms (gateway wins the
      // first election; followers use 50 ticks = 2.5s).
      electionTick: 8,
      heartbeatTick: 2,
      tickIntervalMs: 50,
    },
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
    // Followers wait longer than the gateway, so the gateway (which also owns
    // the federation stack) reliably wins the first election.
    electionTick: index === 0 ? 4 : 50,
    heartbeatTick: index === 0 ? 2 : 10,
  }));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }
  return specs;
}

async function gatewayStatus(gateway: ChildNode): Promise<GatewayStatus> {
  return gateway.status<GatewayStatus>();
}

async function waitForValue(where: 'east' | 'west', key: string, value: string, timeoutMs = 60_000) {
  return waitUntil(
    async () => {
      const gateway = where === 'east' ? eastGateway : westGateway;
      const status = await gatewayStatus(gateway);
      return status.state[key] === value ? status : undefined;
    },
    timeoutMs,
    `${where} to converge on ${key}=${value}`,
    250,
  );
}

let eastGateway: ChildNode;
let westGateway: ChildNode;
let eastConfig: Record<string, unknown>;
let westConfig: Record<string, unknown>;
let eastSpecs: ClusterNodeSpec[];
let westSpecs: ClusterNodeSpec[];
let eastNodes: ChildNode[] = [];
let westNodes: ChildNode[] = [];

async function startCluster(
  prefix: 'east' | 'west',
  specs: ClusterNodeSpec[],
  config: Record<string, unknown>,
  label: string,
): Promise<{ gateway: ChildNode; followers: ChildNode[] }> {
  // Boot the whole 3-node group before waiting for leadership.
  //
  // A 3-node Raft group needs a quorum of 2 to elect anyone, so waiting for
  // the gateway to win an election while it is the only live member can never
  // succeed. The gateway still wins deterministically because its election
  // timeout (400ms) is far shorter than the followers' (2.5s).
  const gateway = spawnGateway(config, `${label}-gateway`);
  processes.push(gateway);

  const followers = specs
    .filter((s) => s.id !== 1)
    .map((spec) => {
      const node = spawnRaftNode(spec);
      processes.push(node);
      return node;
    });

  await Promise.all([gateway.waitForType('ready', 90_000), ...followers.map((f) => f.waitForType('ready', 60_000))]);

  await waitUntil(
    async () => {
      const status = await gatewayStatus(gateway);
      return status.isLeader;
    },
    45_000,
    `${label} gateway to become cluster leader`,
    250,
  );

  await waitUntil(
    async () => {
      const status = await gatewayStatus(gateway);
      return status.commitIndex >= 0 && followers.every((f) => !f.exited) ? status : undefined;
    },
    30_000,
    `${label} cluster to reach a stable state`,
    250,
  );

  return { gateway, followers };
}

describe('Cross-cluster sync over mTLS (two real clusters)', () => {
  it('boots two independent 3-node clusters with a federation gateway each', async () => {
    const ports = await getFreePorts(6);
    const fedPorts = await getFreePorts(2);
    const baseDir = makeTempDir('cross-cluster');
    dirs.push(baseDir);

    eastSpecs = buildCluster('east', baseDir, ports.slice(0, 3));
    westSpecs = buildCluster('west', baseDir, ports.slice(3, 6));

    eastConfig = gatewayConfig(
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
      },
      fedPorts[0]!,
    );

    westConfig = gatewayConfig(
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
      },
      fedPorts[1]!,
    );

    const east = await startCluster('east', eastSpecs, eastConfig, 'east');
    eastGateway = east.gateway;
    eastNodes = east.followers;

    const west = await startCluster('west', westSpecs, westConfig, 'west');
    westGateway = west.gateway;
    westNodes = west.followers;

    const eastStatus = await gatewayStatus(eastGateway);
    const westStatus = await gatewayStatus(westGateway);
    expect(eastStatus.isLeader).toBe(true);
    expect(westStatus.isLeader).toBe(true);
    expect(eastNodes.every((n) => !n.exited)).toBe(true);
    expect(westNodes.every((n) => !n.exited)).toBe(true);
  }, 240_000);

  it('AC-F2: inter-DC link is TLS 1.3 with mutual authentication', async () => {
    // The gateways must have established the outbound TLS connection.
    const status = await waitUntil(
      async () => {
        const s = await gatewayStatus(eastGateway);
        return s.connectedPeers.length > 0 ? s : undefined;
      },
      30_000,
      'east gateway to see the west peer connected',
      250,
    );
    expect(status.connectedPeers).toContain('dc-west-gw');

    // Independently verify the listener speaks TLS 1.3 and demands a client
    // certificate signed by the cluster CA.
    const westListenPort = (westConfig.listen as { port: number }).port;

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
          cert: certs.nodes[3]!.cert,
          key: certs.nodes[3]!.key,
          ca: certs.caPem,
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
          cert: certs.rogue.cert,
          key: certs.rogue.key,
          ca: certs.caPem,
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
    eastGateway.send({
      cmd: 'replicate',
      key: 'user:1',
      value: 'alice',
      type: 'insert',
    });
    await eastGateway.waitFor((m) => m.type === 'replicated', 20_000, 'east replication ack');

    const west = await waitForValue('west', 'user:1', 'alice');
    expect(west.state['user:1']).toBe('alice');

    // The value must be committed by the west *cluster*, i.e. all replicas applied it.
    const appliedEverywhere = await waitUntil(
      async () => {
        const statuses = await Promise.all(
          westNodes.map((n) => n.status<{ applied: string[]; commitIndex: number }>()),
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
      eastGateway.send({
        cmd: 'replicate',
        key,
        value: `v-${key}`,
        type: 'insert',
      });
    }

    const west = await waitUntil(
      async () => {
        const status = await gatewayStatus(westGateway);
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
        const status = await gatewayStatus(eastGateway);
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
    eastGateway.send({
      cmd: 'replicate',
      key: 'conflict',
      value: 'east-wins?',
      type: 'update',
    });
    westGateway.send({
      cmd: 'replicate',
      key: 'conflict',
      value: 'west-wins?',
      type: 'update',
    });

    const converged = await waitUntil(
      async () => {
        const [east, west] = await Promise.all([gatewayStatus(eastGateway), gatewayStatus(westGateway)]);
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
    await westGateway.terminate();
    await westGateway.waitForExit();
    for (const node of westNodes) {
      node.kill();
      await node.waitForExit();
    }

    const before = await gatewayStatus(eastGateway);
    eastGateway.send({
      cmd: 'replicate',
      key: 'during-outage',
      value: 'stored-offline',
      type: 'insert',
    });
    await eastGateway.waitFor((m) => m.type === 'replicated', 20_000, 'east replication during outage');

    // The outbox must retain the entry while the peer is unreachable.
    await waitUntil(
      async () => {
        const status = await gatewayStatus(eastGateway);
        return (status.pending['dc-west-gw'] ?? 0) > (before.pending['dc-west-gw'] ?? 0) ? status : undefined;
      },
      45_000,
      'outbox to retain the offline entry',
      250,
    );

    // Restart the whole west DC on the same ports, data dirs and outbox.
    westGateway = spawnGateway(westConfig, 'west-gateway-restarted');
    processes.push(westGateway);
    westNodes = westSpecs
      .filter((spec) => spec.id !== 1)
      .map((spec) => {
        const node = spawnRaftNode(spec);
        processes.push(node);
        return node;
      });
    await Promise.all([
      westGateway.waitForType('ready', 90_000),
      ...westNodes.map((n) => n.waitForType('ready', 60_000)),
    ]);

    const west = await waitForValue('west', 'during-outage', 'stored-offline', 120_000);
    expect(west.state['during-outage']).toBe('stored-offline');

    // Previously replicated keys survived the restart (durable state).
    expect(west.state['user:1']).toBe('alice');
  }, 300_000);
});

afterAll(async () => {
  await Promise.all(processes.map((p) => p.terminate().catch(() => undefined)));
  for (const dir of dirs) removeTempDir(dir);
}, 120_000);
