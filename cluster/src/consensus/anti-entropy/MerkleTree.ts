/**
 * MerkleTree — reference implementation of the anti-entropy digests described by
 * {@link IMerkleTreeSync}.
 *
 * Extracted from `interfaces/` because it is executable code, not a
 * declaration: the coverage gate deliberately skips `src/interfaces/**` (type
 * declarations have no statements to cover), and code parked there is code
 * nothing measures. It sat untested for exactly that reason, and carried two
 * defects a test would have caught in a minute: a CommonJS `require` that
 * throws in this ESM package, and a `build()` that appended its input twice.
 */

import { createHash } from 'node:crypto';
import type { Entry } from '../../interfaces/IMerkleTreeSync';

/** Separator used to build a comparable identity for an entry. */
const PAIR_SEPARATOR = '\u0000';

function pairOf(entry: Entry): string {
  return `${entry.key}${PAIR_SEPARATOR}${entry.hash}`;
}

export class MerkleTree {
  private _entries: Entry[] = [];

  /**
   * Replace the contents of the tree.
   *
   * Replaces, not appends: the previous implementation assigned the array and
   * then called `add()` with the same array, so every entry appeared twice and
   * the root hash was computed over a doubled leaf set. Two replicas holding
   * identical data agreed with each other — they were both wrong in the same
   * way — which is why nothing noticed.
   */
  build(entries: Entry[]): void {
    this._entries = [...entries];
  }

  /** Append entries to the tree, keeping what is already there. */
  add(entries: Entry[]): void {
    this._entries.push(...entries);
  }

  /** Number of leaf entries currently in the tree. */
  get size(): number {
    return this._entries.length;
  }

  /** Root digest of the current leaf set (hex-encoded SHA-256). */
  rootHash(): string {
    return this.computeRoot();
  }

  /** Root digest of the current leaf set (hex-encoded SHA-256). */
  computeRoot(): string {
    const hash = createHash('sha256');
    for (const entry of this._entries) {
      hash.update(entry.key).update(entry.hash);
    }
    return hash.digest('hex');
  }

  /**
   * Keys this tree holds whose (key, hash) pair `other` does not.
   *
   * Directional by design: it answers "what do I have that you are missing",
   * which is the question a repair pass asks. Duplicate pairs collapse to one
   * key so a caller never issues the same repair twice.
   */
  difference(other: MerkleTree): string[] {
    const known = new Set(other._entries.map(pairOf));
    const reported = new Set<string>();
    const result: string[] = [];
    for (const entry of this._entries) {
      const pair = pairOf(entry);
      if (known.has(pair) || reported.has(pair)) continue;
      reported.add(pair);
      result.push(entry.key);
    }
    return result;
  }
}
