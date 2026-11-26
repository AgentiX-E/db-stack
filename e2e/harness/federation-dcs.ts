/**
 * Two datacenters, booted the way production is.
 *
 * Each DC is a real 3-member Raft group over mutually-authenticated TLS, and one
 * federation gateway process that is member 1 of that group and the DC's
 * federation peer. Nothing is shared between the two DCs except a CA and a
 * socket: the only path a byte can take from one to the other is the
 * `TcpSecureTransport` connection the gateway opens.
 *
 * Why the boot sequence lives here
 * --------------------------------
 * Both federation acceptance suites need it, and a second copy would drift. The
 * part that must not drift is the election asymmetry: the gateway is given a
 * 400 ms election timeout against its followers' 2.5 s, so it wins the first
 * election deterministically. That asymmetry is load-bearing — the inbound apply
 * path proposes into the local group and *waits for leadership*, so a suite whose
 * gateway happened to lose the election would spend its budget waiting and report
 * the timeout as a replication defect.
 */

import { join } from 'node:path';
import type { ChildNode, ClusterNodeSpec } from './support';
import {
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnGateway,
  spawnRaftNode,
  waitUntil,
} from './support';
import type { TestClusterCerts } from '@agentix-e/db-cluster/testing';

export type Side = 'east' | 'west';

type Certificates = TestClusterCerts['nodes'][number];

/**
 * One gateway's observable state.
 *
 * Declared structurally rather than imported: this suite loads the published
 * build, and a type taken from the source tree would let the test agree with a
 * declaration the artefact does not ship.
 */
export interface GatewayStatus {
  nodeId: string;
  dc: string;
  isLeader: boolean;
  term: number;
  commitIndex: number;
  stateSize: number;
  /** What the local cluster committed. */
  state: Record<string, string>;
  /** How many keys the federation layer holds. */
  localStore: number;
  /** What the federation layer holds, key by key — what anti-entropy compares. */
  localValues: Record<string, string>;
  pending: Record<string, number>;
  connectedPeers: string[];
  transport: { messagesSent: number; messagesReceived: number; peersConnected: number };
  deadLetters: number;
  /** Targets whose queue came back after an outage, once each. */
  recoveredTargets: string[];
  lastSendError: string | null;
  inboundFrames: number;
  lastInboundError: string | null;
  /** The change stream's own accounting — a path the outbox does not share. */
  cdc: {
    captured: number;
    delivered: number;
    requeued: number;
    deliveryFailures: number;
    handlers: number;
    keysDelivered: number;
  };
  /** What the outbox runs with, not what a suite asked for. */
  retention: {
    retryWindowMs: number;
    retryBackoffMaxMs: number;
    dedupMs: number;
    deadLetterTtlMs: number;
    entryTtlMs: number;
  };
  protocols: ControlPlaneStatus;
}

export interface ControlPlaneStatus {
  antiEntropy: {
    sweeps: number;
    requestsSent: number;
    repliesSent: number;
    repliesReceived: number;
    pushesSent: number;
    pushesReceived: number;
    entriesApplied: number;
    entriesSkipped: number;
    timeouts: number;
    malformed: number;
    unsolicited: number;
    /** This node's own root at its last digest. */
    selfRoot: string | null;
    /** The most recent root each peer claimed, heard across the wire. */
    peers: Record<string, { root: string; total: number; depth: number; at: number }>;
    lastError: string | null;
  } | null;
  heartbeat: {
    sent: number;
    received: number;
    /** Frames at or below the last accepted sequence — duplicates and late ones. */
    outOfOrder: number;
    malformed: number;
    /** Silences the detector reported, once each. */
    expired: number;
    selfSeq: number;
    lastSentAt: number | null;
    lastReceivedAt: number | null;
    peers: Record<string, { seq: number; sentAt: number; appliedCount: number; at: number }>;
    lastError: string | null;
  } | null;
  bootstrap: {
    transfers: {
      inbound: Array<{
        transferId: string;
        peerId: string;
        expected: number;
        totalChunks: number | null;
        snapshotLsn: number;
        highWaterMark: number;
        applied: number;
        phase: 'snapshot' | 'handoff' | 'done';
      }>;
      outbound: Array<{ transferId: string; peerId: string; chunksSent: number; snapshotLsn: number | null }>;
    };
    chunksSent: number;
    chunksReceived: number;
    duplicateChunks: number;
    gapRequests: number;
    /** Transfers restarted because the sender's snapshot changed under them. */
    snapshotMoved: number;
    unknownTransfers: number;
    entriesApplied: number;
    handoffApplied: number;
    /** Only a transfer whose handoff completed is reported here. */
    completed: Array<{ transferId: string; peerId: string; chunks: number; handoffApplied: number }>;
    lastError: string | null;
  } | null;
  lsn: number;
}

export interface BootOptions {
  /**
   * The `FederationManager` intervals a scenario needs.
   *
   * Required rather than defaulted, and deliberately: every case in both
   * acceptance suites exists to be deterministic about *when* a sweep, a beat or a
   * chunk happens, so a suite that forgot to set these would be measuring the
   * production defaults and reporting the result as its own.
   */
  controlPlane: Record<string, unknown>;
  /**
   * The outbox's retry windows, when a scenario outlives one on purpose.
   *
   * A window is not a single number: one backoff has to fit inside the retry
   * budget that schedules it, or the budget is spent sleeping past its own
   * deadline. The store refuses the pair when a future edit shortens the budget
   * below the ceiling without moving the ceiling too — which is why the suite
   * states both and asserts what the outbox actually runs with.
   */
  outbox?: { retryWindowMs: number; retryBackoffMaxMs: number };
  /**
   * How often the gateway looks for entries it can revive. Default: the
   * gateway's own.
   */
  dlqScanIntervalMs?: number;
  /** Temp-directory label, so a failure names the suite that produced it. */
  label: string;
}

/** One datacenter: its gateway, its followers, and the specs that build them. */
export class Datacenter {
  gateway!: ChildNode;
  followers: ChildNode[] = [];

  constructor(
    readonly label: Side,
    readonly specs: ClusterNodeSpec[],
    readonly config: Record<string, unknown>,
    readonly listenPort: number,
  ) {}
}

export class TwoDatacenters {
  private readonly processes: ChildNode[] = [];
  private readonly dirs: string[] = [];

  private constructor(
    readonly certs: TestClusterCerts,
    readonly east: Datacenter,
    readonly west: Datacenter,
  ) {}

  /**
   * Boot both DCs and wait until each gateway leads its own group.
   *
   * Returns only when both are ready: a case that starts writing before this
   * resolves is racing the election, and the failure it produces is a
   * replication timeout that says nothing about replication.
   */
  static async boot(options: BootOptions): Promise<TwoDatacenters> {
    const certs = makeCertificates(5);
    const baseDir = makeTempDir(options.label);

    const raftPorts = await getFreePorts(6);
    const fedPorts = await getFreePorts(2);

    const east = buildCluster('east', baseDir, raftPorts.slice(0, 3), certs);
    const west = buildCluster('west', baseDir, raftPorts.slice(3, 6), certs);

    const eastDc = new Datacenter(
      'east',
      east.specs,
      gatewayConfig(
        {
          side: 'east',
          transportNodeId: 4,
          cert: certs.nodes[3]!,
          self: east.gateway,
          peer: { nodeId: 'dc-west-gw', dc: 'west', host: '127.0.0.1', port: fedPorts[1]!, transportNodeId: 5 },
          controlPlane: options.controlPlane,
          outbox: options.outbox,
          dlqScanIntervalMs: options.dlqScanIntervalMs,
        },
        fedPorts[0]!,
      ),
      fedPorts[0]!,
    );
    const westDc = new Datacenter(
      'west',
      west.specs,
      gatewayConfig(
        {
          side: 'west',
          transportNodeId: 5,
          cert: certs.nodes[4]!,
          self: west.gateway,
          peer: { nodeId: 'dc-east-gw', dc: 'east', host: '127.0.0.1', port: fedPorts[0]!, transportNodeId: 4 },
          controlPlane: options.controlPlane,
          outbox: options.outbox,
          dlqScanIntervalMs: options.dlqScanIntervalMs,
        },
        fedPorts[1]!,
      ),
      fedPorts[1]!,
    );

    const fixture = new TwoDatacenters(certs, eastDc, westDc);
    fixture.dirs.push(baseDir);

    await fixture.start('east');
    await fixture.start('west');
    return fixture;
  }

  /** Spawn one DC's processes and wait for its gateway to lead. */
  async start(side: Side): Promise<void> {
    const dc = this[side];
    const gateway = spawnGateway(dc.config, `${dc.label}-gateway`);
    this.processes.push(gateway);
    dc.gateway = gateway;

    dc.followers = dc.specs
      .filter((spec) => spec.id !== 1)
      .map((spec) => {
        const node = spawnRaftNode(spec);
        this.processes.push(node);
        return node;
      });

    // Boot the whole group before waiting for leadership: a 3-member group needs
    // a quorum of two, so waiting for the gateway to win while it is the only
    // live member can never succeed.
    await Promise.all([
      gateway.waitForType('ready', 90_000),
      ...dc.followers.map((follower) => follower.waitForType('ready', 60_000)),
    ]);

    await waitUntil(
      async () => {
        const status = await this.status(side);
        return status.isLeader;
      },
      45_000,
      `${dc.label} gateway to become cluster leader`,
      250,
    );
  }

  /** Take one whole datacenter down — gateway and followers. */
  async stop(side: Side): Promise<void> {
    const dc = this[side];
    await dc.gateway.terminate();
    await dc.gateway.waitForExit();
    for (const follower of dc.followers) {
      follower.kill();
      await follower.waitForExit();
    }
  }

  async status(side: Side): Promise<GatewayStatus> {
    return this[side].gateway.status<GatewayStatus>();
  }

  /** Poll until one side's committed state holds `key = value`. */
  async waitForValue(side: Side, key: string, value: string, timeoutMs = 60_000): Promise<GatewayStatus> {
    return waitUntil(
      async () => {
        const status = await this.status(side);
        return status.state[key] === value ? status : undefined;
      },
      timeoutMs,
      `${this[side].label} to converge on ${key}=${value}`,
      250,
    );
  }

  /**
   * Poll until both sides agree, in both views of the same key.
   *
   * Both views, because they can disagree: `state` is what the local cluster
   * committed and `localValues` is what the federation layer holds. A repair that
   * lands in one and not the other is state a restart forgets, and an assertion
   * on either alone cannot see the difference.
   */
  async waitForConvergence(key: string, value: string, timeoutMs = 60_000): Promise<[GatewayStatus, GatewayStatus]> {
    return waitUntil(
      async () => {
        const [east, west] = await Promise.all([this.status('east'), this.status('west')]);
        const agreed =
          east.localValues[key] === value &&
          west.localValues[key] === value &&
          east.state[key] === value &&
          west.state[key] === value;
        return agreed ? ([east, west] as [GatewayStatus, GatewayStatus]) : undefined;
      },
      timeoutMs,
      `both DCs to hold ${key}=${value} in the cluster and the federation layer`,
      250,
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processes.map((p) => p.terminate().catch(() => undefined)));
    for (const dir of this.dirs) removeTempDir(dir);
  }
}

interface GatewayOptions {
  side: Side;
  transportNodeId: number;
  cert: Certificates;
  /** The member the gateway hosts: always member 1 of the group built here. */
  self: ClusterNodeSpec;
  peer: { nodeId: string; dc: string; host: string; port: number; transportNodeId: number };
  controlPlane: Record<string, unknown>;
  outbox?: { retryWindowMs: number; retryBackoffMaxMs: number };
  dlqScanIntervalMs?: number;
}

function gatewayConfig(opts: GatewayOptions, listenPort: number): Record<string, unknown> {
  const self = opts.self;
  return {
    nodeId: `dc-${opts.side}-gw`,
    dc: opts.side,
    transportNodeId: opts.transportNodeId,
    listen: { host: '127.0.0.1', port: listenPort },
    peer: opts.peer,
    dataDir: self.dataDir,
    outboxDir: join(self.dataDir, 'outbox'),
    stateFile: join(self.dataDir, 'gateway-state.json'),
    federationCert: opts.cert,
    // Forwarded only when the scenario named them, so a suite that says nothing
    // measures the gateway's defaults rather than a value this fixture invented.
    ...(opts.outbox ? { outbox: opts.outbox } : {}),
    ...(opts.dlqScanIntervalMs === undefined ? {} : { dlqScanIntervalMs: opts.dlqScanIntervalMs }),
    // The cursor an interrupted bootstrap resumes from, per DC. Owned by the
    // gateway rather than by the suite, for the same reason `outboxDir` is: two
    // gateways sharing one cursor file would read-modify-write each other's
    // entries, and a resumed transfer would start at a chunk the other side
    // wrote.
    controlPlane: {
      bootstrapResumePath: join(self.dataDir, 'bootstrap-cursor.json'),
      ...opts.controlPlane,
    },
    raft: {
      id: 1,
      node: { id: 1, host: self.host, port: self.port },
      peers: self.peers,
      cert: self.cert,
      // raft-core requires electionTimeoutMin >= 3 x heartbeatInterval.
      // tickIntervalMs=50 → heartbeat 100 ms, election 400 ms for the gateway
      // (which therefore wins the first election) against 2.5 s for followers.
      electionTick: 8,
      heartbeatTick: 2,
      tickIntervalMs: 50,
    },
  };
}

function buildCluster(
  prefix: Side,
  baseDir: string,
  ports: number[],
  certs: TestClusterCerts,
): { specs: ClusterNodeSpec[]; gateway: ClusterNodeSpec } {
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
  // Member 1, by construction: the list is built from `[1, 2, 3]`.
  return { specs, gateway: specs[0]! };
}
