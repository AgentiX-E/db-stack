/**
 * ConflictResolver — branch-complete tests.
 *
 * Covers every strategy (lww / crdt-counter / crdt-set / crdt-map / custom),
 * every decision branch in each merge, and the custom-resolver dispatch paths
 * that the I18 happy-path suite does not exercise:
 *
 *   - LWW: local-wins (cmp>0), remote-wins (cmp<0), and the nodeId tiebreak
 *   - `resolve()` default fallback for an unknown strategy string
 *   - custom resolver dispatch via `tableName` and via `keyPrefix`
 *   - CRDT counter: invalid-JSON fallback, same-node no-loser case, N max-merge
 *   - CRDT set: element/tombstone union + tombstone pruning
 *   - CRDT map: counter+set sub-merge, missing-local-subkey branch
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConflictResolver,
  type ConflictStrategy,
  type ConflictValue,
  type CRDTCounterState,
  type CRDTSetState,
} from '../../replication/ConflictResolver';

/** Build a ConflictValue with a minimal but correct IHLCTimestamp. */
function hv(
  key: string,
  value: string,
  wallTime: number,
  logical: number,
  nodeId: string,
  hlcNodeId = nodeId,
): ConflictValue {
  const wt = BigInt(wallTime);
  return {
    key,
    value,
    hlc: {
      wallTime: wt,
      logical,
      nodeId: hlcNodeId,
      compare: (other: { wallTime: bigint; logical: number; nodeId: string }) => {
        if (wt !== other.wallTime) return wt > other.wallTime ? 1 : -1;
        if (logical !== other.logical) return logical > other.logical ? 1 : -1;
        if (hlcNodeId !== other.nodeId) return hlcNodeId > other.nodeId ? 1 : -1;
        return 0;
      },
      serialize: () => `${wallTime}:${logical}:${hlcNodeId}`,
      deserialize: () => {
        throw new Error('not used');
      },
    },
    nodeId,
  };
}

describe('ConflictResolver — LWW branches', () => {
  let resolver: ConflictResolver;
  beforeEach(() => {
    resolver = new ConflictResolver('dc-1/node-1');
  });

  it('local wins when its HLC wallTime is higher (cmp > 0)', async () => {
    const local = hv('k', 'local', 200, 0, 'n1');
    const remote = hv('k', 'remote', 100, 0, 'n2');
    const r = await resolver.resolve('k', local, remote, 'lww');
    expect(r.resolvedValue).toBe('local');
    expect(r.loserNodeIds).toEqual(['n2']);
    expect(r.strategyUsed).toBe('lww');
    expect(r.merged).toBe(false);
  });

  it('remote wins when its HLC wallTime is higher (cmp < 0)', async () => {
    const local = hv('k', 'local', 100, 0, 'n1');
    const remote = hv('k', 'remote', 200, 0, 'n2');
    const r = await resolver.resolve('k', local, remote, 'lww');
    expect(r.resolvedValue).toBe('remote');
    expect(r.loserNodeIds).toEqual(['n1']);
  });

  it('local wins the nodeId tiebreak when wallTime+logical are equal', async () => {
    const local = hv('k', 'local', 100, 5, 'node-b');
    const remote = hv('k', 'remote', 100, 5, 'node-a');
    const r = await resolver.resolve('k', local, remote, 'lww');
    expect(r.resolvedValue).toBe('local'); // "node-b" > "node-a"
    expect(r.loserNodeIds).toEqual(['node-a']);
  });

  it('remote wins the nodeId tiebreak when its nodeId is larger', async () => {
    const local = hv('k', 'local', 100, 5, 'node-a');
    const remote = hv('k', 'remote', 100, 5, 'node-b');
    const r = await resolver.resolve('k', local, remote, 'lww');
    expect(r.resolvedValue).toBe('remote');
    expect(r.loserNodeIds).toEqual(['node-a']);
  });

  it('resolves LWW by HLC logical counter when wallTime ties', async () => {
    const local = hv('k', 'local', 100, 9, 'n1');
    const remote = hv('k', 'remote', 100, 2, 'n2');
    const r = await resolver.resolve('k', local, remote, 'lww');
    expect(r.resolvedValue).toBe('local');
  });

  it('degenerate equal-HLC case returns remote (outer-nodeId tiebreak else)', async () => {
    // Both values carry an identical HLC (same wallTime/logical/hlcNodeId),
    // so compareHLC returns 0 and the outer-nodeId tiebreak path is taken.
    const local = hv('k', 'local', 100, 5, 'same-node');
    const remote = hv('k', 'remote', 100, 5, 'same-node');
    const r = await resolver.resolve('k', local, remote, 'lww');
    // outer nodeId equal → "same-node" > "same-node" is false → remote wins
    expect(r.resolvedValue).toBe('remote');
    expect(r.strategyUsed).toBe('lww');
  });
});

describe('ConflictResolver — resolve() dispatch & custom resolver', () => {
  let resolver: ConflictResolver;
  beforeEach(() => {
    resolver = new ConflictResolver('dc-1/node-1');
  });

  it('falls back to LWW for an unknown strategy string (default case)', async () => {
    const local = hv('k', 'local', 100, 0, 'n1');
    const remote = hv('k', 'remote', 200, 0, 'n2');
    // A strategy name read from configuration is not constrained by the union
    // type; it is exactly the case the default branch exists for.
    const r = await resolver.resolve('k', local, remote, 'totally-unknown' as ConflictStrategy);
    expect(r.strategyUsed).toBe('lww');
    expect(r.resolvedValue).toBe('remote');
  });

  it('dispatches to a custom resolver registered by tableName', async () => {
    resolver.registerCustomResolver({ tableName: 'users' }, async (key, _l, _r) => ({
      resolvedValue: `custom:${key}`,
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: true,
    }));
    const local = hv('users:42', 'a', 100, 0, 'n1');
    const remote = hv('users:42', 'b', 200, 0, 'n2');
    const r = await resolver.resolve('users:42', local, remote);
    expect(r.resolvedValue).toBe('custom:users:42');
    expect(r.strategyUsed).toBe('custom');
  });

  it('dispatches to a custom resolver registered by keyPrefix', async () => {
    resolver.registerCustomResolver({ keyPrefix: 'cache:' }, async () => ({
      resolvedValue: 'prefix-hit',
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: false,
    }));
    const local = hv('cache:x', 'a', 100, 0, 'n1');
    const remote = hv('cache:x', 'b', 200, 0, 'n2');
    const r = await resolver.resolve('cache:x', local, remote);
    expect(r.resolvedValue).toBe('prefix-hit');
  });

  it('registerCustomResolver falls back to __fallback__ key when neither field set', async () => {
    resolver.registerCustomResolver({}, async () => ({
      resolvedValue: 'fallback',
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: false,
    }));
    // A bare predicate maps to "__fallback__", which matches any key.
    const local = hv('any:key', 'a', 100, 0, 'n1');
    const remote = hv('any:key', 'b', 200, 0, 'n2');
    const r = await resolver.resolve('any:key', local, remote);
    expect(r.resolvedValue).toBe('fallback');
  });

  it('unregisterCustomResolver removes a keyPrefix resolver', async () => {
    resolver.registerCustomResolver({ keyPrefix: 'tmp:' }, async () => ({
      resolvedValue: 'tmp',
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: false,
    }));
    resolver.unregisterCustomResolver({ keyPrefix: 'tmp:' });
    const local = hv('tmp:1', 'a', 100, 0, 'n1');
    const remote = hv('tmp:1', 'b', 200, 0, 'n2');
    const r = await resolver.resolve('tmp:1', local, remote, 'lww');
    expect(r.strategyUsed).toBe('lww');
  });

  it('unregisterCustomResolver handles a bare predicate (?? fallback key)', async () => {
    // A bare predicate resolves to the "__fallback__" key; unregistering it
    // must not throw even though nothing was registered under that key.
    expect(() => resolver.unregisterCustomResolver({})).not.toThrow();
  });

  it('unregisterCustomResolver handles a tableName predicate', () => {
    resolver.registerCustomResolver({ tableName: 'tbl' }, async () => ({
      resolvedValue: 'x',
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: false,
    }));
    expect(() => resolver.unregisterCustomResolver({ tableName: 'tbl' })).not.toThrow();
  });

  it('findCustomResolver prefers tableName match over keyPrefix match', async () => {
    resolver.registerCustomResolver({ tableName: 'tbl', keyPrefix: 'pre' }, async () => ({
      resolvedValue: 'both',
      strategyUsed: 'custom',
      loserNodeIds: [],
      merged: false,
    }));
    const local = hv('tbl:1', 'a', 100, 0, 'n1');
    const remote = hv('tbl:1', 'b', 200, 0, 'n2');
    const r = await resolver.resolve('tbl:1', local, remote);
    expect(r.resolvedValue).toBe('both');
  });
});

describe('ConflictResolver — CRDT counter', () => {
  let resolver: ConflictResolver;
  beforeEach(() => {
    resolver = new ConflictResolver('n1');
  });

  it('merges per-node P and N via element-wise max', async () => {
    const local: CRDTCounterState = {
      p: { n1: 5, n2: 3 },
      n: { n1: 2, n2: 0 },
    };
    const remote: CRDTCounterState = {
      p: { n1: 3, n2: 7 },
      n: { n1: 0, n2: 4 },
    };
    const l = hv('c', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('c', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('c', l, r, 'crdt-counter');
    expect(res.strategyUsed).toBe('crdt-counter');
    expect(res.merged).toBe(true);
    const merged = JSON.parse(res.resolvedValue) as CRDTCounterState;
    expect(merged.p.n1).toBe(5);
    expect(merged.p.n2).toBe(7);
    expect(merged.n.n1).toBe(2);
    expect(merged.n.n2).toBe(4);
  });

  it('N merge covers the `?? 0` path for a node absent locally', async () => {
    const local: CRDTCounterState = { p: { n1: 1 }, n: { n1: 1 } };
    const remote: CRDTCounterState = { p: { n2: 9 }, n: { n2: 9 } };
    const l = hv('c', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('c', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('c', l, r, 'crdt-counter');
    const merged = JSON.parse(res.resolvedValue) as CRDTCounterState;
    expect(merged.p.n2).toBe(9);
    expect(merged.n.n2).toBe(9);
  });

  it('falls back to LWW when value is not valid JSON', async () => {
    const l = hv('c', 'not-json', 100, 0, 'n1');
    const r = hv('c', '{also-bad', 200, 0, 'n2');
    const res = await resolver.resolve('c', l, r, 'crdt-counter');
    expect(res.strategyUsed).toBe('lww');
    expect(res.resolvedValue).toBe('{also-bad'); // remote has higher wallTime
  });

  it('reports an empty loser list when nodes are identical', async () => {
    const state: CRDTCounterState = { p: { n1: 1 }, n: { n1: 0 } };
    const l = hv('c', JSON.stringify(state), 100, 0, 'same');
    const r = hv('c', JSON.stringify(state), 100, 0, 'same');
    const res = await resolver.resolve('c', l, r, 'crdt-counter');
    expect(res.loserNodeIds).toEqual([]);
  });
});

describe('ConflictResolver — CRDT set', () => {
  let resolver: ConflictResolver;
  beforeEach(() => {
    resolver = new ConflictResolver('n1');
  });

  it('unions elements and tombstones', async () => {
    const local: CRDTSetState = {
      elements: { x: ['t1'] },
      tombstones: {},
    };
    const remote: CRDTSetState = {
      elements: { y: ['t2'] },
      tombstones: {},
    };
    const l = hv('s', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('s', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    expect(res.strategyUsed).toBe('crdt-set');
    expect(res.merged).toBe(true);
    const merged = JSON.parse(res.resolvedValue) as CRDTSetState;
    expect(merged.elements.x).toEqual(['t1']);
    expect(merged.elements.y).toEqual(['t2']);
  });

  it('covers `?? []` when tombstone elem is absent from local tombstones', async () => {
    const local: CRDTSetState = {
      elements: { x: ['t1'] },
      tombstones: {}, // no tombstones locally
    };
    const remote: CRDTSetState = {
      elements: {},
      tombstones: { y: ['t-ghost'] }, // tombstone elem absent locally → `?? []`
    };
    const l = hv('s', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('s', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    const merged = JSON.parse(res.resolvedValue) as CRDTSetState;
    expect(merged.tombstones.y).toEqual(['t-ghost']);
  });

  it('prunes an element whose tags are all tombstoned', async () => {
    const local: CRDTSetState = {
      elements: { x: ['t1'], y: ['t2'] },
      tombstones: { x: ['t1'] },
    };
    const remote: CRDTSetState = {
      elements: {},
      tombstones: { x: ['t1'] },
    };
    const l = hv('s', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('s', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    const merged = JSON.parse(res.resolvedValue) as CRDTSetState;
    // x is fully tombstoned → removed; y survives
    expect(merged.elements.x).toBeUndefined();
    expect(merged.elements.y).toEqual(['t2']);
  });

  it('keeps an element whose tags are only partially tombstoned', async () => {
    const local: CRDTSetState = {
      elements: { x: ['t1', 't2'] },
      tombstones: { x: ['t1'] },
    };
    const remote: CRDTSetState = { elements: {}, tombstones: {} };
    const l = hv('s', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('s', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    const merged = JSON.parse(res.resolvedValue) as CRDTSetState;
    expect(merged.elements.x).toEqual(['t2']); // t1 pruned, t2 active
  });

  it('covers `?? []` in the tombstone prune loop (tombstone elem not in elements)', async () => {
    // A tombstone references an element with no entry in `elements` → the
    // prune loop hits `mergedElements[elem] ?? []` then deletes nothing.
    const local: CRDTSetState = {
      elements: {},
      tombstones: { ghost: ['t-g'] },
    };
    const remote: CRDTSetState = {
      elements: {},
      tombstones: { ghost: ['t-g'] },
    };
    const l = hv('s', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('s', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    const merged = JSON.parse(res.resolvedValue) as CRDTSetState;
    expect(merged.elements.ghost).toBeUndefined();
    expect(merged.tombstones.ghost).toEqual(['t-g']);
  });

  it('falls back to LWW when set value is invalid JSON', async () => {
    const l = hv('s', 'garbage', 100, 0, 'n1');
    const r = hv('s', 'also-garbage', 150, 0, 'n2');
    const res = await resolver.resolve('s', l, r, 'crdt-set');
    expect(res.strategyUsed).toBe('lww');
  });
});

describe('ConflictResolver — CRDT map', () => {
  let resolver: ConflictResolver;
  beforeEach(() => {
    resolver = new ConflictResolver('n1');
  });

  it('merges sub-counters and sub-sets, including missing-local branches', async () => {
    const local = {
      counters: { c1: { p: { n1: 5 }, n: { n1: 1 } } },
      sets: { s1: { elements: { x: ['t1'] }, tombstones: {} } },
    };
    const remote = {
      counters: {
        c1: { p: { n1: 3, n2: 8 }, n: { n2: 2 } },
        c2: { p: { n9: 1 }, n: { n9: 0 } }, // missing locally → whole-copy branch
      },
      sets: {
        s1: { elements: { y: ['t2'] }, tombstones: {} },
        s2: { elements: { z: ['t3'] }, tombstones: {} }, // missing locally → whole-copy branch
      },
    };
    const l = hv('m', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('m', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    expect(res.strategyUsed).toBe('crdt-map');
    expect(res.merged).toBe(true);
    const merged = JSON.parse(res.resolvedValue);
    // counters.c1 merged via max per node
    expect(merged.counters.c1.p.n1).toBe(5);
    expect(merged.counters.c1.p.n2).toBe(8);
    // counters.c2 copied wholesale
    expect(merged.counters.c2.p.n9).toBe(1);
    // sets.s1 merged (x + y)
    expect(merged.sets.s1.elements.x).toEqual(['t1']);
    expect(merged.sets.s1.elements.y).toEqual(['t2']);
    // sets.s2 copied wholesale
    expect(merged.sets.s2.elements.z).toEqual(['t3']);
  });

  it('falls back to LWW when map value is invalid JSON', async () => {
    const l = hv('m', 'not-json', 100, 0, 'n1');
    const r = hv('m', 'also-not-json', 200, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    expect(res.strategyUsed).toBe('lww');
  });

  it('merges sub-set tombstones and prunes within a map', async () => {
    const local = {
      counters: {},
      sets: { s1: { elements: { x: ['t1'] }, tombstones: { x: ['t1'] } } },
    };
    const remote = {
      counters: {},
      sets: { s1: { elements: { x: ['t1'] }, tombstones: { x: ['t1'] } } },
    };
    const l = hv('m', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('m', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    const merged = JSON.parse(res.resolvedValue);
    expect(merged.sets.s1.elements.x).toBeUndefined(); // fully tombstoned
  });

  it('covers `?? []` in map sub-set prune loop (tombstone elem not in elements)', async () => {
    const local = {
      counters: {},
      sets: { s1: { elements: {}, tombstones: { ghost: ['t-g'] } } },
    };
    const remote = {
      counters: {},
      sets: { s1: { elements: {}, tombstones: { ghost: ['t-g'] } } },
    };
    const l = hv('m', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('m', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    const merged = JSON.parse(res.resolvedValue);
    expect(merged.sets.s1.elements.ghost).toBeUndefined();
    expect(merged.sets.s1.tombstones.ghost).toEqual(['t-g']);
  });

  it('non-empty active tags survive sub-set prune (else branch)', async () => {
    const local = {
      counters: {},
      sets: {
        s1: { elements: { x: ['t1', 't2'] }, tombstones: { x: ['t1'] } },
      },
    };
    const remote = {
      counters: {},
      sets: { s1: { elements: {}, tombstones: { x: ['t1'] } } },
    };
    const l = hv('m', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('m', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    const merged = JSON.parse(res.resolvedValue);
    expect(merged.sets.s1.elements.x).toEqual(['t2']);
  });

  it('covers `?? []` in map sub-set tombstone union (remote tombstone elem absent locally)', async () => {
    const local = {
      counters: {},
      sets: { s1: { elements: { x: ['t1'] }, tombstones: {} } },
    };
    const remote = {
      counters: {},
      sets: { s1: { elements: {}, tombstones: { ghost: ['t-g'] } } },
    };
    const l = hv('m', JSON.stringify(local), 100, 0, 'n1');
    const r = hv('m', JSON.stringify(remote), 100, 0, 'n2');
    const res = await resolver.resolve('m', l, r, 'crdt-map');
    const merged = JSON.parse(res.resolvedValue);
    expect(merged.sets.s1.tombstones.ghost).toEqual(['t-g']);
    expect(merged.sets.s1.elements.x).toEqual(['t1']);
  });
});
