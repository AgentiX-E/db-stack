/**
 * The measurement the boundary suites assert on, tested as a measurement.
 *
 * `retainedHeapMB()` exists because a `heapUsed` delta is not what a test means
 * by "no memory leak": it reports allocation that the collector had not got to
 * yet, so it moves with GC timing. The pair of cases below is the distinction
 * made executable — the *same* allocation volume, dropped versus kept, must give
 * opposite answers. If the helper ever degrades into an allocation delta, the
 * dropped case is the one that fails, and that is the point: a heap assertion
 * that cannot tell the two apart is not an assertion about the product.
 */

import { describe, it, expect } from 'vitest';

import { retainedGrowthBudgetMB, retainedHeapMB } from '../support/retainedHeap';

/** A block large enough that V8 must place it in the old generation. */
const BLOCK_ELEMENTS = 3 * 1024 * 1024;

const sink: { blocks: number[][]; touched: number } = { blocks: [], touched: 0 };

function fillBlock(): number[] {
  const block = new Array<number>(BLOCK_ELEMENTS).fill(0.5);
  // Read an element back, so the allocation cannot be treated as dead merely
  // because its contents are never observed.
  sink.touched = block[1] ?? 0;
  return block;
}

describe('retained heap sampling', () => {
  it('RH.1: reports memory that the caller keeps', () => {
    const before = retainedHeapMB();
    sink.blocks.push(fillBlock(), fillBlock());
    const growth = retainedHeapMB() - before;

    // 48 MB is held across the sample; the bound is loose enough to ignore
    // array headers and the collector's own bookkeeping, tight enough that a
    // sample which reports a fraction of it has failed.
    expect(growth).toBeGreaterThan(40);
  });

  it('RH.2: does not report memory the caller dropped', () => {
    const before = retainedHeapMB();
    // Four blocks allocated and discarded: 96 MB of allocation, nothing kept.
    for (let i = 0; i < 4; i++) fillBlock();
    const growth = retainedHeapMB() - before;

    expect(growth).toBeLessThan(8);
  });

  it('RH.3: consecutive samples of an unchanged workload agree', () => {
    sink.blocks.push(fillBlock());
    const first = retainedHeapMB();
    const second = retainedHeapMB();

    // Without the forced collection this difference was the collector's
    // timing; with it, two samples of the same state differ by noise only.
    expect(Math.abs(second - first)).toBeLessThan(2);
  });

  it('RH.4: returns megabytes, not bytes', () => {
    const sample = retainedHeapMB();
    // A running test process keeps a few tens of MB: a byte count would be
    // four orders of magnitude larger, and a fraction-of-a-MB value would mean
    // the sample was divided twice.
    expect(sample).toBeGreaterThan(1);
    expect(sample).toBeLessThan(2048);
  });

  it('RH.5: the growth budget scales with the work the case asks for', () => {
    // A case that writes nothing still has a floor, and each proposal adds to
    // it: the same property — retention per proposal — at every volume.
    expect(retainedGrowthBudgetMB(0)).toBe(8);
    expect(retainedGrowthBudgetMB(40_000)).toBeGreaterThan(retainedGrowthBudgetMB(10_000));
    const perProposalKB = ((retainedGrowthBudgetMB(10_000) - retainedGrowthBudgetMB(0)) / 10_000) * 1024;
    expect(perProposalKB).toBeCloseTo(2, 3);

    // The reference run retains 5.7 MB over 10 000 proposals. A budget must sit
    // clear of that by more than a runner's worth of difference, or the case is
    // a coin toss rather than an assertion.
    expect(retainedGrowthBudgetMB(10_000)).toBeGreaterThan(5.7 * 3);
  });
});
