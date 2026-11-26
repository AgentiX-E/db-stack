/**
 * DCSplitBrainDetector — divergence-decision tests.
 *
 * The MA6-MA9 suite asserts that a split brain was *detected*, but never which
 * datacenter won or why. That leaves the winner arithmetic, the conflict count
 * and the losing-DC set unpinned — and one of them is wrong: `checkDivergence`
 * ranks timestamps with `wallTime * 1000 + logical` even though this module
 * already imports `compareHLC`. The product overflows `logical` into `wallTime`
 * once the logical clock passes 999, so a causally older datacenter can win a
 * fence and the losing side's acknowledged writes are dropped (MA8).
 *
 * Every case here drives the real detector through `receiveHeartbeat` and
 * asserts the decision it published. No test reaches into a private field to
 * fabricate an event, and no clock is stubbed.
 */

import { describe, it, expect } from 'vitest';
import { DCSplitBrainDetector, type DCHeartbeat, type SplitBrainEvent } from './DCSplitBrainDetector';
import { HLC, compareHLC, makeHLC } from '../hlc/HLC';

function makeDetector(autoRecover = false): DCSplitBrainDetector {
  const d = new DCSplitBrainDetector({
    nodeId: 'dc-0/node-1',
    dcId: 'dc-0',
    hlc: new HLC('dc-0/node-1'),
    heartbeatIntervalMs: 10_000,
    missedHeartbeatThreshold: 2,
    autoRecover,
  });
  d.start();
  return d;
}

function heartbeat(dcId: string, wallTime: number, logical: number, timestamp = Date.now()): DCHeartbeat {
  return {
    dcId,
    nodeId: `${dcId}/node-1`,
    hlc: { wallTime, logical, nodeId: `${dcId}/node-1` },
    appliedCount: 0,
    timestamp,
  };
}

/**
 * Feed a chain whose last entry is exactly (wallTime, logical), with the
 * logical clock advancing across the tail so `hasChainsDiverged` sees it.
 */
function feedChain(d: DCSplitBrainDetector, dcId: string, lastWallTime: number, lastLogical: number): void {
  const span = 4;
  for (let i = 0; i < 5; i++) {
    d.receiveHeartbeat(heartbeat(dcId, lastWallTime, lastLogical - (span - i)));
  }
}

/**
 * The detector publishes one event but indexes it under every diverged DC, so
 * `getActiveSplitBrains()` returns the same event once per key. Capture the
 * published event instead of assuming one map entry.
 */
function captureEvents(d: DCSplitBrainDetector): SplitBrainEvent[] {
  const seen: SplitBrainEvent[] = [];
  d.onSplitBrainDetected((e) => seen.push(e));
  return seen;
}

describe('DCSplitBrainDetector — which datacenter wins', () => {
  it('ranks the winner by the full HLC order, not by wallTime * 1000 + logical', () => {
    const d = makeDetector();
    const seen = captureEvents(d);

    // dc-A is causally later: its wallTime is 101 vs dc-B's 100.
    // compareHLC(lastA, lastB) > 0, so dc-A must win the fence.
    feedChain(d, 'dc-A', 101, 4);
    feedChain(d, 'dc-B', 100, 9000);

    const lastA = makeHLC(101n, 4, 'dc-A/node-1');
    const lastB = makeHLC(100n, 9000, 'dc-B/node-1');
    expect(compareHLC(lastA, lastB)).toBeGreaterThan(0);

    // The product's arithmetic says the opposite:
    //   101 * 1000 + 4 = 101 004  <  100 * 1000 + 9000 = 109 000
    // which would fence dc-A and keep the causally older dc-B's writes.
    expect(seen.at(-1)!.winningDc).toBe('dc-A');
    d.stop();
  });

  it('keeps the side with the larger wallTime when logical clocks are equal', () => {
    const d = makeDetector();
    const seen = captureEvents(d);
    feedChain(d, 'dc-A', 200, 3);
    feedChain(d, 'dc-B', 199, 3);
    expect(seen.at(-1)!.winningDc).toBe('dc-A');
    d.stop();
  });

  it('breaks a wallTime tie by the logical clock', () => {
    const d = makeDetector();
    const seen = captureEvents(d);
    feedChain(d, 'dc-A', 200, 3);
    feedChain(d, 'dc-B', 200, 8);
    expect(seen.at(-1)!.winningDc).toBe('dc-B');
    d.stop();
  });

  it('publishes a conflict count and a losing set that exclude the winner', () => {
    const d = makeDetector();
    const seen = captureEvents(d);
    feedChain(d, 'dc-A', 101, 4);
    feedChain(d, 'dc-B', 100, 8);

    const event = seen.at(-1)!;
    expect(event.winningDc).toBe('dc-A');
    expect(event.losingDcs).not.toContain('dc-A');
    expect(event.losingDcs).toContain('dc-B');
    expect(event.conflictCount).toBe(event.divergedDcs.length - 1);
    d.stop();
  });

  it('labels a manual detection manual and a fenced one fenced', () => {
    const manual = makeDetector(false);
    const manualSeen = captureEvents(manual);
    feedChain(manual, 'dc-A', 101, 4);
    feedChain(manual, 'dc-B', 100, 8);
    expect(manualSeen.at(-1)!.resolution).toBe('manual');
    manual.stop();

    const auto = makeDetector(true);
    const autoSeen = captureEvents(auto);
    feedChain(auto, 'dc-A', 101, 4);
    feedChain(auto, 'dc-B', 100, 8);
    // The chain grows past the 3-entry threshold one heartbeat at a time, so
    // several detections are published; every one of them must be fenced.
    expect(autoSeen.length).toBeGreaterThan(0);
    expect(autoSeen.every((e) => e.resolution === 'fenced')).toBe(true);
    auto.stop();
  });
});

describe('DCSplitBrainDetector — when two chains are actually diverged', () => {
  it('does not report a split brain when only one side advances its logical clock', () => {
    const d = makeDetector();
    feedChain(d, 'dc-A', 100, 4);
    // dc-B advances wallTime but its logical clock stays flat: a single writer
    // bumping its physical clock is not independent write activity.
    for (let i = 0; i < 5; i++) {
      d.receiveHeartbeat(heartbeat('dc-B', 100 + i, 0));
    }
    expect(d.hasSplitBrain()).toBe(false);
    d.stop();
  });

  it('does not treat logical zero as advancing', () => {
    const d = makeDetector();
    feedChain(d, 'dc-A', 100, 4);
    // dc-B's tail ends at logical 0 after counting down — the last entry is not
    // past zero, so it is not an independently progressing writer.
    for (let i = 0; i < 5; i++) {
      d.receiveHeartbeat(heartbeat('dc-B', 100, 4 - i));
    }
    expect(d.hasSplitBrain()).toBe(false);
    d.stop();
  });

  it('needs three entries on each side before it can judge divergence', () => {
    const d = makeDetector();
    for (let i = 0; i < 2; i++) {
      d.receiveHeartbeat(heartbeat('dc-A', 100, i + 1));
      d.receiveHeartbeat(heartbeat('dc-B', 100, i + 5));
    }
    expect(d.hasSplitBrain()).toBe(false);
    d.stop();
  });
});

describe('DCSplitBrainDetector — the shape of a silence', () => {
  /**
   * interval 100ms x threshold 2 = a 200ms timeout. A heartbeat 150ms old is
   * still inside that window under multiplication, but outside it under
   * addition (102) or division (50). The arithmetic is the decision.
   */
  function timedDetector(): DCSplitBrainDetector {
    return new DCSplitBrainDetector({
      nodeId: 'dc-0/node-1',
      dcId: 'dc-0',
      hlc: new HLC('dc-0/node-1'),
      heartbeatIntervalMs: 100,
      missedHeartbeatThreshold: 2,
      autoRecover: false,
    });
  }

  it('uses interval x threshold as the expiry window', () => {
    const d = timedDetector();
    d.start();
    const expired: { dcId: string; silenceMs: number }[] = [];
    d.onHeartbeatExpired((e) => expired.push(e));

    // 150ms old: inside 100*2=200, outside 100+2 and 100/2.
    d.receiveHeartbeat(heartbeat('dc-2', 1, 1, Date.now() - 150));
    d['broadcastHeartbeat']();
    expect(expired).toHaveLength(0);
    d.stop();
  });

  it('reports a silence once per silence, not once per tick', () => {
    const d = timedDetector();
    d.start();
    const expired: string[] = [];
    d.onHeartbeatExpired((e) => expired.push(e.dcId));

    d.receiveHeartbeat(heartbeat('dc-2', 1, 1, Date.now() - 5000));
    d['broadcastHeartbeat']();
    d['broadcastHeartbeat']();
    d['broadcastHeartbeat']();
    expect(expired).toEqual(['dc-2']);
    d.stop();
  });

  it('reports the recovery as a second, separate silence', () => {
    const d = timedDetector();
    d.start();
    const expired: string[] = [];
    d.onHeartbeatExpired((e) => expired.push(e.dcId));

    d.receiveHeartbeat(heartbeat('dc-2', 1, 1, Date.now() - 5000));
    d['broadcastHeartbeat']();
    // The peer speaks again — a fresh heartbeat clears the first silence.
    d.receiveHeartbeat(heartbeat('dc-2', 2, 1, Date.now()));
    // Then goes quiet a second time.
    d.receiveHeartbeat(heartbeat('dc-2', 3, 1, Date.now() - 5000));
    d['broadcastHeartbeat']();
    expect(expired).toEqual(['dc-2', 'dc-2']);
    d.stop();
  });
});
