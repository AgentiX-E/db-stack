/**
 * The application snapshot hooks, exercised through a real `RaftNode`.
 *
 * Why this file exists
 * --------------------
 * `takeSnapshotCallback` and `installSnapshotCallback` are the only path between
 * an engine's bytes and Raft's log truncation. Both used to accept anything: a
 * handler returning `undefined` or an empty buffer had its result stored as the
 * snapshot for the boundary, after which raft-core truncates the log for an index
 * whose state nobody captured. Followers then install nothing and report
 * themselves current — the failure this iteration exists to close.
 *
 * The cases drive the callbacks the way raft-core does (`applicationStateMachine`,
 * the object the adapter hands to the node), so what is asserted is the contract
 * the library actually calls, not a re-implementation of it.
 *
 * Acceptance criteria:
 *   AC 39.1  no handler is allowed and yields an empty snapshot, because a group
 *            that owns no application state has nothing to capture
 *   AC 39.2  a handler that returns a non-Buffer is refused, naming the type
 *   AC 39.3  a handler that returns 0 bytes is refused, naming the consequence
 *   AC 39.4  a handler that returns bytes is stored verbatim
 *   AC 39.5  an install calls the handler with the transferred bytes
 *   AC 39.6  the snapshot threshold reaches raft-core even when unset, as this
 *            package's documented default rather than the library's whim
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RaftAdapter, DEFAULT_SNAPSHOT_INTERVAL, type RaftConfig } from '../../consensus/core/RaftAdapter';
import { generateClusterCerts } from '../../testing/test-certs';
import { getFreePorts } from '../../testing/test-utils';

function config(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return {
    id: 1,
    peers: [2, 3],
    electionTick: 10,
    heartbeatTick: 3,
    useInMemoryStorage: true,
    ...overrides,
  };
}

/** The application state machine the adapter handed to raft-core. */
interface SnapshotCapable {
  takeSnapshot(): Promise<Buffer>;
  installSnapshot(data: Buffer): Promise<void>;
}

function stateMachineOf(adapter: RaftAdapter): SnapshotCapable {
  const node = (adapter as unknown as { node: { applicationStateMachine: SnapshotCapable } | null }).node;
  if (!node) throw new Error('adapter has no node — init() was not awaited');
  return node.applicationStateMachine;
}

describe('RaftAdapter application snapshot hooks', () => {
  let adapter: RaftAdapter | null = null;

  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
  });

  /**
   * Start a real single-node adapter.
   *
   * A bare `useInMemoryStorage` adapter cannot be initialised — the loopback
   * transport is required — so the hooks are driven on the object graph a real
   * node owns: real storage, real TLS listener, real `RaftNode`. Nothing about
   * the callbacks is stubbed.
   */
  async function started(
    handlers?: Parameters<RaftAdapter['setApplicationSnapshotHandlers']>[0],
    overrides: Partial<RaftConfig> = {},
  ) {
    const [port] = await getFreePorts(1);
    const certs = generateClusterCerts(1);
    const bundle = certs.nodes[0]!;
    adapter = new RaftAdapter(config({ peers: [], ...overrides }));
    if (handlers) adapter.setApplicationSnapshotHandlers(handlers);
    await adapter.init(() => {}, {
      node: { id: 1, host: '127.0.0.1', port: port! },
      peers: [],
      tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
      connectTimeoutMs: 2000,
      initialRetryMs: 50,
      maxRetryMs: 500,
    });
    return adapter;
  }

  it('AC 39.1 — without a handler a snapshot is empty, and that is allowed', async () => {
    // A group that keeps no application state still needs a boundary for Raft to
    // truncate the log at; there is nothing to capture, so empty is correct here
    // and only here.
    const a = await started();
    const data = await stateMachineOf(a).takeSnapshot();
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBe(0);
  }, 30_000);

  it('AC 39.2 — a handler returning a non-Buffer is refused', async () => {
    const a = await started({
      // The mistake a JSON serializer makes: `JSON.stringify` returns a string,
      // which raft-core stores as nothing.
      takeSnapshot: () => '{"a":1}' as unknown as Buffer,
    });

    await expect(stateMachineOf(a).takeSnapshot()).rejects.toThrow(/instead of a Buffer/);
  }, 30_000);

  it('AC 39.3 — a handler returning 0 bytes is refused', async () => {
    // The dangerous case: the handler says the application owns state and then
    // produces none, which would truncate the log for an index it does not
    // describe.
    const a = await started({ takeSnapshot: () => Buffer.alloc(0) });

    await expect(stateMachineOf(a).takeSnapshot()).rejects.toThrow(/returned 0 bytes/);
  }, 30_000);

  it('AC 39.4 — a handler returning bytes is passed through unchanged', async () => {
    const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
    const a = await started({ takeSnapshot: () => payload });

    const data = await stateMachineOf(a).takeSnapshot();
    expect(data.equals(payload)).toBe(true);
  }, 30_000);

  it('AC 39.5 — an install hands the transferred bytes to the handler', async () => {
    const seen: Buffer[] = [];
    const a = await started({
      takeSnapshot: () => Buffer.from('state'),
      installSnapshot: (data) => {
        seen.push(data);
      },
    });

    await stateMachineOf(a).installSnapshot(Buffer.from('restored'));
    expect(seen.map((b) => b.toString())).toEqual(['restored']);
  }, 30_000);

  it('AC 39.6 — the snapshot threshold is the one this package documents, set or unset', async () => {
    // Read from the node raft-core built, because that is where the number is used:
    // a config field that never arrives there is exactly the defect this closes
    // (`snapshotInterval` was documented for two releases and never forwarded).
    const thresholdOf = (a: RaftAdapter) =>
      (a as unknown as { node: { snapshotThreshold: number } }).node.snapshotThreshold;

    const byDefault = await started();
    expect(thresholdOf(byDefault)).toBe(DEFAULT_SNAPSHOT_INTERVAL);
    await byDefault.stop();

    const configured = await started(undefined, { snapshotInterval: 50 });
    expect(thresholdOf(configured)).toBe(50);
  }, 60_000);
});
