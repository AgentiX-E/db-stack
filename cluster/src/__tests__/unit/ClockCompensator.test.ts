/**
 * ClockCompensator Unit Tests
 *
 * Iteration 18 — Cross-DC clock offset estimation for failover decisions.
 *
 * ClockCompensator estimates clock skew between this node and peers using
 * one-way delay approximation with EMA smoothing. Provides safety margins
 * for cross-datacenter election timeout adjustments.
 *
 * Acceptance Criteria:
 *   AC 18.1: Constructor accepts optional config
 *   AC 18.2: estimateOffset computes one-way delay approximation
 *   AC 18.3: estimateOffsetForPeer records per-peer EMA offset
 *   AC 18.4: synchronized returns true when no peers tracked
 *   AC 18.5: synchronized returns true when offsets within threshold
 *   AC 18.6: synchronized returns false when offsets exceed threshold
 *   AC 18.7: getPeerOffset returns EMA offset for peer
 *   AC 18.8: getMaxAbsOffset returns worst-case absolute offset
 *   AC 18.9: getSafetyMargin returns maxAbsOffset + 50 (min 100)
 *   AC 18.10: toLocalTime corrects remote timestamp by EMA offset
 *   AC 18.11: toRemoteTime corrects local timestamp by EMA offset
 *   AC 18.12: recordNtpSync tracks drift and increments counter
 *   AC 18.13: reset clears all peer state
 *   AC 18.14: setConfig updates config at runtime
 *   AC 18.15: getConfig returns current config copy
 *   AC 18.16: getPeerOffsetsSummary returns peer offset map
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClockCompensator } from '../../ha/ClockCompensator';

describe('ClockCompensator - Unit', () => {
  let comp: ClockCompensator;

  beforeEach(() => {
    comp = new ClockCompensator();
  });

  //
  // AC 18.1: Constructor accepts optional config
  //
  it('AC 18.1: Constructor accepts optional config', () => {
    const c1 = new ClockCompensator();
    expect(c1).toBeInstanceOf(ClockCompensator);

    const c2 = new ClockCompensator({ maxAllowedOffsetMs: 1000 });
    expect(c2.getConfig().maxAllowedOffsetMs).toBe(1000);
  });

  //
  // AC 18.2: estimateOffset computes approximation
  //
  it('AC 18.2: estimateOffset computes one-way delay approximation', () => {
    // If remote sent timestamp=1000 and we received at local=1010,
    // oneWayDelay = (1010-1000)/2 = 5, offset = 1000 - 1010 + 5 = -5
    const offset = comp.estimateOffset(1000, 1010);
    expect(offset).toBe(-5);
  });

  //
  // AC 18.3: estimateOffsetForPeer records per-peer EMA
  //
  it('AC 18.3: estimateOffsetForPeer records per-peer EMA', () => {
    const offset1 = comp.estimateOffsetForPeer('node-2', 1000, 1010);
    // First offset: -5, EMA alpha=0.3 -> ema = 0.3*(-5) + 0 = -1.5
    expect(typeof offset1).toBe('number');

    // Second sample
    const offset2 = comp.estimateOffsetForPeer('node-2', 2000, 2008);
    // oneWayDelay = (2008-2000)/2 = 4, offset = 2000 - 2008 + 4 = -4
    // EMA: 0.3*(-4) + 0.7*(-1.5) = -1.2 + -1.05 = -2.25
    expect(typeof offset2).toBe('number');

    // Peer should have tracked samples
    const stored = comp.getPeerOffset('node-2');
    expect(stored).not.toBe(0);
  });

  //
  // AC 18.4: synchronized returns true when no peers tracked
  //
  it('AC 18.4: synchronized returns true with no peers', () => {
    expect(comp.synchronized()).toBe(true);
  });

  //
  // AC 18.5: synchronized returns true when offsets within threshold
  //
  it('AC 18.5: synchronized returns true when within threshold', () => {
    // Small offsets (within default 500ms threshold)
    comp.estimateOffsetForPeer('node-2', Date.now(), Date.now());
    // Local + remote timestamps close together -> small offset
    expect(comp.synchronized()).toBe(true);
  });

  //
  // AC 18.6: synchronized returns false when offset exceeds threshold
  //
  it('AC 18.6: synchronized returns false when offset exceeds threshold', () => {
    // Create compensator with tight threshold
    const tight = new ClockCompensator({ maxAllowedOffsetMs: 10 });
    // Simulate large clock skew
    tight.estimateOffsetForPeer('node-2', 1000, 2000);
    expect(tight.synchronized()).toBe(false);
  });

  //
  // AC 18.7: getPeerOffset returns EMA offset
  //
  it('AC 18.7: getPeerOffset returns EMA offset for peer', () => {
    expect(comp.getPeerOffset('unknown')).toBe(0);
    comp.estimateOffsetForPeer('node-2', 1000, 1010);
    expect(comp.getPeerOffset('node-2')).not.toBe(0);
  });

  //
  // AC 18.8: getMaxAbsOffset returns worst-case absolute offset
  //
  it('AC 18.8: getMaxAbsOffset returns worst-case', () => {
    expect(comp.getMaxAbsOffset()).toBe(0);
    comp.estimateOffsetForPeer('node-2', 1000, 1050);
    // offset = 1000 - 1050 + 25 = -25, abs = 25
    const maxAbs = comp.getMaxAbsOffset();
    expect(maxAbs).toBeGreaterThan(0);
    expect(maxAbs).toBeLessThan(100);
  });

  //
  // AC 18.9: getSafetyMargin returns maxAbsOffset + 50 (min 100)
  //
  it('AC 18.9: getSafetyMargin returns computed margin', () => {
    // No peers -> maxAbsOffset=0 -> returns max(100, 0+50) = 100
    expect(comp.getSafetyMargin()).toBe(100);

    // With peers -> maxAbs + 50, but min 100
    comp.estimateOffsetForPeer('node-2', 1000, 1050);
    const margin = comp.getSafetyMargin();
    // Should be at least the minimum (100) since maxAbs is small
    expect(margin).toBe(100);
  });

  //
  // AC 18.10: toLocalTime corrects remote timestamp
  //
  it('AC 18.10: toLocalTime corrects remote timestamp', () => {
    // Positive offset means peer clock ahead -> subtract when converting to local
    comp.estimateOffsetForPeer('node-2', 1100, 1000);
    // offset = 1100 - 1000 + (-50) = 50 (peer ahead)
    const remoteTs = 2000;
    const localTs = comp.toLocalTime('node-2', remoteTs);
    expect(localTs).toBeLessThan(remoteTs); // Peer ahead, so local is behind
  });

  //
  // AC 18.11: toRemoteTime corrects local timestamp
  //
  it('AC 18.11: toRemoteTime corrects local timestamp', () => {
    comp.estimateOffsetForPeer('node-2', 1100, 1000);
    const localTs = 1000;
    const remoteTs = comp.toRemoteTime('node-2', localTs);
    expect(remoteTs).toBeGreaterThan(localTs); // Peer ahead
  });

  //
  // AC 18.12: recordNtpSync tracks drift
  //
  it('AC 18.12: recordNtpSync tracks drift and increments counter', () => {
    expect(comp.getNtpSyncCount()).toBe(0);
    comp.recordNtpSync(1000);
    expect(comp.getNtpSyncCount()).toBe(1);
    comp.recordNtpSync(2000);
    expect(comp.getNtpSyncCount()).toBe(2);
  });

  //
  // AC 18.13: reset clears all peer state
  //
  it('AC 18.13: reset clears all peer state', () => {
    comp.estimateOffsetForPeer('node-2', 1000, 1010);
    comp.recordNtpSync(500);
    expect(comp.getPeerOffset('node-2')).not.toBe(0);
    expect(comp.getNtpSyncCount()).toBe(1);

    comp.reset();
    expect(comp.getPeerOffset('node-2')).toBe(0);
    expect(comp.getNtpSyncCount()).toBe(0);
    expect(comp.getMaxAbsOffset()).toBe(0);
  });

  //
  // AC 18.14: setConfig updates config at runtime
  //
  it('AC 18.14: setConfig updates config at runtime', () => {
    comp.setConfig({ maxAllowedOffsetMs: 2000, emaAlpha: 0.5 });
    const config = comp.getConfig();
    expect(config.maxAllowedOffsetMs).toBe(2000);
    expect(config.emaAlpha).toBe(0.5);
  });

  //
  // AC 18.15: getConfig returns config copy
  //
  it('AC 18.15: getConfig returns config copy', () => {
    const config = comp.getConfig();
    config.maxAllowedOffsetMs = 9999;
    // Original should be unchanged
    expect(comp.getConfig().maxAllowedOffsetMs).not.toBe(9999);
  });

  //
  // AC 18.16: getPeerOffsetsSummary returns peer offset map
  //
  it('AC 18.16: getPeerOffsetsSummary returns peer offset map', () => {
    expect(comp.getPeerOffsetsSummary()).toEqual({});
    comp.estimateOffsetForPeer('node-2', 1000, 1010);
    comp.estimateOffsetForPeer('node-3', 2000, 2008);
    const summary = comp.getPeerOffsetsSummary();
    expect(Object.keys(summary)).toContain('node-2');
    expect(Object.keys(summary)).toContain('node-3');
  });
});
