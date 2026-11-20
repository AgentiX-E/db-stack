/**
 * RaftAdapter — Membership behavior.
 *
 * Why this file exists
 * --------------------
 * The cluster could always *describe* membership and never *change* it from a
 * running node. The library has `addServer` / `promoteServer` / `removeServer`,
 * but this adapter exposed none of them, and the transport it builds answered
 * `addPeer` with an empty body: raft-core asked the wire to register a new peer,
 * was told nothing had failed, and then had nowhere to send the entries. A node
 * "joined" the configuration and never received a byte.
 *
 * These cases pin the three questions the adapter now answers distinctly, because
 * they need different actions from the caller:
 *   - did the configuration change at all?
 *   - if not, was it because this node is not the leader, or because the node that
 *     was named cannot be reached?
 *   - and does quorum accounting follow the configuration it just changed?
 *
 * Acceptance criteria:
 *   AC 34.53 getMembership reads the persisted committed configuration
 *   AC 34.54 getMembership falls back to the bootstrap set when nothing is persisted
 *   AC 34.55 getMembership falls back to the bootstrap set when the store cannot be read
 *   AC 34.56 getMembership treats an empty voter row as corrupt, not as a cluster of nobody
 *   AC 34.55b getMembership falls back to the bootstrap set when the store has no reader
 *   AC 34.57 getMembership normalizes string ids, duplicates, and unsorted entries
 *   AC 34.57b a configuration with no learners row is a configuration with no learners
 *   AC 34.57c an unreadable member entry is skipped, not counted as zero
 *   AC 34.58 refreshMembership points the watchdog at the voters it just read
 *   AC 34.59 refreshMembership leaves the watchdog alone when only the bootstrap set is known
 *   AC 34.60 addServer reports not-started before it looks at anything else
 *   AC 34.61 addServer reports not-leader and changes nothing
 *   AC 34.61b addServer reports no-quorum for a leader that has lost its majority
 *   AC 34.62 addServer reports unsupported on a transport without membership support
 *   AC 34.63 addServer refuses an unreachable node, and takes the registration back
 *   AC 34.64 addServer commits the change, then refreshes quorum accounting
 *   AC 34.65 addServer rolls the registration back when raft rejects the change
 *   AC 34.66 addServer does not roll back a node that was already a member
 *   AC 34.67 addServer rejects an id that cannot be a member
 *   AC 34.68 promoteServer reports not-started, not-leader, and unsupported ids
 *   AC 34.69 promoteServer reports rejected when raft refuses, and commits when it accepts
 *   AC 34.70 removeServer reports not-started, not-leader, and unsupported ids
 *   AC 34.71 removeServer reports rejected when raft refuses, and commits when it accepts
 *   AC 34.89 a refused change leaves no trace in the membership or the majority this
 *            adapter reports (the single-step requirement, measured)
 *   AC 34.90 checkQuorum: false answers leadership from the role and reads no
 *            configuration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';
import { BatchedRaftTransport } from '../../consensus/transport/BatchedRaftTransport';
import { QuorumWatchdog } from '../../consensus/core/QuorumWatchdog';

// ── Helpers ──────────────────────────────────────────────────────────────────

function config(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return { id: 1, peers: [2, 3], electionTick: 10, heartbeatTick: 3, ...overrides };
}

interface Harness {
  adapter: RaftAdapter;
  node: any;
  transport: BatchedRaftTransport;
  store: { read: ReturnType<typeof vi.fn> };
  watchdog: QuorumWatchdog;
}

/**
 * An adapter whose three collaborators are replaced: the raft node, the storage
 * that holds the committed configuration, and the batched transport that owns the
 * wire. Nothing here opens a socket or a database.
 */
function harness(
  overrides: Partial<RaftConfig> = {},
  options: { reachable?: boolean; quorate?: boolean } = {},
): Harness {
  const adapter = new RaftAdapter(config(overrides));

  const node = {
    isLeader: vi.fn(async () => true),
    addServer: vi.fn(async () => true),
    promoteServer: vi.fn(async () => true),
    removeServer: vi.fn(async () => true),
  };
  (adapter as any).node = node;

  const store = { read: vi.fn(async () => null as any) };
  (adapter as any).nodeStorage = { config: store };

  const transport = new BatchedRaftTransport({
    node: { id: 1, host: '127.0.0.1', port: 0 },
    peers: [],
    tls: { cert: '', key: '', ca: '' },
  });
  vi.spyOn(transport, 'addPeer').mockResolvedValue(undefined);
  vi.spyOn(transport, 'removePeer').mockImplementation(() => {});
  vi.spyOn(transport, 'awaitPeer').mockResolvedValue(options.reachable !== false);
  (adapter as any).rawTransport = transport;

  const watchdog = new QuorumWatchdog({ selfId: 1, peers: [2, 3], windowMs: 1_000 });
  // Two of three is a majority. A test that wants "the leader cannot serve" passes
  // `quorate: false` instead of relying on the absence of an observation.
  if (options.quorate !== false) watchdog.observe(2);
  (adapter as any).watchdog = watchdog;

  return { adapter, node, transport, store, watchdog };
}

const persisted = (voters: unknown[], learners: unknown[] = []) => ({ voters, learners });

// ── Suite ────────────────────────────────────────────────────────────────────

describe('RaftAdapter membership', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('AC 34.53 — getMembership reads the persisted committed configuration', async () => {
    const { adapter, store } = harness();
    store.read.mockResolvedValue(persisted([{ id: '1' }, { id: '2' }, { id: '3' }], [{ id: '4' }]));

    await expect(adapter.getMembership()).resolves.toEqual({
      voters: [1, 2, 3],
      learners: [4],
      source: 'persisted',
    });
  });

  it('AC 34.54 — nothing persisted means the bootstrap set, and it says so', async () => {
    const { adapter } = harness();

    await expect(adapter.getMembership()).resolves.toEqual({
      voters: [1, 2, 3],
      learners: [],
      source: 'bootstrap',
    });
  });

  it('AC 34.55 — an unreadable store falls back to the bootstrap set instead of an empty cluster', async () => {
    const { adapter, store } = harness();
    store.read.mockRejectedValue(new Error('disk gone'));

    const membership = await adapter.getMembership();

    // Answering "no voters" here would divide by zero in the majority arithmetic and
    // tell every caller the cluster is empty.
    expect(membership).toEqual({ voters: [1, 2, 3], learners: [], source: 'bootstrap' });
  });

  it('AC 34.56 — an empty voter row is corrupt data, not a cluster of nobody', async () => {
    const { adapter, store } = harness();
    store.read.mockResolvedValue(persisted([], [{ id: '9' }]));

    await expect(adapter.getMembership()).resolves.toMatchObject({ voters: [1, 2, 3], source: 'bootstrap' });
  });

  it('AC 34.55b — a store with no configuration reader is answered from the bootstrap set', async () => {
    const { adapter } = harness();
    (adapter as any).nodeStorage = { config: {} };

    await expect(adapter.getMembership()).resolves.toMatchObject({ voters: [1, 2, 3], source: 'bootstrap' });
  });

  it('AC 34.57 — string ids, duplicates and ordering are normalized', async () => {
    const { adapter, store } = harness();
    store.read.mockResolvedValue(persisted(['3', '1', { id: 2 }, '1', 'not-a-number']));

    const membership = await adapter.getMembership();

    expect(membership.voters).toEqual([1, 2, 3]);
    expect(membership.source).toBe('persisted');
  });

  it('AC 34.57b — a row with no learners list has no learners', async () => {
    const { adapter, store } = harness();
    store.read.mockResolvedValue({ voters: [{ id: 1 }] } as any);

    await expect(adapter.getMembership()).resolves.toEqual({
      voters: [1],
      learners: [],
      source: 'persisted',
    });
  });

  it('AC 34.57c — an unreadable member entry is skipped, not counted as zero', async () => {
    const { adapter, store } = harness();
    // A `null` entry has no id; reading it as 0 would put a phantom voter in every
    // majority this node computes.
    store.read.mockResolvedValue(persisted([null, { id: 2 }, 'not-a-number']));

    await expect(adapter.getMembership()).resolves.toMatchObject({ voters: [2] });
  });

  it('AC 34.58 — refreshMembership points the watchdog at the voters it just read', async () => {
    const { adapter, store, watchdog } = harness();
    store.read.mockResolvedValue(persisted([1, 2, 3, 4]));

    await adapter.refreshMembership();

    // Four voters means a majority of three; a watchdog still holding three members
    // would call two answers a quorum.
    expect(watchdog.size).toBe(4);
    expect(watchdog.majority).toBe(3);
  });

  it('AC 34.59 — with only the bootstrap set known, the watchdog keeps what it has', async () => {
    const { adapter, store, watchdog } = harness();
    store.read.mockResolvedValue(null);

    await adapter.refreshMembership();

    expect(watchdog.size).toBe(3);
  });

  it('AC 34.60 — addServer reports not-started before it looks at anything else', async () => {
    const { adapter, node } = harness();
    (adapter as any).node = null;

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'not-started',
    });
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.61 — addServer reports not-leader and touches nothing', async () => {
    const { adapter, node, transport } = harness();
    node.isLeader.mockResolvedValue(false);

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'not-leader',
    });
    expect(transport.addPeer).not.toHaveBeenCalled();
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.61b — a leader without a majority is refused with its own reason', async () => {
    const { adapter, node, transport } = harness({}, { quorate: false });

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'no-quorum',
    });
    // Appending under a lost quorum would be a five-second wait and a half-applied
    // configuration; nothing is registered and nothing is appended.
    expect(transport.addPeer).not.toHaveBeenCalled();
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.62 — a transport without membership support is named as such', async () => {
    const { adapter, node } = harness();
    (adapter as any).rawTransport = { send: vi.fn() };

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'unsupported',
    });
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.63 — an unreachable node is refused before an entry exists, and unregistered', async () => {
    const { adapter, node, transport } = harness({}, { reachable: false });

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'unreachable',
    });

    // The registration is taken back: the pool would otherwise dial a node that never
    // became a member, once per backoff step, for the life of the process.
    expect(transport.removePeer).toHaveBeenCalledWith('4');
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.64 — a committed change is reported, and quorum accounting follows it', async () => {
    const { adapter, node, store, watchdog } = harness();
    // Three reads: the leadership check, the membership *before* the change (so the
    // node is known not to be a member yet), and the membership after it committed.
    store.read
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(persisted([1, 2, 3], [4]));

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({ changed: true });

    expect(node.addServer).toHaveBeenCalledWith('4', '127.0.0.1:7004', true);
    // A learner does not vote: adding one must not change the majority.
    expect(watchdog.size).toBe(3);
  });

  it('AC 34.65 — raft refusing the change rolls the registration back', async () => {
    const { adapter, node, transport } = harness();
    node.addServer.mockResolvedValue(false);

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'rejected',
    });
    expect(transport.removePeer).toHaveBeenCalledWith('4');
  });

  it('AC 34.66 — a node that was already a member keeps its registration when raft refuses', async () => {
    const { adapter, node, transport, store } = harness();
    store.read.mockResolvedValue(persisted([1, 2, 3], [4]));
    node.addServer.mockResolvedValue(false);

    await expect(adapter.addServer(4, '127.0.0.1:7004')).resolves.toEqual({
      changed: false,
      reason: 'rejected',
    });
    // Unregistering here would disconnect a member the configuration still names.
    expect(transport.removePeer).not.toHaveBeenCalled();
  });

  it('AC 34.67 — an id that cannot be a member is refused', async () => {
    const { adapter, node } = harness();

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(adapter.addServer(bad, '127.0.0.1:7004')).resolves.toEqual({
        changed: false,
        reason: 'unsupported',
      });
    }
    expect(node.addServer).not.toHaveBeenCalled();
  });

  it('AC 34.68 — promoteServer answers not-started, not-leader and unsupported ids', async () => {
    const notStarted = harness();
    (notStarted.adapter as any).node = null;
    await expect(notStarted.adapter.promoteServer(4)).resolves.toEqual({ changed: false, reason: 'not-started' });

    const follower = harness();
    follower.node.isLeader.mockResolvedValue(false);
    await expect(follower.adapter.promoteServer(4)).resolves.toEqual({ changed: false, reason: 'not-leader' });

    const nonsensical = harness();
    await expect(nonsensical.adapter.promoteServer(0)).resolves.toEqual({ changed: false, reason: 'unsupported' });
    expect(nonsensical.node.promoteServer).not.toHaveBeenCalled();
  });

  it('AC 34.69 — promoteServer reports refusal, and a promotion moves the majority', async () => {
    const refused = harness();
    refused.node.promoteServer.mockResolvedValue(false);
    await expect(refused.adapter.promoteServer(4)).resolves.toEqual({ changed: false, reason: 'rejected' });

    const promoted = harness();
    // Before the promotion three voters exist (a majority of two, which this node
    // has); after it there are four.
    promoted.store.read.mockResolvedValueOnce(persisted([1, 2, 3], [4])).mockResolvedValue(persisted([1, 2, 3, 4]));
    await expect(promoted.adapter.promoteServer(4)).resolves.toEqual({ changed: true });
    expect(promoted.node.promoteServer).toHaveBeenCalledWith('4');
    expect(promoted.watchdog.majority).toBe(3);
  });

  it('AC 34.89 — a refused membership change leaves nothing behind that this adapter reports', async () => {
    // raft-core appends a *single-step* configuration: the new voter set is in force
    // for the commit that admits it, so a promotion needs the existing voters to
    // answer. When they cannot, the library reports the change as uncommitted — and
    // the entry it appended may still be its in-memory active configuration. Nothing
    // this package reports may follow that uncommitted view: `getMembership()` reads
    // the committed configuration, and the watchdog's majority stays the one raft can
    // actually commit with. The single-step requirement is therefore visible to a
    // caller as "rejected", never as a cluster that grew.
    const refused = harness();
    refused.store.read.mockResolvedValue(persisted([{ id: '1' }, { id: '2' }, { id: '3' }]));
    refused.node.promoteServer.mockResolvedValue(false);

    const before = await refused.adapter.getMembership();
    await expect(refused.adapter.promoteServer(4)).resolves.toEqual({ changed: false, reason: 'rejected' });

    const after = await refused.adapter.getMembership();
    expect(after).toEqual(before);
    expect(after.voters).toEqual([1, 2, 3]);
    // Three voters, two answers: the majority raft can commit with, not the four-voter
    // majority the refused entry would have created.
    expect(refused.watchdog.majority).toBe(2);
    expect(refused.watchdog.size).toBe(3);
  });

  it('AC 34.90 — checkQuorum: false answers leadership from the role, and reads no configuration', async () => {
    // Accounting off is a decision with a cost attached: the adapter must not pay for
    // a configuration read on every routing call to compute an answer it was told not
    // to compute. The store is the observable: a read here would be work nobody asked
    // for, once per `isLeader()`.
    const off = harness({ checkQuorum: false });
    (off.adapter as any).watchdog = null;
    off.store.read.mockClear();

    await expect(off.adapter.isLeader()).resolves.toBe(true);
    expect(off.store.read).not.toHaveBeenCalled();
    expect(off.adapter.getQuorumHealth()).toBeNull();
  });

  it('AC 34.70 — removeServer answers not-started, not-leader and unsupported ids', async () => {
    const notStarted = harness();
    (notStarted.adapter as any).node = null;
    await expect(notStarted.adapter.removeServer(4)).resolves.toEqual({ changed: false, reason: 'not-started' });

    const follower = harness();
    follower.node.isLeader.mockResolvedValue(false);
    await expect(follower.adapter.removeServer(4)).resolves.toEqual({ changed: false, reason: 'not-leader' });

    const nonsensical = harness();
    await expect(nonsensical.adapter.removeServer(-2)).resolves.toEqual({ changed: false, reason: 'unsupported' });
    expect(nonsensical.node.removeServer).not.toHaveBeenCalled();
  });

  it('AC 34.71 — removeServer reports refusal, and a removal returns the old majority', async () => {
    const refused = harness();
    refused.node.removeServer.mockResolvedValue(false);
    await expect(refused.adapter.removeServer(4)).resolves.toEqual({ changed: false, reason: 'rejected' });

    const removed = harness();
    removed.store.read.mockResolvedValueOnce(persisted([1, 2, 3])).mockResolvedValue(persisted([1, 2, 4]));
    await expect(removed.adapter.removeServer(3)).resolves.toEqual({ changed: true });
    expect(removed.node.removeServer).toHaveBeenCalledWith('3');
    // Three voters, so two answers are a majority again.
    expect(removed.watchdog.majority).toBe(2);
  });
});
