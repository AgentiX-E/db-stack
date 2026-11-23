/**
 * The startup hole: a node whose engine is behind the position Raft declares.
 *
 * Why this file exists
 * --------------------
 * `AC-C7` (a full-cluster restart after compaction keeps every write) once failed
 * with one node's engine holding one key fewer than the cluster acknowledged, and
 * nothing in the logs could name the missing write: no snapshot was installed, no
 * restore failed, no apply raised. The surviving explanation is that the node was
 * *handed* the position without being handed the state — and the one code path
 * that does exactly that is `applyCommittedEntries`:
 *
 * ```js
 * if (nextIndex <= snapshotIndex) {
 *   this.volatileState.setLastApplied(snapshotIndex);   // the log moves
 *   continue;                                            // the application is never called
 * }
 * ```
 *
 * That branch is correct for entries the snapshot covers *and the application
 * therefore already has*. A node whose engine is behind its log lands in it with a
 * hole exactly as wide as the difference, and the difference is no longer in the
 * log to be replayed. There are three ways to be in that state and only one of
 * them is exotic:
 *
 * - the engine was restored from an older backup than the Raft log;
 * - `installSnapshot` was registered but quietly did nothing (a handler that
 *   writes nowhere is indistinguishable from one that works);
 * - `takeSnapshot` was registered and `installSnapshot` was not, so the snapshot
 *   raft loads during `start()` has nowhere to go.
 *
 * `RaftAdapter` cannot see the engine. What it can do is refuse to run when the
 * application says it is behind — via the `appliedIndex` provider — and refuse the
 * one configuration that is decidable from the handler table alone (state owned,
 * snapshot present, no way to receive it).
 *
 * Every case here runs a real `RaftNode` on real SQLite storage in a real
 * temporary directory across two `init()` cycles: the snapshot the second node
 * loads is the snapshot the first node wrote, through the adapter's own callbacks.
 *
 * Acceptance criteria:
 *   AC 72.1  a snapshot in storage with no `installSnapshot` to receive it is
 *            refused at startup, naming the snapshot index
 *   AC 72.2  an `installSnapshot` that restores nothing is caught by the
 *            application's own position, naming both indexes and the width of the
 *            hole
 *   AC 72.3  a correctly wired restart recovers every write and reports a zero gap
 *   AC 72.4  an application that publishes no position reports `null`, never 0
 *   AC 72.5  a provider that answers with something that is not an index is refused
 *            as a wiring error rather than read as "caught up"
 *   AC 72.10 a provider that fails during a status read costs the status one field,
 *            not the reading
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';
import { EngineBackedReplica } from '../../engines/EngineBackedReplica';
import { MemoryStorageEngine } from '../../engines/MemoryStorageEngine';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';
import { generateClusterCerts } from '../../testing/test-certs';
import { cleanupTempDir, createTempDir, getFreePorts } from '../../testing/test-utils';

const ENTRY_COUNT = 4;
/** Small enough that the first node takes a snapshot mid-run. */
const SNAPSHOT_INTERVAL = 2;

type Handlers = Parameters<RaftAdapter['setApplicationSnapshotHandlers']>[0];

const running: RaftAdapter[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const adapter of running.splice(0)) {
    await adapter.stop().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function newDir(): string {
  const dir = createTempDir('state-gap-');
  dirs.push(dir);
  return dir;
}

/** Wait until `predicate` holds. Throws with the elapsed time rather than hanging forever. */
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

interface StartOptions {
  storagePath: string;
  handlers: Handlers;
  apply?: (data: string, index?: number, term?: number) => void | Promise<void>;
  snapshotInterval?: number;
}

/**
 * Start one single-node adapter on `storagePath`.
 *
 * Called twice per restart case with the same path: the second call is a restart
 * as far as raft-core is concerned — the log and the snapshot are on disk, the
 * in-process state is not.
 */
async function startNode(options: StartOptions): Promise<RaftAdapter> {
  const [port] = await getFreePorts(1);
  const certs = generateClusterCerts(1);
  const bundle = certs.nodes[0]!;
  const config: RaftConfig = {
    id: 1,
    peers: [],
    electionTick: 10,
    heartbeatTick: 3,
    tickIntervalMs: 30,
    storagePath: options.storagePath,
    snapshotInterval: options.snapshotInterval ?? SNAPSHOT_INTERVAL,
    environment: 'development',
  };
  const adapter = new RaftAdapter(config);
  adapter.setApplicationSnapshotHandlers(options.handlers);
  await adapter.init(options.apply ?? (() => undefined), {
    node: { id: 1, host: '127.0.0.1', port: port! },
    peers: [],
    tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
    connectTimeoutMs: 2000,
    initialRetryMs: 50,
    maxRetryMs: 500,
  });
  running.push(adapter);
  return adapter;
}

/** Propose `count` puts and wait for them to be applied by the local node. */
async function writeEntries(adapter: RaftAdapter, applied: string[], count = ENTRY_COUNT): Promise<void> {
  await waitFor(() => adapter.isLeader(), 'this node to become leader');
  for (let i = 1; i <= count; i += 1) {
    await adapter.propose(JSON.stringify({ key: `k${i}`, value: String(i) }));
  }
  await waitFor(async () => applied.length >= count, `${count} applies`, 10_000);
}

/** The snapshot the first node wrote, as raft-core reports it after a restart. */
function snapshotIndex(adapter: RaftAdapter): number {
  return adapter.getSnapshotMeta()?.lastIncludedIndex ?? 0;
}

/**
 * Run a first node far enough to take a snapshot, then stop it.
 *
 * Returns the storage path and the index the snapshot covers, so a restart can
 * assert against the exact boundary rather than "some snapshot".
 */
async function seedSnapshot(): Promise<{ storagePath: string; boundary: number }> {
  const storagePath = join(newDir(), 'raft.db');
  const applied: string[] = [];
  const replica = new EngineBackedReplica({ shardId: 0, engine: new MemoryStorageEngine() });
  const put = (data: string) => {
    const { key, value } = JSON.parse(data) as { key: string; value: string };
    return Buffer.from(JSON.stringify({ op: 'put', key, value }), 'utf8');
  };
  const first = await startNode({
    storagePath,
    handlers: {
      takeSnapshot: (boundaryIndex) => replica.snapshot(boundaryIndex),
      installSnapshot: (data) => replica.restore(data),
    },
    apply: (data, index, term) => {
      applied.push(data);
      return replica.apply({ index: index!, term: term!, command: 'kv', data: put(data) });
    },
  });
  await writeEntries(first, applied);
  await first.refreshSnapshotMeta();
  const boundary = snapshotIndex(first);
  expect(boundary, 'the first node must have taken a snapshot, or the restart proves nothing').toBeGreaterThan(0);
  await first.stop();
  running.splice(running.indexOf(first), 1);
  return { storagePath, boundary };
}

describe('a restart whose engine is behind the log', () => {
  it('AC 72.1: refuses a snapshot that no installSnapshot handler can receive', async () => {
    const { storagePath, boundary } = await seedSnapshot();

    // The configuration a group acquires by adding `takeSnapshot` and stopping
    // there: the application owns state, raft restores the snapshot during start(),
    // and nobody is listening for it. Before this guard the node started, reported
    // `lastApplied === boundary`, answered reads from an empty engine, and logged
    // nothing about the writes it had skipped.
    const restart = new RaftAdapter({
      id: 1,
      peers: [],
      electionTick: 10,
      heartbeatTick: 3,
      tickIntervalMs: 30,
      storagePath,
      snapshotInterval: SNAPSHOT_INTERVAL,
      environment: 'development',
    });
    restart.setApplicationSnapshotHandlers({ takeSnapshot: () => Buffer.from('ownership-proof') });

    const [port] = await getFreePorts(1);
    const certs = generateClusterCerts(1);
    const bundle = certs.nodes[0]!;
    const failure = await restart
      .init(() => undefined, {
        node: { id: 1, host: '127.0.0.1', port: port! },
        peers: [],
        tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
        connectTimeoutMs: 2000,
        initialRetryMs: 50,
        maxRetryMs: 500,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    running.push(restart);

    expect(failure).toBeInstanceOf(SqlVecError);
    const error = failure as SqlVecError;
    expect(error.code).toBe(SqlVecErrorCode.FAILED_PRECONDITION);
    expect(error.message).toContain(`holds a snapshot at index ${boundary}`);
    expect(error.message).toContain('registers no installSnapshot');
    // The message has to be actionable: the three ways out are in it.
    expect(error.message).toMatch(/Register installSnapshot .* register an appliedIndex provider .* resync/s);
  });

  it('AC 72.2: an installSnapshot that restores nothing is caught by the application position', async () => {
    const { storagePath, boundary } = await seedSnapshot();

    // The handler exists, so the previous check cannot fire — and that is the
    // interesting half: a handler that writes nowhere is indistinguishable, from
    // the handler table, from one that works. The application's own position is
    // the evidence that separates them.
    const restart = new RaftAdapter({
      id: 1,
      peers: [],
      electionTick: 10,
      heartbeatTick: 3,
      tickIntervalMs: 30,
      storagePath,
      snapshotInterval: SNAPSHOT_INTERVAL,
      environment: 'development',
    });
    restart.setApplicationSnapshotHandlers({
      takeSnapshot: () => Buffer.from('ownership-proof'),
      installSnapshot: () => undefined,
      appliedIndex: () => 0,
    });

    const [port] = await getFreePorts(1);
    const certs = generateClusterCerts(1);
    const bundle = certs.nodes[0]!;
    const failure = await restart
      .init(() => undefined, {
        node: { id: 1, host: '127.0.0.1', port: port! },
        peers: [],
        tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
        connectTimeoutMs: 2000,
        initialRetryMs: 50,
        maxRetryMs: 500,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    running.push(restart);

    expect(failure).toBeInstanceOf(SqlVecError);
    const error = failure as SqlVecError;
    expect(error.code).toBe(SqlVecErrorCode.FAILED_PRECONDITION);
    expect(error.message).toContain(`applied to index ${boundary}`);
    expect(error.message).toContain('the application reports 0');
    expect(error.message).toContain(`The ${boundary} entries in between`);
    expect(error.message).toContain('hole in them');
  });

  it('AC 72.3: a correctly wired restart recovers every write and reports a zero gap', async () => {
    const storagePath = join(newDir(), 'raft.db');

    /** Interpret one replicated payload into the reference engine's command format. */
    const put = (data: string) =>
      Buffer.from(JSON.stringify({ op: 'put', ...(JSON.parse(data) as { key: string; value: string }) }), 'utf8');

    /** A node's apply handler: record the command, then hand it to the engine. */
    const applyThrough =
      (replica: EngineBackedReplica, seen: string[]) => (data: string, index?: number, term?: number) => {
        seen.push(data);
        return replica.apply({ index: index!, term: term!, command: 'kv', data: put(data) });
      };

    // First life: a real engine behind the replica, commands interpreted by the
    // application exactly as a node process would.
    const applied: string[] = [];
    const firstReplica = new EngineBackedReplica({ shardId: 0, engine: new MemoryStorageEngine() });
    const first = await startNode({
      storagePath,
      handlers: {
        takeSnapshot: (boundaryIndex) => firstReplica.snapshot(boundaryIndex),
        installSnapshot: (data) => firstReplica.restore(data),
        appliedIndex: () => firstReplica.lastAppliedIndex(),
      },
      apply: applyThrough(firstReplica, applied),
    });
    await writeEntries(first, applied);
    await first.refreshSnapshotMeta();
    const boundary = snapshotIndex(first);
    expect(boundary).toBeGreaterThan(0);
    await first.stop();
    running.splice(running.indexOf(first), 1);

    // Second life: a blank engine, the log and the snapshot on disk. Everything the
    // engine holds has to arrive through `installSnapshot`.
    const secondReplica = new EngineBackedReplica({ shardId: 0, engine: new MemoryStorageEngine() });
    const appliedAgain: string[] = [];
    const second = await startNode({
      storagePath,
      handlers: {
        takeSnapshot: (boundaryIndex) => secondReplica.snapshot(boundaryIndex),
        installSnapshot: (data) => secondReplica.restore(data),
        appliedIndex: () => secondReplica.lastAppliedIndex(),
      },
      apply: applyThrough(secondReplica, appliedAgain),
    });

    expect(await second.getAppliedIndex()).toBe(boundary);
    expect(secondReplica.lastAppliedIndex(), 'the engine must be where raft says it is').toBe(boundary);

    const status = await second.getStatus();
    expect(status.applicationApplied).toBe(boundary);
    expect(status.appliedGap).toBe(0);
    expect(status.snapshot.lastIncludedIndex).toBe(boundary);

    // The snapshot covers a *log* boundary, not a command count: the leader appended
    // a no-op at index 1 before the first put, so a boundary of N carries N-1 of the
    // writes below it. What is above the boundary is still in the log and has to be
    // replayed — which is what the rest of this case waits for.
    const keysNow = JSON.parse(
      (await secondReplica.query(Buffer.from(JSON.stringify({ op: 'keys' }), 'utf8'))).toString('utf8'),
    ) as { keys: string[] };
    expect(keysNow.keys.length).toBe(boundary - 1);
    expect(keysNow.keys).not.toContain('k4');

    // And the node is writable again, from the recovered position. Winning the
    // election also commits the entries above the boundary, so the replay is part of
    // the same wait.
    await waitFor(() => second.isLeader(), 'the restarted node to lead');
    await second.propose(JSON.stringify({ key: 'after-restart', value: 'ok' }));
    await waitFor(async () => appliedAgain.length >= 2, 'the replayed tail and the new write', 10_000);

    const after = JSON.parse(
      (await secondReplica.query(Buffer.from(JSON.stringify({ op: 'keys' }), 'utf8'))).toString('utf8'),
    ) as { keys: string[] };
    expect(after.keys.sort()).toEqual(
      [...Array.from({ length: ENTRY_COUNT }, (_, i) => `k${i + 1}`), 'after-restart'].sort(),
    );
    // Nothing was applied twice: every index reached the engine exactly once.
    expect(appliedAgain).toHaveLength(2);
    expect(secondReplica.skippedReplays).toBe(0);
  });

  it('AC 72.4: an application that publishes no position reports null, not zero', async () => {
    const storagePath = join(newDir(), 'raft.db');
    const replica = new EngineBackedReplica({ shardId: 0, engine: new MemoryStorageEngine() });
    const adapter = await startNode({
      storagePath,
      handlers: {
        takeSnapshot: (boundaryIndex) => replica.snapshot(boundaryIndex),
        installSnapshot: (data) => replica.restore(data),
      },
    });

    const status = await adapter.getStatus();
    expect(status.applicationApplied).toBeNull();
    expect(status.appliedGap).toBeNull();
    // The Raft side of the pair is still reported: the absence is in the
    // application's half, and saying so is different from saying nothing.
    expect(typeof status.lastApplied).toBe('number');
  });

  it('AC 72.5: a provider that answers with something that is not an index is refused', async () => {
    const storagePath = join(newDir(), 'raft.db');
    const [port] = await getFreePorts(1);
    const certs = generateClusterCerts(1);
    const bundle = certs.nodes[0]!;
    const adapter = new RaftAdapter({
      id: 1,
      peers: [],
      electionTick: 10,
      heartbeatTick: 3,
      tickIntervalMs: 30,
      storagePath,
      snapshotInterval: SNAPSHOT_INTERVAL,
      environment: 'development',
    });
    // `undefined` is the shape a call that forgets to return has. Reading it as 0
    // would report a node at index 0 as caught up with a log at index 400.
    adapter.setApplicationSnapshotHandlers({ appliedIndex: () => undefined as unknown as number });

    const failure = await adapter
      .init(() => undefined, {
        node: { id: 1, host: '127.0.0.1', port: port! },
        peers: [],
        tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
        connectTimeoutMs: 2000,
        initialRetryMs: 50,
        maxRetryMs: 500,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    running.push(adapter);

    expect(failure).toBeInstanceOf(SqlVecError);
    expect((failure as SqlVecError).code).toBe(SqlVecErrorCode.INVALID_ARGUMENT);
    expect((failure as SqlVecError).message).toContain('returned undefined');
    expect((failure as SqlVecError).message).toContain('non-negative log index');
  });
  it('AC 72.10: a provider that fails during a status read leaves the rest of the status standing', async () => {
    const storagePath = join(newDir(), 'raft.db');
    const replica = new EngineBackedReplica({ shardId: 0, engine: new MemoryStorageEngine() });
    // Answers once — during `init()`, where the answer is checked — and then fails,
    // the way a provider that reads a closed handle does. `getStatus()` must not
    // disappear because one field could not be read: monitoring that goes blind the
    // moment the engine misbehaves loses exactly the window it was watching.
    let calls = 0;
    const adapter = await startNode({
      storagePath,
      handlers: {
        takeSnapshot: (boundaryIndex) => replica.snapshot(boundaryIndex),
        installSnapshot: (data) => replica.restore(data),
        appliedIndex: () => {
          calls += 1;
          if (calls === 1) return replica.lastAppliedIndex();
          throw new Error('engine handle closed');
        },
      },
    });

    const status = await adapter.getStatus();
    expect(status).not.toBeNull();
    expect(status.applicationApplied).toBeNull();
    expect(status.appliedGap).toBeNull();
    expect(typeof status.lastApplied).toBe('number');
    expect(typeof status.term).toBe('number');
  });
});
