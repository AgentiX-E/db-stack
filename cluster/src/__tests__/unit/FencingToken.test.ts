/**
 * Fencing tokens — the resource layer's own answer to "may this write land?".
 *
 * A Raft leader's belief about its own partition is not evidence. The only place
 * an old primary can be stopped is the resource it writes to, and the only fact
 * that resource can compare is a token the quorum minted. These cases pin the two
 * properties that make that comparison worth anything: the order is total and
 * monotonic (term first, then committed index), and a token below the highest the
 * resource has seen is refused no matter who presents it.
 *
 * The failure this encodes: `fencingRequest()` used to answer from
 * `isInMajority()` — a belief assembled from the messages a node happened to
 * receive. A partitioned leader that still hears one peer answers "yes" and keeps
 * writing. A token cannot be argued with.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FencingTokenGuard,
  compareFencingTokens,
  formatFencingToken,
  mintFencingToken,
  parseFencingToken,
  stampFencingTokenOnEntry,
  type FencingToken,
} from '../../consensus/fencing/FencingToken';

const token = (term: number, index: number): FencingToken => ({ term, index });

describe('mintFencingToken', () => {
  it('carries the term and committed index the quorum reached', () => {
    expect(mintFencingToken(7, 42)).toEqual({ term: 7, index: 42 });
  });

  it('accepts zero for both coordinates', () => {
    expect(mintFencingToken(0, 0)).toEqual({ term: 0, index: 0 });
  });

  it.each([
    ['a negative term', -1, 0, 'term'],
    ['a negative index', 1, -1, 'index'],
    ['a fractional term', 1.5, 0, 'term'],
    ['a fractional index', 1, 2.5, 'index'],
    ['NaN', Number.NaN, 0, 'term'],
    ['Infinity', Number.POSITIVE_INFINITY, 0, 'term'],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2, 0, 'term'],
  ])('refuses %s', (_label, term, index, coordinate) => {
    // The message names the coordinate: an operator reading a refusal has to know
    // which of the two numbers came from the wrong place.
    expect(() => mintFencingToken(term, index)).toThrow(RangeError);
    expect(() => mintFencingToken(term, index)).toThrow(new RegExp(`'s ${coordinate} must be`));
  });
});

describe('compareFencingTokens', () => {
  it('ranks a higher term above any index in a lower term', () => {
    expect(compareFencingTokens(token(2, 0), token(1, 999_999))).toBe(1);
    expect(compareFencingTokens(token(1, 999_999), token(2, 0))).toBe(-1);
  });

  it('ranks by committed index inside one term', () => {
    expect(compareFencingTokens(token(3, 10), token(3, 9))).toBe(1);
    expect(compareFencingTokens(token(3, 9), token(3, 10))).toBe(-1);
  });

  it('reports equality for the same position', () => {
    expect(compareFencingTokens(token(3, 10), token(3, 10))).toBe(0);
  });
});

describe('format and parse', () => {
  it('round-trips through the wire form', () => {
    const minted = mintFencingToken(11, 2048);
    expect(formatFencingToken(minted)).toBe('11/2048');
    expect(parseFencingToken('11/2048')).toEqual(minted);
  });

  it.each([
    ['', 'is "term/index"'],
    ['1', 'is "term/index"'],
    ['1/', 'is "term/index"'],
    ['/2', 'is "term/index"'],
    ['1/2/3', 'is "term/index"'],
    ['-1/2', 'unsigned decimals'],
    ['1/-2', 'unsigned decimals'],
    ['1.5/2', 'unsigned decimals'],
    ['a/b', 'unsigned decimals'],
    [' 1/2', 'unsigned decimals'],
    ['01/2', 'unsigned decimals'],
  ])('refuses the malformed token %j and says why', (raw, expected) => {
    expect(() => parseFencingToken(raw)).toThrow(TypeError);
    expect(() => parseFencingToken(raw)).toThrow(expected);
  });

  it('refuses a token whose coordinates cannot be safe integers', () => {
    expect(() => parseFencingToken('9007199254740993/0')).toThrow(RangeError);
  });

  it('refuses something that is not a string at all, and says so', () => {
    expect(() => parseFencingToken(42 as unknown as string)).toThrow(TypeError);
    expect(() => parseFencingToken(42 as unknown as string)).toThrow('must be a string');
    expect(() => parseFencingToken(undefined as unknown as string)).toThrow(TypeError);
  });

  it('records the position it admitted in words, not only in the verdict', () => {
    const guard = new FencingTokenGuard();
    expect(guard.admit(token(2, 9), 'orders').detail).toContain('2/9');
    expect(guard.admit(token(2, 8)).detail).toContain('2/8');
    expect(new FencingTokenGuard({ requireToken: false }).admit().detail).toContain('without a token');
  });
});

describe('FencingTokenGuard — the resource refuses what it has already surpassed', () => {
  it('admits the first token and remembers it', () => {
    const guard = new FencingTokenGuard();
    const admission = guard.admit(token(1, 10));

    expect(admission.admitted).toBe(true);
    expect(admission.reason).toBeUndefined();
    expect(admission.highest).toEqual(token(1, 10));
    expect(guard.getHighest()).toEqual(token(1, 10));
    expect(guard.getRefusalCount()).toBe(0);
  });

  it('admits an equal token, because a retry is not a usurper', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(1, 10));

    const replay = guard.admit(token(1, 10));

    expect(replay.admitted).toBe(true);
    expect(guard.getHighest()).toEqual(token(1, 10));
  });

  it('refuses a lower index in the same term', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(4, 20));

    const refusal = guard.admit(token(4, 19));

    expect(refusal.admitted).toBe(false);
    expect(refusal.reason).toBe('stale-token');
    expect(refusal.detail).toContain('4/19');
    expect(refusal.detail).toContain('4/20');
    expect(refusal.highest).toEqual(token(4, 20));
    expect(guard.getRefusalCount()).toBe(1);
  });

  it('refuses an older term even when its index is far ahead', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(9, 1));

    const refusal = guard.admit(token(8, 1_000_000));

    expect(refusal.admitted).toBe(false);
    expect(refusal.reason).toBe('stale-token');
    expect(guard.getHighest()).toEqual(token(9, 1));
  });

  it('advances to a strictly greater token and never looks back', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(1, 5));
    guard.admit(token(2, 0));

    expect(guard.getHighest()).toEqual(token(2, 0));
    expect(guard.admit(token(1, 99)).admitted).toBe(false);
  });

  it('refuses a write that carries no token at all', () => {
    const guard = new FencingTokenGuard();

    const refusal = guard.admit(undefined);

    expect(refusal.admitted).toBe(false);
    expect(refusal.reason).toBe('missing-token');
    expect(refusal.detail).toContain('no token');
    expect(refusal.highest).toBeNull();
  });

  it('can be told to tolerate engines that cannot carry a token yet', () => {
    const guard = new FencingTokenGuard({ requireToken: false });

    expect(guard.admit(null).admitted).toBe(true);
    guard.admit(token(3, 3));
    expect(guard.admit(undefined).admitted).toBe(true);
    expect(guard.admit(token(3, 2)).admitted).toBe(false);
  });

  it('starts from a token recovered from durable state', () => {
    const guard = new FencingTokenGuard({ initial: token(12, 400) });

    expect(guard.getHighest()).toEqual(token(12, 400));
    expect(guard.admit(token(12, 399)).admitted).toBe(false);
    expect(guard.admit(token(12, 400)).admitted).toBe(true);
  });

  it('observes a higher token without admitting anything', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(1, 1));

    expect(guard.observe(token(5, 5))).toBe(true);
    expect(guard.getHighest()).toEqual(token(5, 5));
    expect(guard.getRefusalCount()).toBe(0);

    // A later observation that is not later says so, rather than silently passing.
    expect(guard.observe(token(2, 2))).toBe(false);
    expect(guard.observe(token(5, 5))).toBe(false);
    expect(guard.getHighest()).toEqual(token(5, 5));
    expect(guard.admit(token(2, 2)).admitted).toBe(false);
  });

  it('observes the first position on a resource that has seen nothing', () => {
    const guard = new FencingTokenGuard();

    expect(guard.observe(token(9, 1))).toBe(true);
    expect(guard.getHighest()).toEqual(token(9, 1));
  });

  it('reports refusals to observers and names the caller context', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(1, 1));
    const seen: string[] = [];
    guard.onRefused((admission) => {
      seen.push(`${admission.reason}:${admission.detail}`);
    });

    guard.admit(token(1, 0), 'orders-write');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('stale-token');
    expect(seen[0]).toContain('orders-write');

    guard.admit(token(1, 2), 'orders-write');
    expect(seen).toHaveLength(1);
  });

  it('does not let a throwing observer turn an admission into a rejection', () => {
    const guard = new FencingTokenGuard();
    guard.onRefused(() => {
      throw new Error('observer exploded');
    });
    guard.admit(token(1, 1));

    expect(guard.admit(token(1, 0)).admitted).toBe(false);
    expect(guard.getRefusalCount()).toBe(1);
    expect(guard.admit(token(1, 1)).admitted).toBe(true);
  });

  it('stops notifying an unsubscribed observer', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(1, 1));
    const spy = vi.fn();
    const off = guard.onRefused(spy);

    guard.admit(token(1, 0));
    off();
    guard.admit(token(1, 0));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resets to empty or to a supplied position', () => {
    const guard = new FencingTokenGuard();
    guard.admit(token(7, 7));
    guard.admit(token(7, 6));

    guard.reset();
    expect(guard.getHighest()).toBeNull();
    expect(guard.getRefusalCount()).toBe(1);
    expect(guard.admit(token(1, 0)).admitted).toBe(true);

    guard.reset(token(8, 8));
    expect(guard.admit(token(8, 7)).admitted).toBe(false);
  });
});

describe('stampFencingTokenOnEntry — the write-path seam', () => {
  it('stamps a position from the term and committed index given to it', () => {
    const stamped = stampFencingTokenOnEntry({ msgId: 'a', data: '{}' }, 4, 91);
    expect(stamped).toEqual({ msgId: 'a', data: '{}', fencingToken: '4/91' });
  });

  it('leaves the caller entry untouched — it returns a new object', () => {
    const entry = { msgId: 'b', data: '{}' };
    const stamped = stampFencingTokenOnEntry(entry, 4, 91);
    expect(entry).toEqual({ msgId: 'b', data: '{}' });
    expect(stamped).not.toBe(entry);
  });

  it('keeps a caller token at or above the group position', () => {
    expect(stampFencingTokenOnEntry({ fencingToken: '5/1' }, 4, 91).fencingToken).toBe('5/1');
    expect(stampFencingTokenOnEntry({ fencingToken: '4/91' }, 4, 91).fencingToken).toBe('4/91');
  });

  it('refuses a caller token behind the group position', () => {
    expect(() => stampFencingTokenOnEntry({ fencingToken: '3/999' }, 4, 91)).toThrow(/behind/i);
    expect(() => stampFencingTokenOnEntry({ fencingToken: '5/0' }, 6, 1)).toThrow(/behind/i);
  });

  it('refuses a malformed caller token rather than guessing', () => {
    expect(() => stampFencingTokenOnEntry({ fencingToken: 'nope' }, 4, 91)).toThrow(/malformed/i);
  });
});
