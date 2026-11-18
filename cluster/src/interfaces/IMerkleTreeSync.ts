/**
 * IMerkleTreeSync — Interface for Merkle tree-based anti-entropy.
 *
 * Declarations only. The reference implementation lives in
 * `consensus/anti-entropy/MerkleTree.ts`, so that it is measured by the
 * coverage gate and reachable from the tests; a class parked among declarations
 * is a class nothing exercises.
 */
export interface Entry {
  key: string;
  hash: string;
  value?: string;
}

export interface IMerkleTreeSync {
  build(entries: Entry[]): Promise<string>;
  diff(otherRootHash: string, entries: Entry[]): Promise<string[]>;
  getEntries(keys: string[]): Promise<Entry[]>;
}
