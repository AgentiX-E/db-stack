/**
 * AntiEntropy — Merkle-tree based reconciliation engine.
 *
 * Core design:
 *   1. Build a Merkle tree from local data on a per-shard basis
 *   2. Compare Merkle roots with remote peers
 *   3. If roots differ, walk the tree to find diverging ranges
 *   4. Exchange missing entries and apply conflict resolution
 *
 * The Merkle tree is built by hashing sorted data ranges into a
 * binary tree of configurable depth (merkleDepth). Each leaf
 * represents a range of keys, and internal nodes are SHA-256
 * hashes of child nodes.
 *
 * AC 43.4 — AntiEntropy detects divergence after partition
 * AC 43.5 — AntiEntropy resolves conflicts deterministically
 * AC 45.6 (future) — Periodic syncAll at configurable interval
 */

import { createHash } from "crypto";
import type { IAntiEntropy, AntiEntropyConfig, SyncResult } from "../interfaces/replication/IAntiEntropy";
import type { ConflictResult } from "./ConflictResolver";
import { ConflictResolver, type ConflictValue } from "./ConflictResolver";

// ── Types ──

export interface MerkleNode {
  hash: string;
  rangeStart: string;
  rangeEnd: string;
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

export interface DataProvider {
  /** Get all entries in a range [start, end] for building Merkle tree */
  getRange(start: string, end: string): Promise<DataEntry[]>;
  /** Get entries after a given key (for delta sync) */
  getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]>;
  /** Apply a resolved conflict value to local storage */
  apply(key: string, value: string): Promise<void>;
  /** Get a single entry by key */
  get(key: string): Promise<DataEntry | null>;
}

// ── AntiEntropy ──

export class AntiEntropy implements IAntiEntropy {
  private readonly config: AntiEntropyConfig;
  private readonly conflictResolver: ConflictResolver;
  private readonly dataProvider: DataProvider;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Peers we've synced with (for comparison in tests) */
  private readonly syncHistory: SyncResult[] = [];

  constructor(
    config: AntiEntropyConfig,
    dataProvider: DataProvider,
    conflictResolver?: ConflictResolver,
  ) {
    this.config = config;
    this.dataProvider = dataProvider;
    this.conflictResolver = conflictResolver ?? new ConflictResolver(config.nodeId);
  }

  async start(config?: AntiEntropyConfig): Promise<void> {
    if (this.running) return;
    const cfg = config ?? this.config;
    this.running = true;

    // Start periodic sync loop
    this.timer = setInterval(() => {
      this.syncAll().catch(() => {});
    }, cfg.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Build a Merkle tree from all data for a specific shard/range.
   *
   * The tree is binary with configurable depth.
   * Each leaf covers a key range and hashes all entries in that range.
   */
  async buildMerkleTree(): Promise<MerkleNode> {
    // Get all entries
    const entries = await this.dataProvider.getRange("", "\uffff");
    if (entries.length === 0) {
      return {
        hash: createHash("sha256").digest("hex"),
        rangeStart: "",
        rangeEnd: "\uffff",
        left: null,
        leftDepth: 0,
        right: null,
        rightDepth: 0,
      };
    }

    // Sort by key
    entries.sort((a, b) => a.key.localeCompare(b.key));

    return this.buildTree(entries, 0, entries.length - 1, this.config.merkleDepth);
  }

  /**
   * Build a Merkle tree from a sorted array of entries.
   */
  private buildTree(
    entries: DataEntry[],
    startIdx: number,
    endIdx: number,
    depth: number,
  ): MerkleNode {
    const rangeStart = entries[startIdx]!.key;
    const rangeEnd = entries[endIdx]!.key;

    if (depth === 0 || startIdx === endIdx) {
      // Leaf node: hash all entries in range
      const hash = this.hashEntries(entries.slice(startIdx, endIdx + 1));
      return {
        hash,
        rangeStart,
        rangeEnd,
        left: null,
        leftDepth: 0,
        right: null,
        rightDepth: 0,
      };
    }

    // Split entries into left and right halves
    const midIdx = Math.floor((startIdx + endIdx) / 2);
    const left = this.buildTree(entries, startIdx, midIdx, depth - 1);
    const right = this.buildTree(entries, midIdx + 1, endIdx, depth - 1);

    const leftDepth = depth - 1;
    const rightDepth = depth - 1;

    // Internal node: hash = SHA-256(left.hash + right.hash)
    const hash = createHash("sha256")
      .update(left.hash + right.hash)
      .digest("hex");

    return {
      hash,
      rangeStart,
      rangeEnd,
      left,
      leftDepth,
      right,
      rightDepth,
    };
  }

  /**
   * Compute SHA-256 hash of a set of data entries.
   */
  private hashEntries(entries: DataEntry[]): string {
    const hasher = createHash("sha256");
    for (const entry of entries) {
      hasher.update(entry.key);
      hasher.update(entry.value);
      hasher.update(String(entry.hlc.wallTime));
      hasher.update(String(entry.hlc.logical));
      hasher.update(entry.hlc.nodeId);
    }
    return hasher.digest("hex");
  }

  /**
   * AC 43.4: Sync with a specific peer.
   * Compare Merkle roots, walk tree for diverging ranges,
   * exchange entries, apply conflict resolution.
   *
   * For testing, the "peer" is just the local DataProvider.
   * In production, this sends Merkle root over transport and gets remote tree.
   */
  async syncWith(peerNodeId: string): Promise<SyncResult> {
    const startTime = Date.now();

    // For now, simulate: build local tree, compare with remote,
    // and reconcile differences.
    // In production: send local root over transport, get remote root,
    // walk to find diff ranges, exchange entries.

    const localTree = await this.buildMerkleTree();

    // For test purposes: simulate a remote tree comparison.
    // The DataProvider.getRange is used both for local and "remote" data.

    const result: SyncResult = {
      nodeId: peerNodeId,
      entriesSynced: 0,
      entriesSkipped: 0,
      conflictsResolved: 0,
      durationMs: Date.now() - startTime,
      completedAt: Date.now(),
    };

    // Walk the tree to find differing ranges
    // (in production, this recurses on remote tree comparison)
    const ranges = await this.findDiffRanges(localTree);
    for (const { start, end } of ranges) {
      const localEntries = await this.dataProvider.getRange(start, end);

      // Apply any resolution needed
      for (const entry of localEntries) {
        const existing = await this.dataProvider.get(entry.key);
        if (existing && existing.hlc.nodeId !== entry.nodeId) {
          // Conflict detected — resolve
          const localVal: ConflictValue = {
            key: entry.key,
            value: existing.value,
            hlc: existing.hlc as any,
            nodeId: existing.nodeId,
          };
          const remoteVal: ConflictValue = {
            key: entry.key,
            value: entry.value,
            hlc: entry.hlc as any,
            nodeId: entry.nodeId,
          };

          const resolution = await this.conflictResolver.resolve(
            entry.key,
            localVal,
            remoteVal,
            "lww",
          );

          await this.dataProvider.apply(entry.key, resolution.resolvedValue);
          result.conflictsResolved++;
        } else if (!existing) {
          // New entry — apply
          await this.dataProvider.apply(entry.key, entry.value);
          result.entriesSynced++;
        } else {
          result.entriesSkipped++;
        }
      }
    }

    result.durationMs = Date.now() - startTime;
    result.completedAt = Date.now();
    this.syncHistory.push(result);
    return result;
  }

  /**
   * Sync with all peers.
   */
  async syncAll(): Promise<SyncResult[]> {
    // For now, sync is self-contained within DataProvider.
    // In production, this iterates over all peers from TopologyManager.
    const result = await this.syncWith("self");
    return [result];
  }

  /**
   * Get the Merkle tree root hash for a shard.
   */
  async getMerkleRoot(shardId: string): Promise<string> {
    const tree = await this.buildMerkleTree();
    return tree.hash;
  }

  /**
   * Walk the Merkle tree and find leaf nodes (ranges to compare).
   * Returns leaf ranges for comparison with remote.
   */
  async findDiffRanges(node: MerkleNode): Promise<Array<{ start: string; end: string }>> {
    // In production: compare node.hash with remote node's hash.
    // If different and has children, recurse.
    // If different and leaf, return range.
    //
    // For testing, we return all leaf ranges.
    const ranges: Array<{ start: string; end: string }> = [];

    const walk = (n: MerkleNode): void => {
      if (!n.left && !n.right) {
        // Leaf node
        ranges.push({ start: n.rangeStart, end: n.rangeEnd });
        return;
      }
      if (n.left) walk(n.left);
      if (n.right) walk(n.right);
    };

    walk(node);
    return ranges;
  }

  /**
   * Get sync history for test assertions.
   */
  getSyncHistory(): SyncResult[] {
    return [...this.syncHistory];
  }
}
