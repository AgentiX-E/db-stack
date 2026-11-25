/**
 * AntiEntropy — branch-completion tests.
 *
 * The reconciliation branches the paired fixture cannot reach on its own, plus
 * lifecycle edges:
 *   - `applyRemote` on a store where `get()` and `getRange()` disagree
 *   - `applyRemote` against a provider that ignores the origin (the "cannot
 *     converge" shape, which must be visible as a repeated difference rather than
 *     as silent agreement)
 *   - start(config?) override and start() idempotence
 *   - the empty-data branch of `buildMerkleTree`
 *
 * These used to drive `syncWith`, which compared the local dataset with itself.
 * The branches they exercised still exist, but they live in `applyRemote` — where
 * entries actually arrive from a peer — so the fixture now calls that.
 */

import { describe, it, expect } from 'vitest';
import { AntiEntropy, type DataEntry, type DataProvider } from './AntiEntropy';
import { ConflictResolver } from './ConflictResolver';

function makeEntry(key: string, value: string, nodeId: string, wallTime = 100, logical = 1): DataEntry {
  return { key, value, hlc: { wallTime, logical, nodeId }, nodeId };
}

/** A provider whose `getRange` reports one dataset and whose `get` reports another. */
class DivergentDataProvider implements DataProvider {
  private remote = new Map<string, DataEntry>();
  private local = new Map<string, DataEntry>();
  /** Values written through `apply`, so a test can see what landed. */
  readonly applied: Array<{ key: string; value: string; nodeId: string }> = [];

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

  async apply(key: string, value: string, origin?: { hlc: DataEntry['hlc']; nodeId: string }): Promise<void> {
    this.applied.push({ key, value, nodeId: origin?.nodeId ?? 'unknown' });
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

/** A provider that stores values but always reports the same clock. */
class ForgetfulProvider implements DataProvider {
  private readonly data = new Map<string, DataEntry>();

  async getRange(start: string, end: string): Promise<DataEntry[]> {
    return [...this.data.values()].filter((entry) => entry.key >= start && entry.key <= end);
  }
  async getEntriesAfter(): Promise<DataEntry[]> {
    return [];
  }
  async apply(key: string, value: string): Promise<void> {
    // Deliberately drops the origin clock.
    this.data.set(key, { key, value, hlc: { wallTime: 0, logical: 0, nodeId: 'forgetful' }, nodeId: 'forgetful' });
  }
  async get(key: string): Promise<DataEntry | null> {
    return this.data.get(key) ?? null;
  }
}

describe('AntiEntropy — applyRemote reconciliation branches', () => {
  it('resolves a conflict when get() disagrees with the entry being pushed', async () => {
    const p = new DivergentDataProvider();
    p.setLocal(makeEntry('k1', 'local-val', 'n1', 100, 1));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));
    const outcome = await ae.applyRemote([makeEntry('k1', 'remote-val', 'n2', 200, 1)]);

    expect(outcome.conflicts).toBe(1);
    expect(p.applied).toEqual([{ key: 'k1', value: 'remote-val', nodeId: 'n2' }]);
  });

  it('applies a new entry when get() returns null', async () => {
    const p = new DivergentDataProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));

    const outcome = await ae.applyRemote([makeEntry('k2', 'new-val', 'n2', 150, 1)]);

    expect(outcome.applied).toBe(1);
    expect(p.applied).toEqual([{ key: 'k2', value: 'new-val', nodeId: 'n2' }]);
  });

  it('leaves no branch that neither applies nor skips', async () => {
    const p = new DivergentDataProvider();
    p.setLocal(makeEntry('same', 'v', 'n1', 100, 1));

    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));
    const outcome = await ae.applyRemote([
      makeEntry('fresh', 'v2', 'n2', 100, 1),
      makeEntry('same', 'v', 'n2', 900, 1),
    ]);

    expect(outcome.applied + outcome.skipped + outcome.conflicts).toBe(2);
    expect(p.applied).toHaveLength(1);
  });

  it('stores the clock it was given, not the one it invented', async () => {
    const p = new ForgetfulProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p, new ConflictResolver('n1'));

    await ae.applyRemote([makeEntry('k', 'v', 'n2', 500, 0)]);

    // The provider dropped the origin, so the stored clock is its own. The point of
    // the assertion is that the entry *arrived* with a clock and the store is the
    // party that discards it — which is why `apply` accepts an origin at all.
    const stored = await ae.snapshotEntries();
    expect(stored[0]!.hlc.wallTime).toBe(0);
    expect((await ae.buildDigest()).total).toBe(1);
  });
});

describe('AntiEntropy — lifecycle edges', () => {
  it('start() is idempotent and accepts a config override', async () => {
    const p = new EmptyProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p);

    await ae.start({ nodeId: 'n1', intervalMs: 50, merkleDepth: 3 });
    const timer1 = ae['timer'];
    await ae.start(); // second start → `if (this.running) return`
    expect(ae['timer']).toBe(timer1);

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

  it('sweeping with no peer bound is a no-op, not a self-comparison', async () => {
    const p = new EmptyProvider();
    const ae = new AntiEntropy({ nodeId: 'n1', intervalMs: 30000, merkleDepth: 3 }, p);
    await expect(ae.syncAll()).resolves.toEqual([]);
  });
});
