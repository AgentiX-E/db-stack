/**
 * ClockCompensator — boundary branch coverage
 *
 * Complements ClockCompensator.test.ts with the `?? Date.now()` fallbacks
 * (calls that omit localRecvMs) and the sliding-window shift branch when a
 * peer accumulates more than sampleWindowSize samples.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClockCompensator } from '../../ha/ClockCompensator';

describe('ClockCompensator — branch completion', () => {
  let comp: ClockCompensator;

  beforeEach(() => {
    comp = new ClockCompensator();
  });

  it('estimateOffset without localRecvMs falls back to Date.now()', () => {
    // L69 `?? Date.now()` — second arg omitted.
    const before = Date.now();
    const offset = comp.estimateOffset(before); // remote == now → ~0 offset
    expect(typeof offset).toBe('number');
    expect(Math.abs(offset)).toBeLessThanOrEqual(1);
  });

  it('estimateOffsetForPeer without localRecvMs falls back to Date.now()', () => {
    // L84 `?? Date.now()` — third arg omitted.
    const before = Date.now();
    const offset = comp.estimateOffsetForPeer('node-2', before);
    expect(typeof offset).toBe('number');
  });

  it('sliding window shifts when samples exceed sampleWindowSize', () => {
    // L225/226/227 — record more than the default 10 samples for one peer.
    const many = 15;
    for (let i = 0; i < many; i++) {
      comp.estimateOffsetForPeer('node-1', 1000 + i, 1010 + i);
    }
    // Internal samples array should be capped at sampleWindowSize (10)
    const state = (comp as any).peerOffsets.get('node-1');
    expect(state.samples.length).toBeLessThanOrEqual(10);
  });
});
