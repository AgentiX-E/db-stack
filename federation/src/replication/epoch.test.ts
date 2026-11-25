/**
 * IncarnationLedger — which incarnation of each peer this node has heard from.
 *
 * The failure this exists for is not a crash. A datacenter is rebuilt, rolled
 * back or re-keyed, and a frame that was in flight from the *previous*
 * incarnation arrives afterwards: it carries a change the rebuild has since
 * undone, and nothing on the wire distinguishes it from a change that happened
 * after the rebuild. The key comes back. The ledger is the receiver's memory of
 * incarnations, so "older than what I have already seen" is a fact about the
 * frame rather than a guess about the clock.
 *
 *   EP.1  the first epoch from a peer is current, and is remembered
 *   EP.2  the same epoch again is current, and changes nothing
 *   EP.3  a higher epoch is the peer rebuilt, and raises the watermark
 *   EP.4  a lower epoch is refused, and the watermark does not move back
 *   EP.5  the numbers are per peer: two peers count independently
 *   EP.6  a frame with no epoch is unnameable, and is not a refusal
 *   EP.7  the refusal names the peer and both epochs
 *   EP.8  the status is a shape a status page can print
 *   EP.9  a non-finite epoch is unnameable rather than "newer"
 */

import { describe, it, expect } from 'vitest';
import { IncarnationLedger } from './epoch';

describe('IncarnationLedger — a frame is from an incarnation, not from a node id', () => {
  it('EP.1 — the first epoch from a peer is current, and is remembered', () => {
    const ledger = new IncarnationLedger();

    expect(ledger.assess('dc-west', 1_700_000_000_000)).toBe('current');
    expect(ledger.watermarkOf('dc-west')).toBe(1_700_000_000_000);
  });

  it('EP.2 — the same epoch again is current, and changes nothing', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 10);

    expect(ledger.assess('dc-west', 10)).toBe('current');
    expect(ledger.assess('dc-west', 10)).toBe('current');
    // A steady state is not an event: the counters operators read stay quiet.
    expect(ledger.getStatus()).toEqual({ peers: { 'dc-west': 10 }, refused: 0, advanced: 0, epochless: 0 });
  });

  it('EP.3 — a higher epoch is the peer rebuilt, and raises the watermark', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 10);

    // The rebuild is the truth going forward: refusing *it* would take the
    // datacenter out of service for being restored, which is the opposite of the
    // failure this exists to prevent.
    expect(ledger.assess('dc-west', 20)).toBe('newer');
    expect(ledger.watermarkOf('dc-west')).toBe(20);
    expect(ledger.getStatus().advanced).toBe(1);
  });

  it('EP.4 — a lower epoch is refused, and the watermark does not move back', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 20);
    ledger.assess('dc-west', 30);

    expect(ledger.assess('dc-west', 20)).toBe('stale');
    expect(ledger.assess('dc-west', 29)).toBe('stale');
    // The refused frames must not lower the bar for the next one: a stale frame
    // that moved the watermark would make every later frame stale too.
    expect(ledger.watermarkOf('dc-west')).toBe(30);
    expect(ledger.getStatus().refused).toBe(2);
  });

  it('EP.5 — the numbers are per peer: two peers count independently', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 100);
    ledger.assess('dc-east', 5);

    // Epochs are per node. A comparison against another node's number would read
    // as a clock comparison, which is what an epoch must not be.
    expect(ledger.assess('dc-east', 6)).toBe('newer');
    expect(ledger.assess('dc-west', 101)).toBe('newer');
    expect(ledger.assess('dc-east', 5)).toBe('stale');
  });

  it('EP.6 — a frame with no epoch is unnameable, and is not a refusal', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 40);

    // A peer running a build that predates the promise cannot name its
    // incarnation. Refusing it would turn the upgrade into an outage, and
    // accepting it silently would make the counter look healthy, so it is
    // accepted and counted.
    expect(ledger.assess('dc-west', undefined)).toBe('unnamed');
    expect(ledger.assess('dc-west', null)).toBe('unnamed');
    expect(ledger.assess('dc-new', undefined)).toBe('unnamed');
    expect(ledger.getStatus()).toEqual({ peers: { 'dc-west': 40 }, refused: 0, advanced: 0, epochless: 3 });
  });

  it('EP.7 — the refusal names the peer and both epochs', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 500);
    ledger.assess('dc-west', 100);

    const reason = ledger.refusalFor('dc-west', 100);
    // The whole sentence, not four fragments: this string is what an operator
    // reads in `lastError` on the sender, and a clause nobody asserts is a clause
    // a mutant can empty without a test noticing.
    expect(reason).toBe(
      'frame from dc-west is stamped with epoch 100, which is older than epoch 500 ' +
        'this node has already seen from that peer: an incarnation this node has moved ' +
        'past cannot write changes back into it',
    );
  });

  it('EP.8 — the status is a shape a status page can print', () => {
    const ledger = new IncarnationLedger();

    expect(ledger.getStatus()).toEqual({ peers: {}, refused: 0, advanced: 0, epochless: 0 });
    expect(ledger.watermarkOf('dc-nobody')).toBeNull();

    ledger.assess('dc-west', 7);
    // The returned object is a copy: a status page that mutated it would be
    // able to lower the watermark it is reporting.
    const status = ledger.getStatus();
    status.peers['dc-west'] = 0;
    expect(ledger.watermarkOf('dc-west')).toBe(7);
  });

  it('EP.9 — a non-finite epoch is unnameable rather than "newer"', () => {
    const ledger = new IncarnationLedger();
    ledger.assess('dc-west', 10);

    // `NaN > 10` is false and `NaN < 10` is false, so a comparison that trusted
    // arithmetic would answer "current" and let the frame through for ever.
    expect(ledger.assess('dc-west', Number.NaN)).toBe('unnamed');
    expect(ledger.assess('dc-west', Number.POSITIVE_INFINITY)).toBe('unnamed');
    expect(ledger.watermarkOf('dc-west')).toBe(10);
  });
});
