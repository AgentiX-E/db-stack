/**
 * AntiEntropy — Merkle reconciliation computed so that two nodes can compare
 * answers.
 *
 * Why the bucket rule exists
 * --------------------------
 * A Merkle tree is a reconciliation instrument only if both sides cut the key
 * space the same way. The previous implementation split every node at the
 * midpoint of *the entries it happened to hold*, so two nodes holding different
 * data produced different leaf boundaries — and two different boundaries cannot
 * be compared, bucket by bucket or otherwise. Every "root" was a number that
 * described one node to itself, which is why the component could be constructed
 * and started and still reconcile nothing: its own `syncWith` compared the local
 * dataset with the local dataset and reported success.
 *
 * Here the cut is a function of the key alone. The first `merkleDepth` bits of
 * `SHA-256(key)` name the bucket, so bucket `0110` on one node covers exactly the
 * keys bucket `0110` covers on another — whether the two agree about the values
 * or not. An empty bucket hashes to one shared constant, so "both sides hold
 * nothing here" reads as agreement rather than as a difference.
 *
 * What this class is, and is not
 * ------------------------------
 * It is the algorithm: digest, diff, apply. It is not the transport. A peer is
 * registered through {@link AntiEntropy.bindPeer} and reached through
 * {@link MerklePeer}; the frame that carries a digest over a socket is
 * `AntiEntropyProtocol`'s job, so this file has no opinion about TLS, peers or
 * retries — and can be exercised against an in-memory peer without pretending a
 * network exists.
 *
 * AC 43.4 — divergence after a partition is detected by comparing digests
 * AC 43.5 — conflicts are resolved deterministically by the ConflictResolver
 */

import { createHash } from 'crypto';
import type {
  IAntiEntropy,
  AntiEntropyConfig,
  SyncResult,
  DatasetDigest,
  DigestLeaf,
} from '../interfaces/replication/IAntiEntropy';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { makeHLC } from '../hlc/HLC';
import { ConflictResolver, type ConflictValue } from './ConflictResolver';

// ── Types ──

export interface MerkleNode {
  /** SHA-256 over this node's subtree. */
  hash: string;
  /**
   * The key space this node covers, as a binary prefix of `SHA-256(key)`.
   *
   * Empty at the root, one bit longer per level. This — not `rangeStart` — is
   * what makes two nodes' nodes comparable: it is derived from the hash of the
   * keys, so it does not depend on which keys a node actually holds.
   */
  prefix: string;
  /** Smallest key stored under this node; empty when it holds nothing. */
  rangeStart: string;
  /** Largest key stored under this node; empty when it holds nothing. */
  rangeEnd: string;
  /** Entries stored under this node. */
  count: number;
  left: MerkleNode | null;
  leftDepth: number;
  right: MerkleNode | null;
  rightDepth: number;
}

export interface DataEntry {
  key: string;
  value: string;
  hlc: { wallTime: number; logical: number; nodeId: string };
  nodeId: string;
}

/** Where an applied value came from, so the receiver keeps the winning clock. */
export interface ApplyOrigin {
  hlc: DataEntry['hlc'];
  nodeId: string;
}

export interface DataProvider {
  /** Get all entries in a range [start, end] for building Merkle tree */
  getRange(start: string, end: string): Promise<DataEntry[]>;
  /** Get entries after a given key (for delta sync) */
  getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]>;
  /**
   * Apply a resolved conflict value to local storage.
   *
   * `origin` carries the clock of the entry that won. Without it the store
   * invents a fresh timestamp on every apply, so the value it writes is always
   * "newer" than the one it came from and the next sweep schedules the same
   * transfer again — a reconciliation loop that converges on nothing. Optional
   * so a provider that only stores values still compiles; a provider that drops
   * it simply reports every sweep as divergent.
   */
  apply(key: string, value: string, origin?: ApplyOrigin): Promise<void>;
  /** Get a single entry by key */
  get(key: string): Promise<DataEntry | null>;
}

/**
 * One peer, reachable the way `AntiEntropy` needs it.
 *
 * Implemented over a transport by `AntiEntropyProtocol` and over a `Map` by the
 * tests. The two calls map one-to-one onto the two frames of the protocol: a
 * digest goes out and the peer's digest comes back, then entries are handed over
 * one bucket at a time.
 */
export interface MerklePeer {
  /**
   * Hand this peer a digest and return its answer, or `null` when it could not
   * be reached.
   *
   * One round trip, both directions of divergence: the reply carries the peer's
   * digest *and* the buckets it wants pushed, so a sweep is three frames rather
   * than four.
   */
  exchange(shardId: string, mine: DatasetDigest): Promise<DigestExchange | null>;
  /** Hand this peer the entries of one bucket. */
  push(shardId: string, prefix: string, entries: DataEntry[]): Promise<boolean>;
}

/** What a peer answered to a digest. */
export interface DigestExchange {
  digest: DatasetDigest;
  /** Buckets the peer holds nothing in and wants pushed to it. */
  want: string[];
}

// ── Constants ──

/**
 * The hash of a bucket holding nothing.
 *
 * One constant for every bucket and every node, deliberately: if an empty bucket
 * hashed to something that depended on its prefix, two nodes that both hold
 * nothing would disagree about every empty bucket in the key space.
 */
const EMPTY_BUCKET_HASH = createHash('sha256').update('db-stack/antientropy/empty-bucket').digest('hex');

/** Deepest tree this side will build. 2^8 buckets is the largest digest a frame should carry. */
const MAX_DEPTH = 8;

// ── Helpers ──

/**
 * The bucket a key belongs to, as a binary prefix of its SHA-256.
 *
 * Bits rather than hex digits because a binary split is what the tree's
 * left/right shape already is: one level takes one bit, so the tree and the
 * bucket name are the same object.
 */
export function bucketPrefix(key: string, depth: number): string {
  const hex = createHash('sha256').update(key).digest('hex');
  let bits = '';
  for (let i = 0; i < depth; i += 1) {
    const nibble = Number.parseInt(hex[i >> 2] ?? '0', 16);
    bits += (nibble >> (3 - (i & 3))) & 1 ? '1' : '0';
  }
  return bits;
}

function toIHLCTimestamp(hlc: DataEntry['hlc']): IHLCTimestamp {
  return makeHLC(BigInt(hlc.wallTime), hlc.logical, hlc.nodeId);
}

/** The smaller of two keys, treating the empty string as "this subtree is empty". */
function lowest(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return a.localeCompare(b) <= 0 ? a : b;
}

/** The larger of two keys, treating the empty string as "this subtree is empty". */
function highest(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

// ── AntiEntropy ──

export class AntiEntropy implements IAntiEntropy {
  private readonly config: AntiEntropyConfig;
  private readonly conflictResolver: ConflictResolver;
  private readonly dataProvider: DataProvider;
  private readonly peers = new Map<string, MerklePeer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private _lastError: string | null = null;

  /** Peers we've synced with (for comparison in tests) */
  private readonly syncHistory: SyncResult[] = [];

  constructor(config: AntiEntropyConfig, dataProvider: DataProvider, conflictResolver?: ConflictResolver) {
    this.config = { ...config, merkleDepth: Math.max(1, Math.min(MAX_DEPTH, Math.floor(config.merkleDepth))) };
    this.dataProvider = dataProvider;
    this.conflictResolver = conflictResolver ?? new ConflictResolver(config.nodeId);
  }

  /**
   * Register the peer this side may reconcile against.
   *
   * Explicit, and separate from construction, because the peer needs the
   * transport and the transport needs this node's identity: wiring both in one
   * constructor leaves a cycle that has to be broken by a nullable field anyway.
   * Returns an unbind function so a peer that leaves the topology stops being
   * swept.
   */
  bindPeer(peerId: string, peer: MerklePeer): () => void {
    this.peers.set(peerId, peer);
    return () => {
      if (this.peers.get(peerId) === peer) this.peers.delete(peerId);
    };
  }

  /** Peers currently bound, in registration order. */
  getPeers(): string[] {
    return [...this.peers.keys()];
  }

  /**
   * Run the sweep on a timer.
   *
   * `AntiEntropyProtocol` normally owns the schedule, because it is the component
   * that also knows when a peer became reachable; this entry point exists for a
   * caller that holds an `AntiEntropy` with bound peers and nothing else.
   */
  async start(config?: AntiEntropyConfig): Promise<void> {
    if (this.running) return;
    const cfg = config ?? this.config;
    this.running = true;

    this.timer = setInterval(() => {
      // Recorded, not swallowed: a sweep that fails every tick is the one
      // symptom an operator needs to see, and `catch(() => {})` was how it
      // stayed invisible.
      void this.syncAll().catch((err: unknown) => {
        this._lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      });
    }, cfg.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Why the most recent sweep failed, or null. */
  getLastError(): string | null {
    return this._lastError;
  }

  /**
   * Build the Merkle tree over the local dataset.
   *
   * Leaves are the `2^merkleDepth` buckets of the key space, whether or not they
   * hold anything: a tree that only materialised occupied buckets would have a
   * different shape on each node and could not be walked in step with a peer.
   */
  async buildMerkleTree(): Promise<MerkleNode> {
    const entries = await this.dataProvider.getRange('', '\uffff');
    const depth = this.config.merkleDepth;

    if (entries.length === 0) {
      // The one place a range of the whole space is reported as such: there is no
      // smallest or largest key, and inventing one would make an empty node look
      // like it held `'\uffff'`.
      return {
        hash: this.hashEmptyTree(depth),
        prefix: '',
        rangeStart: '',
        rangeEnd: '\uffff',
        count: 0,
        left: null,
        leftDepth: 0,
        right: null,
        rightDepth: 0,
      };
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    const buckets = new Map<string, DataEntry[]>();
    for (const entry of entries) {
      const prefix = bucketPrefix(entry.key, depth);
      const bucket = buckets.get(prefix);
      if (bucket) bucket.push(entry);
      else buckets.set(prefix, [entry]);
    }

    return this.buildTree('', depth, buckets);
  }

  /**
   * Hash of an empty dataset at this depth.
   *
   * Derived from the tree rather than hard-coded, so it keeps agreeing with
   * `buildMerkleTree` when the depth changes: it is the root of a tree whose
   * every leaf is the empty-bucket constant.
   */
  private hashEmptyTree(depth: number): string {
    return this.reduceRoot(new Array<string>(2 ** depth).fill(EMPTY_BUCKET_HASH));
  }

  private buildTree(prefix: string, remaining: number, buckets: Map<string, DataEntry[]>): MerkleNode {
    if (remaining === 0) {
      const entries = buckets.get(prefix) ?? [];
      return {
        hash: this.hashEntries(prefix, entries),
        prefix,
        rangeStart: entries.length > 0 ? entries[0]!.key : '',
        rangeEnd: entries.length > 0 ? entries[entries.length - 1]!.key : '',
        count: entries.length,
        left: null,
        leftDepth: 0,
        right: null,
        rightDepth: 0,
      };
    }

    const left = this.buildTree(`${prefix}0`, remaining - 1, buckets);
    const right = this.buildTree(`${prefix}1`, remaining - 1, buckets);

    return {
      hash: createHash('sha256')
        .update(left.hash + right.hash)
        .digest('hex'),
      prefix,
      // The subtree's real key range, kept for operators. It is the *minimum* of
      // the two children, not the left child's minimum: bucket order is the order
      // of the key hashes, so a smaller key can live in the right child. Taking
      // the left child's value would publish a range that starts in the middle of
      // the subtree it describes.
      rangeStart: lowest(left.rangeStart, right.rangeStart),
      rangeEnd: highest(left.rangeEnd, right.rangeEnd),
      count: left.count + right.count,
      left,
      leftDepth: remaining - 1,
      right,
      rightDepth: remaining - 1,
    };
  }

  /**
   * Compute SHA-256 of a bucket's contents.
   *
   * The prefix leads the hash so that the same entry set cannot be reported as
   * agreement when it moved: without it, a value that left bucket `01` for `10`
   * would leave both buckets' contents looking equal to a peer's.
   *
   * The key and the value, and nothing else. The clock is deliberately not hashed,
   * because a digest that included it could never report agreement between two
   * replicas that hold the same data: every node stamps its own clock, so the same
   * value written through two paths — a local write here, an adopted change there,
   * a bootstrap that kept the origin's clock — produces two different hashes for
   * one fact. `applyRemote` already treats "same value, different clock" as
   * agreement and skips it, so a clock-sensitive digest made the two halves of the
   * protocol disagree: the sweep reported a divergent bucket for ever and the
   * repair refused to change it, burning the whole keyspace every interval on a
   * divergence that did not exist.
   *
   * The clock is still what settles a conflict, and a conflict is a difference in
   * the *value* — which is what this hash sees.
   */
  private hashEntries(prefix: string, entries: DataEntry[]): string {
    if (entries.length === 0) return EMPTY_BUCKET_HASH;
    const hasher = createHash('sha256');
    hasher.update(prefix);
    for (const entry of entries) {
      hasher.update(entry.key);
      hasher.update(entry.value);
    }
    return hasher.digest('hex');
  }

  /**
   * The digest a peer is sent.
   *
   * Every bucket is listed, empty ones included, and there are always
   * `2^merkleDepth` of them. A digest that named only its occupied buckets would
   * force the receiver to infer "absent means empty", which is indistinguishable
   * from "absent means the sender is an older build that did not include it" —
   * and an empty dataset would produce a single leaf whose prefix is the empty
   * string, which no peer with real buckets can line up with anything.
   *
   * The root is reduced from the same leaf hashes the tree reduces, so a digest's
   * root and `buildMerkleTree().hash` are the same number by construction rather
   * than by two implementations agreeing.
   */
  async buildDigest(shardId = 'default'): Promise<DatasetDigest> {
    const depth = this.config.merkleDepth;
    const entries = await this.dataProvider.getRange('', '\uffff');

    const buckets = new Map<string, DataEntry[]>();
    for (const entry of entries) {
      const prefix = bucketPrefix(entry.key, depth);
      const bucket = buckets.get(prefix);
      if (bucket) bucket.push(entry);
      else buckets.set(prefix, [entry]);
    }

    const leaves: DigestLeaf[] = [];
    for (let index = 0; index < 2 ** depth; index += 1) {
      const prefix = index.toString(2).padStart(depth, '0');
      const bucket = buckets.get(prefix) ?? [];
      leaves.push({ prefix, hash: this.hashEntries(prefix, bucket), count: bucket.length });
    }

    return {
      shardId,
      depth,
      root: this.reduceRoot(leaves.map((leaf) => leaf.hash)),
      total: entries.length,
      leaves,
    };
  }

  /** Reduce leaf hashes to a root, left to right, the way the tree's parents do. */
  private reduceRoot(hashes: string[]): string {
    let level = hashes;
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(
          createHash('sha256')
            .update(level[i]! + level[i + 1]!)
            .digest('hex'),
        );
      }
      level = next;
    }
    return level[0]!;
  }

  /**
   * Buckets where each side holds something the other cannot have.
   *
   * "Cannot have" is `hash differs`, not `count differs`: a peer holding the same
   * number of entries with different values needs a push exactly as much as one
   * holding nothing. A bucket this side holds nothing in is never pushed — there
   * is nothing to send, and the peer's own `want` covers the other direction.
   */
  diff(mine: DatasetDigest, theirs: DatasetDigest): { push: string[]; want: string[] } {
    const theirLeaves = new Map(theirs.leaves.map((leaf) => [leaf.prefix, leaf]));
    const push: string[] = [];
    const want: string[] = [];

    for (const leaf of mine.leaves) {
      const other = theirLeaves.get(leaf.prefix);
      // A bucket the peer did not mention is a difference, not an absence: it can
      // only be missing from a digest built at a different depth, and treating
      // that as agreement would read as "nothing to do" on a comparison that never
      // happened.
      if (!other) {
        if (leaf.count > 0) push.push(leaf.prefix);
        continue;
      }
      if (other.hash === leaf.hash) continue;
      if (leaf.count > 0) push.push(leaf.prefix);
      if (other.count > 0) want.push(leaf.prefix);
    }

    return { push, want };
  }

  /** Entries this node holds in one bucket. */
  async entriesInBucket(prefix: string): Promise<DataEntry[]> {
    const entries = await this.dataProvider.getRange('', '\uffff');
    const depth = this.config.merkleDepth;
    return entries
      .filter((entry) => bucketPrefix(entry.key, depth) === prefix)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Every entry this node holds, in key order.
   *
   * The material of a bootstrap snapshot. Sorted because the chunk index is the
   * resume cursor: a snapshot that reshuffled between chunks would make "I have
   * chunks 0..k" mean a different set of keys than the sender's.
   */
  async snapshotEntries(): Promise<DataEntry[]> {
    const entries = await this.dataProvider.getRange('', '\uffff');
    return [...entries].sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Apply entries a peer pushed.
   *
   * Every branch changes the outcome, and every outcome is counted, because the
   * three cases are not interchangeable to an operator: `applied` means this node
   * learned a value, `conflicts` means two clocks disagreed and one lost, and
   * `skipped` means the push carried nothing new — which, if it happens on every
   * sweep for the same bucket, is the signal that the two sides cannot converge.
   */
  async applyRemote(entries: DataEntry[]): Promise<{ applied: number; skipped: number; conflicts: number }> {
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const entry of entries) {
      const existing = await this.dataProvider.get(entry.key);
      if (!existing) {
        await this.dataProvider.apply(entry.key, entry.value, { hlc: entry.hlc, nodeId: entry.nodeId });
        applied += 1;
        continue;
      }

      const local: ConflictValue = {
        key: entry.key,
        value: existing.value,
        hlc: toIHLCTimestamp(existing.hlc),
        nodeId: existing.nodeId,
      };
      const remote: ConflictValue = {
        key: entry.key,
        value: entry.value,
        hlc: toIHLCTimestamp(entry.hlc),
        nodeId: entry.nodeId,
      };

      if (local.value === remote.value) {
        // Same value, possibly from a different clock. Not a conflict: writing it
        // again would move the local clock forward for no change, and the next
        // sweep would then see this node as the divergent one.
        skipped += 1;
        continue;
      }

      const resolution = await this.conflictResolver.resolve(entry.key, local, remote, 'lww');
      if (resolution.resolvedValue === remote.value) {
        await this.dataProvider.apply(entry.key, entry.value, { hlc: entry.hlc, nodeId: entry.nodeId });
        conflicts += 1;
      } else {
        skipped += 1;
      }
    }

    return { applied, skipped, conflicts };
  }

  /**
   * Reconcile against one peer.
   *
   * Throws when the peer was never bound. The previous implementation returned a
   * well-formed `SyncResult` for any string, because it compared the local
   * dataset with itself — a caller could not tell a completed reconciliation from
   * a typo.
   */
  async syncWith(peerNodeId: string, shardId = 'default'): Promise<SyncResult> {
    const startTime = Date.now();
    const peer = this.peers.get(peerNodeId);
    if (!peer) {
      throw new Error(
        `no peer bound as ${peerNodeId}: bind one with bindPeer() before sweeping ` +
          `(bound: ${this.getPeers().join(', ') || 'none'})`,
      );
    }

    const result: SyncResult = {
      nodeId: peerNodeId,
      entriesSynced: 0,
      entriesSkipped: 0,
      conflictsResolved: 0,
      pushed: 0,
      peerReachable: false,
      durationMs: 0,
      completedAt: 0,
    };

    const mine = await this.buildDigest(shardId);
    const exchange = await peer.exchange(shardId, mine);
    if (exchange === null) {
      // Unreachable is not an error the caller must handle as a rejection: the
      // sweep is periodic, and a peer that is down will be swept again. It is
      // reported, because "reconciled nothing" and "reconciled everything" must
      // not share a result shape.
      result.durationMs = Date.now() - startTime;
      result.completedAt = Date.now();
      this.syncHistory.push(result);
      return result;
    }

    result.peerReachable = true;
    const { push } = this.diff(mine, exchange.digest);

    for (const prefix of push) {
      const entries = await this.entriesInBucket(prefix);
      if (entries.length === 0) continue;
      const delivered = await peer.push(shardId, prefix, entries);
      if (delivered) result.pushed += entries.length;
    }

    result.durationMs = Date.now() - startTime;
    result.completedAt = Date.now();
    this.syncHistory.push(result);
    return result;
  }

  /**
   * Reconcile against every bound peer.
   *
   * One peer's failure does not cancel the rest: a datacenter that is down must
   * not stop this node from converging with the ones that are up.
   */
  async syncAll(shardId = 'default'): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const peerId of this.getPeers()) {
      try {
        results.push(await this.syncWith(peerId, shardId));
      } catch (err: unknown) {
        this._lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }
    return results;
  }

  /**
   * Get the Merkle tree root hash for a shard.
   */
  async getMerkleRoot(shardId: string): Promise<string> {
    return (await this.buildDigest(shardId)).root;
  }

  /**
   * Walk the Merkle tree and return the key ranges of its occupied leaves.
   *
   * Empty buckets contribute nothing: they are all the same hash, so listing them
   * is listing the same fact `2^depth` times. An empty dataset returns the whole
   * key space, because that is the range a caller has to scan to learn there is
   * nothing.
   */
  async findDiffRanges(node: MerkleNode): Promise<Array<{ start: string; end: string }>> {
    const ranges: Array<{ start: string; end: string }> = [];

    const walk = (n: MerkleNode): void => {
      if (!n.left && !n.right) {
        if (n.count > 0) ranges.push({ start: n.rangeStart, end: n.rangeEnd });
        return;
      }
      if (n.left) walk(n.left);
      if (n.right) walk(n.right);
    };

    walk(node);
    if (ranges.length === 0) return [{ start: '', end: '\uffff' }];
    return ranges;
  }

  /**
   * Get sync history for test assertions.
   */
  getSyncHistory(): SyncResult[] {
    return [...this.syncHistory];
  }
}
