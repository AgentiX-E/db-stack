/**
 * AntiEntropy tests — AC 43.4, 43.5, 45.6
 *
 * AC 43.4 — anti-entropy detects divergence after a partition
 * AC 43.5 — anti-entropy resolves conflicts deterministically
 * AC 45.6 — the sweep runs on a configurable interval
 *
 * What changed, and why the old assertions had to change
 * -----------------------------------------------------
 * The previous suite called `syncWith('peer-1')` and asserted a well-formed
 * result. It got one, because the implementation compared the local dataset with
 * the local dataset: every assertion would also have passed against an
 * implementation that did nothing at all, and one of them — "detects new entries
 * after divergence" — was satisfied by counting entries it had just read back
 * from itself.
 *
 * These tests pair two real `AntiEntropy` instances over an in-memory link. The
 * link is a `MerklePeer`, the same interface `AntiEntropyProtocol` implements
 * over TLS, so what is exercised here is the algorithm and not a stand-in for the
 * transport.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AntiEntropy, bucketPrefix, type DataEntry, type DataProvider, type MerklePeer } from './AntiEntropy';
import { ConflictResolver } from './ConflictResolver';

// ── Fixtures ──

/** In-memory data provider that keeps the clock it was given. */
class InMemoryDataProvider implements DataProvider {
  private readonly data = new Map<string, DataEntry>();

  set(key: string, entry: DataEntry): void {
    this.data.set(key, entry);
  }

  async getRange(start: string, end: string): Promise<DataEntry[]> {
    const results: DataEntry[] = [];
    for (const [key, entry] of this.data) {
      if (key >= start && key <= end) {
        results.push(entry);
      }
    }
    return results.sort((a, b) => a.key.localeCompare(b.key));
  }

  async getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]> {
    const sorted = Array.from(this.data.values()).sort((a, b) => a.key.localeCompare(b.key));
    const startIdx = sorted.findIndex((e) => e.key > afterKey);
    if (startIdx < 0) return [];
    return sorted.slice(startIdx, startIdx + limit);
  }

  async apply(key: string, value: string, origin?: { hlc: DataEntry['hlc']; nodeId: string }): Promise<void> {
    const existing = this.data.get(key);
    this.data.set(key, {
      key,
      value,
      hlc: origin?.hlc ?? existing?.hlc ?? { wallTime: Date.now(), logical: 0, nodeId: 'local' },
      nodeId: origin?.nodeId ?? existing?.nodeId ?? 'local',
    });
  }

  async get(key: string): Promise<DataEntry | null> {
    return this.data.get(key) ?? null;
  }

  getAll(): DataEntry[] {
    return Array.from(this.data.values()).sort((a, b) => a.key.localeCompare(b.key));
  }
}

function makeEntry(key: string, value: string, wallTime: number, logical: number, nodeId: string): DataEntry {
  return {
    key,
    value,
    hlc: { wallTime, logical, nodeId },
    nodeId,
  };
}

/**
 * Wire one instance to another the way the protocol does, in memory.
 *
 * `exchange` answers with the peer's digest and, in the same breath, pushes what
 * the peer holds and the caller does not — the same shape `AntiEntropyProtocol`
 * produces, minus the socket. `push` applies what the caller holds and the peer
 * does not.
 */
function link(subject: AntiEntropy, peer: AntiEntropy, peerId: string): void {
  const peerSide: MerklePeer = {
    async exchange(shardId, mine) {
      const theirs = await peer.buildDigest(shardId);
      const { push, want } = peer.diff(theirs, mine);
      for (const prefix of push) {
        const entries = await peer.entriesInBucket(prefix);
        if (entries.length > 0) await subject.applyRemote(entries);
      }
      return { digest: theirs, want };
    },
    async push(_shardId, _prefix, entries) {
      await peer.applyRemote(entries);
      return true;
    },
  };
  subject.bindPeer(peerId, peerSide);
}

function makePair(depth = 4): {
  a: AntiEntropy;
  b: AntiEntropy;
  aStore: InMemoryDataProvider;
  bStore: InMemoryDataProvider;
} {
  const aStore = new InMemoryDataProvider();
  const bStore = new InMemoryDataProvider();
  const a = new AntiEntropy(
    { nodeId: 'n1', intervalMs: 30_000, merkleDepth: depth },
    aStore,
    new ConflictResolver('n1'),
  );
  const b = new AntiEntropy(
    { nodeId: 'n2', intervalMs: 30_000, merkleDepth: depth },
    bStore,
    new ConflictResolver('n2'),
  );
  link(a, b, 'n2');
  link(b, a, 'n1');
  return { a, b, aStore, bStore };
}

// ── Merkle construction ──

describe('AntiEntropy — Merkle tree construction', () => {
  it('builds a valid tree from data', async () => {
    const provider = new InMemoryDataProvider();
    provider.set('a', makeEntry('a', 'val-a', 100, 1, 'n1'));
    provider.set('b', makeEntry('b', 'val-b', 200, 1, 'n2'));
    provider.set('c', makeEntry('c', 'val-c', 300, 1, 'n3'));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30_000, merkleDepth: 3 }, provider);
    const tree = await ae.buildMerkleTree();

    expect(tree.hash).toHaveLength(64);
    expect(tree.rangeStart).toBe('a');
    expect(tree.rangeEnd).toBe('c');
    expect(tree.count).toBe(3);
  });

  it('produces the same root for the same data', async () => {
    const { a, b, aStore, bStore } = makePair();
    aStore.set('x', makeEntry('x', 'v1', 100, 1, 'n1'));
    bStore.set('x', makeEntry('x', 'v1', 100, 1, 'n1'));

    expect(await a.getMerkleRoot('shard-0')).toBe(await b.getMerkleRoot('shard-0'));
  });

  it('produces a different root for different values', async () => {
    const { a, b, aStore, bStore } = makePair();
    aStore.set('x', makeEntry('x', 'v1', 100, 1, 'n1'));
    bStore.set('x', makeEntry('x', 'v2', 200, 1, 'n1'));

    expect(await a.getMerkleRoot('shard-0')).not.toBe(await b.getMerkleRoot('shard-0'));
  });

  it('cuts the key space the same way on both sides, whatever each holds', async () => {
    // The property the old implementation did not have: a key lands in the same
    // bucket on every node, so the two trees can be walked in step.
    const { a, b, aStore, bStore } = makePair(4);
    aStore.set('only-on-a', makeEntry('only-on-a', 'v', 1, 0, 'n1'));
    bStore.set('only-on-b', makeEntry('only-on-b', 'v', 1, 0, 'n2'));

    const digestA = await a.buildDigest();
    const digestB = await b.buildDigest();

    expect(digestA.depth).toBe(4);
    expect(digestB.leaves.map((leaf) => leaf.prefix)).toEqual(digestA.leaves.map((leaf) => leaf.prefix));

    // Keys present on exactly one side leave the empty buckets agreeing, which is
    // what makes "both sides hold nothing here" readable as agreement.
    const emptyAgreements = digestA.leaves.filter(
      (leaf) => leaf.count === 0 && digestB.leaves.find((other) => other.prefix === leaf.prefix)!.hash === leaf.hash,
    );
    expect(emptyAgreements.length).toBeGreaterThan(0);
  });

  it('handles empty data with a root of the right shape', async () => {
    const { a } = makePair(3);
    const tree = await a.buildMerkleTree();

    expect(tree.hash).toHaveLength(64);
    expect(tree.rangeStart).toBe('');
    expect(tree.rangeEnd).toBe('\uffff');
    expect(tree.count).toBe(0);
    expect(tree.left).toBeNull();
  });

  it('builds the full binary shape for a shallow tree', async () => {
    const provider = new InMemoryDataProvider();
    for (let i = 0; i < 10; i += 1) {
      const k = String.fromCharCode(97 + i);
      provider.set(k, makeEntry(k, `v${i}`, 100 + i, 1, 'n1'));
    }

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30_000, merkleDepth: 2 }, provider);
    const tree = await ae.buildMerkleTree();

    expect(tree.left).not.toBeNull();
    expect(tree.right).not.toBeNull();
    expect(tree.prefix).toBe('');
  });

  it('clamps a depth the tree cannot carry', async () => {
    const provider = new InMemoryDataProvider();
    provider.set('a', makeEntry('a', 'v', 1, 0, 'n1'));

    const tooDeep = new AntiEntropy({ nodeId: 'n1', intervalMs: 30_000, merkleDepth: 64 }, provider);
    const tooShallow = new AntiEntropy({ nodeId: 'n1', intervalMs: 30_000, merkleDepth: 0 }, provider);

    expect((await tooDeep.buildDigest()).depth).toBe(8);
    expect((await tooShallow.buildDigest()).depth).toBe(1);
  });
});

// ── Bucket naming ──

describe('AntiEntropy — bucket prefix', () => {
  it('names a bucket from the key alone', () => {
    expect(bucketPrefix('orders:1', 4)).toBe(bucketPrefix('orders:1', 4));
    expect(bucketPrefix('orders:1', 4)).toHaveLength(4);
    // A prefix is a prefix: the shorter name is the longer one's beginning.
    expect(bucketPrefix('orders:1', 8).startsWith(bucketPrefix('orders:1', 4))).toBe(true);
  });

  it('spreads different keys across different buckets', () => {
    const prefixes = new Set(Array.from({ length: 64 }, (_, i) => bucketPrefix(`key-${i}`, 6)));
    expect(prefixes.size).toBeGreaterThan(1);
  });
});

// ── findDiffRanges ──

describe('AntiEntropy — findDiffRanges', () => {
  it('returns the key ranges of the occupied leaves', async () => {
    const provider = new InMemoryDataProvider();
    provider.set('a', makeEntry('a', 'v1', 100, 1, 'n1'));
    provider.set('b', makeEntry('b', 'v2', 100, 1, 'n1'));
    provider.set('c', makeEntry('c', 'v3', 100, 1, 'n1'));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30_000, merkleDepth: 2 }, provider);
    const ranges = await ae.findDiffRanges(await ae.buildMerkleTree());

    expect(ranges.length).toBeGreaterThanOrEqual(1);
    for (const range of ranges) {
      expect(range.start).toBeTruthy();
      expect(range.end).toBeTruthy();
      expect(range.start.localeCompare(range.end)).toBeLessThanOrEqual(0);
    }
    const covered = ranges.flatMap((range) => [range.start, range.end]);
    expect(covered).toContain('a');
    expect(covered).toContain('c');
  });

  it('reports the whole key space for an empty tree', async () => {
    const { a } = makePair(2);
    const ranges = await a.findDiffRanges(await a.buildMerkleTree());

    expect(ranges).toEqual([{ start: '', end: '\uffff' }]);
  });
});

// ── AC 43.4 — divergence detection ──

describe('AntiEntropy — AC 43.4: divergence detection', () => {
  it('sends what the peer lacks and takes what it has, in one sweep', async () => {
    const { a, aStore, bStore } = makePair();
    aStore.set('a-key', makeEntry('a-key', 'from-a', 100, 1, 'n1'));
    bStore.set('b-key', makeEntry('b-key', 'from-b', 200, 1, 'n2'));

    const result = await a.syncWith('n2');

    expect(result.peerReachable).toBe(true);
    expect(result.pushed).toBe(1);
    // The peer pushed its key during the exchange, so this side learned it without
    // a second round trip.
    expect(
      aStore
        .getAll()
        .map((entry) => entry.key)
        .sort(),
    ).toEqual(['a-key', 'b-key']);
    expect(
      bStore
        .getAll()
        .map((entry) => entry.key)
        .sort(),
    ).toEqual(['a-key', 'b-key']);
  });

  it('reports an unreachable peer as unreachable rather than as agreement', async () => {
    const { a } = makePair();
    a.bindPeer('gone', {
      exchange: async () => null,
      push: async () => false,
    });

    const result = await a.syncWith('gone');

    expect(result.peerReachable).toBe(false);
    expect(result.pushed).toBe(0);
    expect(result.entriesSynced).toBe(0);
  });

  it('refuses to sweep a peer it was never given', async () => {
    const { a } = makePair();
    await expect(a.syncWith('nobody')).rejects.toThrow(/no peer bound as nobody/);
  });

  it('converges to equal roots', async () => {
    const { a, b, aStore, bStore } = makePair();
    for (let i = 0; i < 20; i += 1) {
      aStore.set(`k${i}`, makeEntry(`k${i}`, `a${i}`, 100 + i, 0, 'n1'));
    }
    for (let i = 10; i < 30; i += 1) {
      bStore.set(`k${i}`, makeEntry(`k${i}`, `b${i}`, 200 + i, 0, 'n2'));
    }

    await a.syncWith('n2');

    expect(await a.getMerkleRoot('default')).toBe(await b.getMerkleRoot('default'));
  });

  it('treats a digest it cannot line up as divergence, not as agreement', async () => {
    const { a, aStore } = makePair();
    aStore.set('k', makeEntry('k', 'v', 1, 0, 'n1'));

    a.bindPeer('odd-depth', {
      exchange: async (_shardId, mine) => ({
        digest: {
          ...mine,
          depth: 2,
          leaves: mine.leaves.map((leaf) => ({ ...leaf, prefix: leaf.prefix.slice(0, 2) })),
        },
        want: [],
      }),
      push: async () => true,
    });

    const result = await a.syncWith('odd-depth');
    expect(result.pushed).toBeGreaterThan(0);
  });
});

// ── AC 43.5 — deterministic resolution ──

describe('AntiEntropy — AC 43.5: deterministic conflict resolution', () => {
  it('keeps the newer clock and reports the conflict', async () => {
    const { a, aStore } = makePair();
    aStore.set('k1', makeEntry('k1', 'old', 100, 0, 'n1'));

    const outcome = await a.applyRemote([makeEntry('k1', 'new', 200, 0, 'n2')]);

    expect(outcome).toMatchObject({ applied: 0, conflicts: 1 });
    expect(aStore.getAll()[0]!.value).toBe('new');
    expect(aStore.getAll()[0]!.hlc.wallTime).toBe(200);
  });

  it('keeps the local value when the remote clock is older', async () => {
    const { a, aStore } = makePair();
    aStore.set('k1', makeEntry('k1', 'local', 300, 0, 'n1'));

    const outcome = await a.applyRemote([makeEntry('k1', 'stale', 100, 0, 'n2')]);

    expect(outcome).toMatchObject({ applied: 0, conflicts: 0, skipped: 1 });
    expect(aStore.getAll()[0]!.value).toBe('local');
  });

  it('does not call an identical value a conflict, whatever its clock', async () => {
    const { a, aStore } = makePair();
    aStore.set('k1', makeEntry('k1', 'same', 100, 0, 'n1'));

    const outcome = await a.applyRemote([makeEntry('k1', 'same', 900, 0, 'n2')]);

    expect(outcome).toMatchObject({ applied: 0, conflicts: 0, skipped: 1 });
    // The local clock is untouched: writing the same value forward would make this
    // node the divergent side on the next sweep.
    expect(aStore.getAll()[0]!.hlc.wallTime).toBe(100);
  });

  it('resolves the same way on both sides', async () => {
    const { a, b, aStore, bStore } = makePair();
    aStore.set('k', makeEntry('k', 'from-a', 100, 0, 'n1'));
    bStore.set('k', makeEntry('k', 'from-b', 200, 0, 'n2'));

    await a.syncWith('n2');
    await b.syncWith('n1');

    expect(await a.getMerkleRoot('default')).toBe(await b.getMerkleRoot('default'));
    expect(aStore.getAll()[0]!.value).toBe('from-b');
    expect(bStore.getAll()[0]!.value).toBe('from-b');
  });

  it('counts every outcome it can produce', async () => {
    const { a, aStore } = makePair();
    aStore.set('present', makeEntry('present', 'local', 100, 0, 'n1'));

    const outcome = await a.applyRemote([
      makeEntry('fresh', 'new', 100, 0, 'n2'),
      makeEntry('present', 'local', 100, 0, 'n2'),
      makeEntry('present', 'remote-wins', 200, 0, 'n2'),
    ]);

    expect(outcome.applied).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.conflicts).toBe(1);
  });
});

// ── Digests and buckets ──

describe('AntiEntropy — digests', () => {
  it('lists every bucket, empty ones included', async () => {
    const { a, aStore } = makePair(3);
    aStore.set('k', makeEntry('k', 'v', 1, 0, 'n1'));

    const digest = await a.buildDigest('shard-x');

    expect(digest.shardId).toBe('shard-x');
    expect(digest.leaves).toHaveLength(8);
    expect(digest.total).toBe(1);
    expect(digest.leaves.filter((leaf) => leaf.count === 0)).toHaveLength(7);
  });

  it('lists the entries of one bucket only', async () => {
    const { a, aStore } = makePair(4);
    aStore.set('k1', makeEntry('k1', 'v1', 1, 0, 'n1'));
    aStore.set('k2', makeEntry('k2', 'v2', 1, 0, 'n1'));

    const entries = await a.entriesInBucket(bucketPrefix('k1', 4));

    expect(entries.map((entry) => entry.key)).toEqual(['k1']);
  });

  it('returns the snapshot in key order', async () => {
    const { a, aStore } = makePair();
    aStore.set('c', makeEntry('c', 'v', 1, 0, 'n1'));
    aStore.set('a', makeEntry('a', 'v', 1, 0, 'n1'));
    aStore.set('b', makeEntry('b', 'v', 1, 0, 'n1'));

    expect((await a.snapshotEntries()).map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
  });

  it('names the buckets each side needs from the other', async () => {
    const { a, b, aStore, bStore } = makePair(4);
    aStore.set('a-only', makeEntry('a-only', 'v', 1, 0, 'n1'));
    bStore.set('b-only', makeEntry('b-only', 'v', 1, 0, 'n2'));

    const diff = a.diff(await a.buildDigest(), await b.buildDigest());

    expect(diff.push).toEqual([bucketPrefix('a-only', 4)]);
    expect(diff.want).toEqual([bucketPrefix('b-only', 4)]);
  });

  it('reports no difference for two identical datasets', async () => {
    const { a, b, aStore, bStore } = makePair();
    const entry = makeEntry('same', 'v', 1, 0, 'n1');
    aStore.set('same', entry);
    bStore.set('same', entry);

    const diff = a.diff(await a.buildDigest(), await b.buildDigest());

    expect(diff).toEqual({ push: [], want: [] });
    expect((await a.syncWith('n2')).pushed).toBe(0);
  });
});

// ── Lifecycle ──

describe('AntiEntropy — lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps every bound peer on its interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { a } = makePair();
    await a.start({ nodeId: 'n1', intervalMs: 1_000, merkleDepth: 4 });

    await vi.advanceTimersByTimeAsync(2_500);
    await a.stop();

    expect(a.getSyncHistory().length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on start and stops its timer', async () => {
    const { a } = makePair();
    await a.start({ nodeId: 'n1', intervalMs: 60_000, merkleDepth: 4 });
    const timer = a['timer'];
    await a.start();
    expect(a['timer']).toBe(timer);
    await a.stop();
    expect(a['timer']).toBeNull();
  });

  it('keeps sweeping the peers that are up when one is down', async () => {
    const { a, aStore } = makePair();
    aStore.set('k', makeEntry('k', 'v', 1, 0, 'n1'));
    a.bindPeer('broken', {
      exchange: async () => {
        throw new Error('link down');
      },
      push: async () => false,
    });

    const results = await a.syncAll();

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(a.getLastError()).toMatch(/link down/);
  });

  it('forgets a peer that is unbound', async () => {
    const { a } = makePair();
    expect(a.getPeers()).toContain('n2');

    const unbind = a.bindPeer('temporary', {
      exchange: async () => null,
      push: async () => false,
    });
    expect(a.getPeers()).toContain('temporary');

    unbind();
    expect(a.getPeers()).not.toContain('temporary');
    expect(a.getPeers()).toContain('n2');
  });

  it('does not let an old binding unbind the peer that replaced it', async () => {
    const { a } = makePair();
    const first = { exchange: async () => null, push: async () => false };
    const second = { exchange: async () => null, push: async () => false };

    const unbindFirst = a.bindPeer('n2', first);
    a.bindPeer('n2', second);

    // The entry now belongs to the second link. An unbind captured by the first
    // must not remove it — that is how a reconnect would silently stop a sweep.
    unbindFirst();
    expect(a.getPeers()).toContain('n2');
  });
});
