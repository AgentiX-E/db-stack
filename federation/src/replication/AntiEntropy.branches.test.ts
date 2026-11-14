/**
 * AntiEntropy — branch-completion tests.
 *
 * Targets the syncWith reconciliation branches that the self-sync fixture keeps
 * implicit, plus lifecycle/idempotence edges:
 *   - start(config?) override path (`config ?? this.config`)
 *   - start() idempotence (second call early-returns)
 *   - conflict-resolution branch (get() nodeId differs from range entry)
 *   - new-entry branch (get() returns null → apply + entriesSynced)
 *   - buildMerkleTree empty-data branch
 *
 * These use a purpose-built DataProvider whose getRange/get return divergent
 * values to exercise the two reconciliation branches the in-memory fixture
 * (where getRange and get read the same map) cannot reach.
 */

import { describe, it, expect } from 'vitest';
import { AntiEntropy, type DataEntry, type DataProvider } from './AntiEntropy';
import { ConflictResolver } from './ConflictResolver';

function makeEntry(key: string, value: string, nodeId: string, wallTime = 100, logical = 1): DataEntry {
  return { key, value, hlc: { wallTime, logical, nodeId }, nodeId };
}

/**
 * A DataProvider whose getRange returns "remote" entries (different nodeId)
 * while get() returns the "local" entry, simulating two divergent replicas.
 */
class DivergentDataProvider implements DataProvider {
  private remote = new Map<string, DataEntry>();
  private local = new Map<string, DataEntry>();

  setRemote(e: DataEntry): void {
    this.remote.set(e.key, e);
  }
  setLocal(e: DataEntry): void {
    this.local.set(e.key, e);
  }

  async getRange(start: string, end: string): Promise<DataEntry[]> {
    const out: DataEntry[] = [];
    for (const [k, e] of this.remote) {
      if (k >= start && k <= end) out.push(e);
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]> {
    const sorted = Array.from(this.remote.values()).sort((a, b) => a.key.localeCompare(b.key));
    const idx = sorted.findIndex((e) => e.key > afterKey);
    if (idx < 0) return [];
    return sorted.slice(idx, idx + limit);
  }

  async apply(_key: string, _value: string): Promise<void> {
    /* no-op */
  }

  async get(key: string): Promise<DataEntry | null> {
    return this.local.get(key) ?? null;
  }
}

/** Throwaway provider for lifecycle-only tests. */
class EmptyProvider implements DataProvider {
  async getRange(): Promise<DataEntry[]> {
    return [];
  }
  async getEntriesAfter(): Promise<DataEntry[]> {
    return [];
  }
  async apply(): Promise<void> {}
  async get(): Promise<DataEntry | null> {
    return null;
  }
}

describe('AntiEntropy — syncWith reconciliation branches', () => {
  it('resolves a conflict when get() nodeId differs from the range entry', async () => {
    const p = new DivergentDataProvider();
    p.setRemote(makeEntry('k1', 'remote-val', 'n2', 200, 1));
    p.setLocal(makeEntry('k1', 'local-val', 'n1', 100, 1));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));

    const result = await ae.syncWith('n2');
    expect(result.conflictsResolved).toBeGreaterThan(0);
  });

  it('applies a new entry when get() returns null (entriesSynced)', async () => {
    const p = new DivergentDataProvider();
    // remote has an entry, local does not
    p.setRemote(makeEntry('k2', 'new-val', 'n2', 150, 1));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));

    const result = await ae.syncWith('n2');
    expect(result.entriesSynced).toBeGreaterThan(0);
  });
});

describe('AntiEntropy — lifecycle edges', () => {
  it('start() is idempotent and accepts a config override', async () => {
    const p = new EmptyProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p);

    await ae.start({ nodeId: 'n1', intervalMs: 50, merkleDepth: 3 });
    const timer1 = (ae as any).timer;
    await ae.start(); // second start → `if (this.running) return`
    expect((ae as any).timer).toBe(timer1);

    await ae.stop();
  });

  it('buildMerkleTree returns a valid root for empty data (empty branch)', async () => {
    const p = new EmptyProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p);
    const tree = await ae.buildMerkleTree();
    expect(tree.hash).toHaveLength(64);
    expect(tree.left).toBeNull();
    expect(tree.right).toBeNull();
  });
});
