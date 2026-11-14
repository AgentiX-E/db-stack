/**
 * HLC — branch-completion tests.
 *
 * Targets the `observe()` time-relation decision branches and the pure
 * `max3`/`compare` paths that the AC 42.x suite leaves implicit:
 *   - observe() when local wall == remote wall but pt is lower (logical advance)
 *   - observe() when remote wall == pt and local wall is lower
 *   - observe() when local wall is the sole max
 *   - observe() when pt is the sole max (clock jumps forward past both)
 *   - observe() when remote wall is the sole max (already covered, re-confirmed)
 *   - max3 picking `b` as the unique maximum
 *   - instance `.compare()` delegation
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { HLC, compareHLC, makeHLC, hlcToKey } from './HLC';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';

afterEach(() => vi.restoreAllMocks());

describe('HLC — observe() time-relation matrix (branch completion)', () => {
  it('advances logical when local==remote wall but pt is lower', () => {
    const wall = BigInt('1700000000000');
    const pt = Number(wall) - 1000; // pt behind both
    vi.spyOn(Date, 'now').mockReturnValue(pt);

    const local = new HLC('node-a', wall, 7);
    const remote = makeHLC(wall, 30, 'node-b');

    local.observe(remote);

    // maxWall = lastWall = remoteWall; pt lower → logical = max(7,30)+1 = 31
    const ts = (local as any).lastLogical;
    expect(ts).toBe(31);
  });

  it('advances logical from remote when remote==pt and local wall is lower', () => {
    const remoteWall = BigInt('1700000000200');
    const pt = Number(remoteWall);
    vi.spyOn(Date, 'now').mockReturnValue(pt);

    const local = new HLC('node-a', BigInt('1700000000000'), 5); // local lower
    const remote = makeHLC(remoteWall, 42, 'node-b');

    local.observe(remote);

    // maxWall = remoteWall = pt; local lower → logical = remote.logical + 1 = 43
    expect((local as any).lastLogical).toBe(43);
    expect((local as any).lastWall).toBe(remoteWall);
  });

  it('advances logical when local wall is the sole max', () => {
    const localWall = BigInt('1700000000300');
    vi.spyOn(Date, 'now').mockReturnValue(Number(localWall) - 100); // pt lower
    const remoteWall = localWall - 200n; // remote lower

    const local = new HLC('node-a', localWall, 9);
    const remote = makeHLC(remoteWall, 50, 'node-b');

    local.observe(remote);

    // maxWall = lastWall only → logical = lastLogical + 1 = 10
    expect((local as any).lastLogical).toBe(10);
    expect((local as any).lastWall).toBe(localWall);
  });

  it('resets logical to 0 when pt is the sole max', () => {
    const ptWall = BigInt('1700000000400');
    vi.spyOn(Date, 'now').mockReturnValue(Number(ptWall));

    const local = new HLC('node-a', BigInt('1700000000000'), 9);
    const remote = makeHLC(BigInt('1700000000100'), 5, 'node-b');

    local.observe(remote);

    // maxWall = pt only → logical = 0
    expect((local as any).lastLogical).toBe(0);
    expect((local as any).lastWall).toBe(ptWall);
  });

  it('advances logical from remote when remote wall is the sole max', () => {
    const remoteWall = BigInt('1700000000500');
    vi.spyOn(Date, 'now').mockReturnValue(Number(remoteWall) - 200);
    const local = new HLC('node-a', BigInt('1700000000000'), 3);
    const remote = makeHLC(remoteWall, 11, 'node-b');

    local.observe(remote);

    // maxWall = remoteWall only → logical = remote.logical + 1 = 12
    expect((local as any).lastLogical).toBe(12);
    expect((local as any).lastWall).toBe(remoteWall);
  });
});

describe('HLC — max3 b-branch and instance compare()', () => {
  it('max3 returns b when b is the unique maximum', () => {
    // Drive observe() so that max3(a=lastWall, b=remote.wallTime, c=pt) picks b.
    const remoteWall = BigInt('1700000000600');
    vi.spyOn(Date, 'now').mockReturnValue(Number(remoteWall) - 300); // c lowest
    const local = new HLC('node-a', BigInt('1700000000100'), 1); // a lowest
    const remote = makeHLC(remoteWall, 7, 'node-b'); // b highest

    local.observe(remote);
    expect((local as any).lastWall).toBe(remoteWall); // b chosen
    expect((local as any).lastLogical).toBe(8); // remote.logical + 1
  });

  it('instance .compare() delegates to compareHLC', () => {
    const a = new HLC('node-a', BigInt(1000), 0);
    const b: IHLCTimestamp = makeHLC(BigInt(2000), 0, 'node-b');
    expect(a.compare(b)).toBeLessThan(0);
    expect(a.compare(a)).toBe(0);
    expect(a.compare(makeHLC(BigInt(500), 0, 'node-c'))).toBeGreaterThan(0);
  });
});
