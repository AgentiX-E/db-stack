/**
 * MerkleTree — the reference anti-entropy digest.
 *
 * Why this file exists
 * --------------------
 * The class was exported from the package's public API, sat among declarations
 * where the coverage gate does not look, and had no test. Two defects survived
 * in it because of that:
 *
 *   - `computeRoot()` called `require('crypto')`. The package is ESM, so the
 *     published artefact threw `ReferenceError: require is not defined` for
 *     every consumer that hashed anything. The test suite never saw it because
 *     the test transform supplies a `require`.
 *   - `build()` assigned the entry array and then called `add()` with the same
 *     array, so every leaf was counted twice. Two replicas holding identical
 *     data produced identical — and identical is not correct — root digests, so
 *     no comparison between replicas could notice.
 *
 * The root digest is therefore asserted against an independently computed
 * SHA-256, not against another call of the class: a tree compared with itself
 * agrees with itself no matter what it computes.
 *
 * Acceptance criteria:
 *   AC 54.1  the root is the SHA-256 of key,hash pairs in insertion order
 *   AC 54.2  the root changes when a leaf hash changes, and when a leaf is added
 *   AC 54.3  build() replaces the leaf set instead of doubling it
 *   AC 54.4  add() appends to what is already there
 *   AC 54.5  an empty tree has the SHA-256 of the empty string, not a crash
 *   AC 54.6  difference() reports keys this tree has that the other lacks
 *   AC 54.7  difference() is directional and order-independent in its verdict
 *   AC 54.8  difference() collapses duplicate pairs to one key
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { MerkleTree } from '../../consensus/anti-entropy/MerkleTree';
import type { Entry } from '../../interfaces/IMerkleTreeSync';

/** Independent reference: SHA-256 over each entry's key and hash, in order. */
function referenceRoot(entries: Entry[]): string {
  const hash = createHash('sha256');
  for (const e of entries) hash.update(e.key).update(e.hash);
  return hash.digest('hex');
}

const entryA: Entry = { key: 'a', hash: 'h1' };
const entryB: Entry = { key: 'b', hash: 'h2' };
const ab: Entry[] = [entryA, entryB];

describe('MerkleTree', () => {
  it('AC 54.1: root equals the SHA-256 of the ordered key,hash pairs', () => {
    const tree = new MerkleTree();
    tree.build(ab);
    expect(tree.computeRoot()).toBe(referenceRoot(ab));
    expect(tree.rootHash()).toBe(referenceRoot(ab));
  });

  it('AC 54.2: the root moves when a leaf changes and when a leaf is added', () => {
    const base = new MerkleTree();
    base.build(ab);

    const changed = new MerkleTree();
    changed.build([
      { key: 'a', hash: 'h1' },
      { key: 'b', hash: 'CHANGED' },
    ]);

    const grown = new MerkleTree();
    grown.build([...ab, { key: 'c', hash: 'h3' }]);

    expect(changed.computeRoot()).not.toBe(base.computeRoot());
    expect(grown.computeRoot()).not.toBe(base.computeRoot());
  });

  it('AC 54.3: build() replaces the leaf set instead of doubling it', () => {
    const tree = new MerkleTree();
    tree.build(ab);
    // The defect: leaves counted twice, so a 2-entry tree hashed 4 updates and
    // still matched a peer that doubled the same way.
    expect(tree.size).toBe(2);
    expect(tree.computeRoot()).toBe(referenceRoot(ab));

    // Rebuilding with different data must not retain the earlier leaves.
    tree.build([{ key: 'z', hash: 'hz' }]);
    expect(tree.size).toBe(1);
    expect(tree.computeRoot()).toBe(referenceRoot([{ key: 'z', hash: 'hz' }]));
  });

  it('AC 54.4: add() appends to what is already there', () => {
    const tree = new MerkleTree();
    tree.build([entryA]);
    tree.add([entryB]);
    expect(tree.size).toBe(2);
    expect(tree.computeRoot()).toBe(referenceRoot(ab));
  });

  it('AC 54.5: an empty tree hashes the empty input', () => {
    const tree = new MerkleTree();
    expect(tree.size).toBe(0);
    expect(tree.computeRoot()).toBe(createHash('sha256').digest('hex'));
  });

  it('AC 54.6: difference() reports keys this tree has and the other lacks', () => {
    const mine = new MerkleTree();
    mine.build([...ab, { key: 'c', hash: 'h3' }]);
    const theirs = new MerkleTree();
    theirs.build([entryA]);

    expect(mine.difference(theirs)).toEqual(['b', 'c']);
    // A key present on both sides with a different hash is a divergence at the
    // same key: the peer holds a stale value and must be told.
    const stale = new MerkleTree();
    stale.build([{ key: 'a', hash: 'OLD' }]);
    expect(mine.difference(stale)).toEqual(['a', 'b', 'c']);
  });

  it('AC 54.7: difference() answers the direction it was asked', () => {
    const mine = new MerkleTree();
    mine.build([entryA]);
    const theirs = new MerkleTree();
    theirs.build(ab);

    expect(mine.difference(theirs)).toEqual([]);
    expect(theirs.difference(mine)).toEqual(['b']);
  });

  it('AC 54.8: difference() collapses duplicate pairs to a single key', () => {
    const mine = new MerkleTree();
    mine.build([entryA]);
    mine.add([entryA]);
    expect(mine.size).toBe(2);
    expect(mine.difference(new MerkleTree())).toEqual(['a']);
  });
});
