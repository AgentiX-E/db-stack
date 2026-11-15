/**
 * crdt-types — branch-completion tests.
 *
 * Targets the decision branches the CRT2 suite leaves implicit:
 *   - LWWRegister assign/merge nodeId tiebreak (cmp === 0 && larger nodeId)
 *   - LWWRegister compareTo/compareToRaw logical-clock inequality (±1 returns)
 *   - LWWRegister assign with an undefined nodeId (nullish `?? this.nodeId`)
 *   - MVRegister pruneSuperseded duplicate-equality predicate (true branch)
 *   - MVRegister assign/add with undefined nodeId (nullish `?? ""`)
 *   - ORSet pruneTombstoned fully-tombstoned element (active.length === 0)
 */

import { describe, it, expect } from 'vitest';
import { LWWRegister, MVRegister, ORSet } from './crdt-types';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC } from '../hlc/HLC';

/**
 * A stamp with no `nodeId`, as a peer payload written before the field existed
 * would carry. `IHLCTimestamp` declares `nodeId` as required, so the field is
 * cleared at runtime instead of at the type level.
 */
function stampWithoutNodeId(wallTime: bigint, logical: number): IHLCTimestamp {
  return Object.assign(new HLC('', wallTime, logical), { nodeId: undefined });
}

describe('LWWRegister — nodeId tiebreak and logical inequality', () => {
  it('assign tiebreaks by nodeId when HLC equal but logical differs handling', () => {
    // cmp === 0 only when wallTime AND logical are equal.
    const reg = new LWWRegister({
      value: 'a',
      hlcWallTime: 100,
      hlcLogical: 5,
      nodeId: 'n1',
    });
    reg.assign('b', {
      wallTime: BigInt(100),
      logical: 5,
      nodeId: 'n9',
    } as IHLCTimestamp);
    expect(reg.value).toBe('b');
    expect(reg.nodeId).toBe('n9');
  });

  it('assign keeps current when tiebreak nodeId is smaller', () => {
    const reg = new LWWRegister({
      value: 'keep',
      hlcWallTime: 100,
      hlcLogical: 5,
      nodeId: 'n9',
    });
    reg.assign('drop', {
      wallTime: BigInt(100),
      logical: 5,
      nodeId: 'n1',
    } as IHLCTimestamp);
    expect(reg.value).toBe('keep');
    expect(reg.nodeId).toBe('n9');
  });

  it('assign handles undefined nodeId via nullish fallback', () => {
    const reg = new LWWRegister({
      value: 'a',
      hlcWallTime: 100,
      hlcLogical: 5,
      nodeId: 'n1',
    });
    // higher wallTime but undefined nodeId → `hlc.nodeId ?? this.nodeId`
    reg.assign('b', stampWithoutNodeId(200n, 0));
    expect(reg.value).toBe('b');
    expect(reg.nodeId).toBe('n1'); // fell back to existing nodeId
  });

  it('compareTo returns +1/-1 when logical clock differs', () => {
    const reg = new LWWRegister({
      value: 'a',
      hlcWallTime: 100,
      hlcLogical: 5,
      nodeId: 'n1',
    });
    // same wallTime, higher logical → -1 (this < other)
    const higher = new HLC('n1', 100n, 9);
    const lower = new HLC('n1', 100n, 2);
    expect(reg['compareTo'](higher)).toBeLessThan(0);
    expect(reg['compareTo'](lower)).toBeGreaterThan(0);
  });

  it('merge tiebreaks by nodeId when HLC equal', () => {
    const reg = new LWWRegister({
      value: 'small',
      hlcWallTime: 100,
      hlcLogical: 0,
      nodeId: 'n1',
    });
    reg.merge({ value: 'big', hlcWallTime: 100, hlcLogical: 0, nodeId: 'n9' });
    expect(reg.value).toBe('big');
    expect(reg.nodeId).toBe('n9');
  });

  it('merge keeps higher logical when wallTime equal (compareToRaw inequality)', () => {
    // wallTime equal, logical differs → compareToRaw returns ±1 on logical.
    const reg = new LWWRegister({
      value: 'keep',
      hlcWallTime: 100,
      hlcLogical: 5,
      nodeId: 'n1',
    });
    reg.merge({
      value: 'lower-logical',
      hlcWallTime: 100,
      hlcLogical: 2,
      nodeId: 'n2',
    });
    expect(reg.value).toBe('keep'); // local logical 5 > remote 2

    const reg2 = new LWWRegister({
      value: 'low',
      hlcWallTime: 100,
      hlcLogical: 2,
      nodeId: 'n1',
    });
    reg2.merge({
      value: 'higher-logical',
      hlcWallTime: 100,
      hlcLogical: 9,
      nodeId: 'n2',
    });
    expect(reg2.value).toBe('higher-logical'); // remote logical 9 > local 2
  });
});

describe('MVRegister — prune predicate and nullish nodeId', () => {
  it('assign uses nullish `?? ""` for undefined nodeId', () => {
    const reg = new MVRegister();
    reg.assign('v', stampWithoutNodeId(100n, 0));
    expect(reg.entries[0]!.nodeId).toBe('');
  });

  it('add uses nullish `?? ""` for undefined nodeId', () => {
    const reg = new MVRegister();
    reg.add('v', stampWithoutNodeId(100n, 0));
    expect(reg.entries[0]!.nodeId).toBe('');
  });

  it('pruneSuperseded removes duplicate entries (equality predicate true)', () => {
    // Two identical entries: pruneSuperseded's duplicate check must collapse them.
    const reg = new MVRegister();
    reg.add('dup', {
      wallTime: BigInt(100),
      logical: 5,
      nodeId: 'n1',
    } as IHLCTimestamp);
    reg.add('dup', {
      wallTime: BigInt(100),
      logical: 5,
      nodeId: 'n1',
    } as IHLCTimestamp);
    // values() runs pruneSuperseded, which dedupes identical concurrent entries.
    expect(reg.values()).toEqual(['dup']);
  });

  it('merge dedupes identical entries via equality predicate', () => {
    const reg = new MVRegister();
    reg.add('x', {
      wallTime: BigInt(100),
      logical: 5,
      nodeId: 'n1',
    } as IHLCTimestamp);
    reg.merge({
      entries: [{ value: 'x', wallTime: 100, logical: 5, nodeId: 'n1' }],
    });
    expect(reg.entries).toHaveLength(1);
  });
});

describe('ORSet — fully-tombstoned element pruning', () => {
  it('pruneTombstoned deletes element when all tags are tombstoned', () => {
    const set = new ORSet();
    set.add('elem', 'tag-1');
    // Tombstone the sole tag directly, then prune via merge (no-op remote).
    set['tombstones']['elem'] = ['tag-1'];
    set['pruneTombstoned']();
    expect(set.contains('elem')).toBe(false);
    expect('elem' in set.elements).toBe(false);
  });
});
