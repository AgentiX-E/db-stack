/**
 * IMerkleTreeSync — Interface for Merkle tree-based anti-entropy.
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

export class MerkleTree {
  private root: any;
  private _entries: Entry[] = [];

  constructor() {
    this.root = null;
  }

  build(entries: Entry[]): void {
    this._entries = entries;
    this.add(entries);
  }

  add(entries: Entry[]): void {
    for (const e of entries) {
      this._entries.push(e);
    }
  }

  rootHash(): string {
    return this.computeRoot();
  }

  difference(other: MerkleTree): string[] {
    const diff: string[] = [];
    for (const e of this._entries) {
      if (!other._entries.find((oe) => oe.key === e.key && oe.hash === e.hash)) {
        diff.push(e.key);
      }
    }
    return diff;
  }

  computeRoot(): string {
    const hash = require('crypto').createHash('sha256');
    for (const e of this._entries) {
      hash.update(e.key).update(e.hash);
    }
    return hash.digest('hex');
  }
}
