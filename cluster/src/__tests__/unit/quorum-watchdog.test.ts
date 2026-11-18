/**
 * Who has answered this node lately, and what that is worth.
 *
 * Why this file exists
 * --------------------
 * raft-core 0.2.1 implements no check-quorum. A leader that has lost contact with
 * its majority keeps `isLeader() === true` forever: measured on 2026-11-18 with two
 * of three nodes killed, still true at 16 s, commit index frozen at 1, and the next
 * write refused only after 5 028 ms. Nothing unsafe happens — a majority is still
 * required to commit — but a client that routes by `isLeader()` keeps sending work
 * to a node that cannot serve it, and discovers that one request timeout later.
 *
 * The evidence for "I still have a majority" is a completed round trip: the peer's
 * transport answered. So the watchdog is a record of those moments, and `hasQuorum`
 * is arithmetic over the record. There is no timer and no background loop: the
 * answer is computed when it is asked for, which means there is nothing to leak,
 * nothing to restart, and no clock drift between a watchdog and the clock that
 * evaluates it.
 *
 * Acceptance criteria:
 *   AC 48.1  a majority is floor(size / 2) + 1 for one to seven members
 *   AC 48.2  in three members one peer answer inside the window is a quorum
 *   AC 48.3  an answer older than the window stops counting
 *   AC 48.4  in five members two peer answers are needed, and one is not enough
 *   AC 48.5  a single member is always a quorum: the case that must not deadlock
 *   AC 48.6  a peer outside the member set is not counted, because a learner's answer is not a vote
 *   AC 48.7  unheardPeers names the peers that are silent or stale
 *   AC 48.8  nothing heard yet is not a quorum
 *   AC 48.9  reset forgets everything, so a restarted node inherits no stale evidence
 *   AC 48.10 a clock that goes backwards never invents staleness
 *   AC 48.11 a window that is not a positive number is refused at construction
 *   AC 48.12 a later answer replaces an earlier one instead of being added to it
 *   AC 48.13 an observation can be recorded at an explicit moment, and the observer reports its own id
 *   AC 48.14 the window is readable, so a caller can print the budget it is judged against
 *   AC 48.15 a member list that repeats this node does not count it twice
 */

import { describe, expect, it } from 'vitest';
import { QuorumWatchdog } from '../../consensus/core/QuorumWatchdog';

function watchdog(peers: number[], windowMs = 1_000) {
  let t = 10_000;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (value: number) => {
      t = value;
    },
  };
  return { clock, watchdog: new QuorumWatchdog({ selfId: 1, peers, windowMs, now: clock.now }) };
}

describe('QuorumWatchdog', () => {
  it('AC 48.1 — a majority is floor(size / 2) + 1 for one to seven members', () => {
    const expected = [1, 2, 2, 3, 3, 4, 4]; // 1..7 members
    expected.forEach((majority, index) => {
      const peers = Array.from({ length: index }, (_, peer) => peer + 2);
      const { watchdog: subject } = watchdog(peers);
      expect(subject.majority).toBe(majority);
      expect(subject.size).toBe(index + 1);
    });
  });

  it('AC 48.2 — in three members one peer answer inside the window is a quorum', () => {
    const { clock, watchdog: subject } = watchdog([2, 3]);

    expect(subject.hasQuorum()).toBe(false); // nothing heard yet
    subject.observe(2);
    expect(subject.hasQuorum()).toBe(true);

    clock.advance(999);
    expect(subject.hasQuorum()).toBe(true);
  });

  it('AC 48.3 — an answer older than the window stops counting', () => {
    const { clock, watchdog: subject } = watchdog([2, 3]);

    subject.observe(2);
    clock.advance(1_000);
    // One election timeout of silence from every peer is exactly the definition of a
    // leader that can no longer serve: at this point raft-core's own followers have
    // started an election.
    expect(subject.hasQuorum()).toBe(false);
  });

  it('AC 48.4 — in five members two peer answers are needed, and one is not enough', () => {
    const { watchdog: subject } = watchdog([2, 3, 4, 5]);

    subject.observe(2);
    expect(subject.hasQuorum()).toBe(false);
    subject.observe(4);
    expect(subject.hasQuorum()).toBe(true);
  });

  it('AC 48.5 — a single member is always a quorum', () => {
    // A one-node cluster has no peer to hear from. Requiring one would make it
    // permanently non-leader, which is why this case is stated rather than derived.
    const { watchdog: subject } = watchdog([]);

    expect(subject.majority).toBe(1);
    expect(subject.hasQuorum()).toBe(true);
  });

  it('AC 48.6 — a peer outside the member set is not counted', () => {
    // raft-core learns about non-voting servers, and a follower's answer arrives
    // through the same transport. Counting a learner would let a leader claim a
    // majority it does not have.
    const { watchdog: subject } = watchdog([2, 3]);

    subject.observe(4);
    subject.observe(5);
    expect(subject.hasQuorum()).toBe(false);
    expect(subject.unheardPeers()).toEqual([2, 3]);
  });

  it('AC 48.7 — unheardPeers names the peers that are silent or stale', () => {
    const { clock, watchdog: subject } = watchdog([2, 3, 4]);

    subject.observe(2);
    clock.advance(400);
    subject.observe(3);
    clock.advance(700);

    // Peer 2's answer is 1 100 ms old and peer 4 never answered, so four members hear
    // from two: one answer short of the three a majority of four needs.
    expect(subject.unheardPeers()).toEqual([2, 4]);
    expect(subject.hasQuorum()).toBe(false);
  });

  it('AC 48.8 — nothing heard yet is not a quorum', () => {
    const { watchdog: subject } = watchdog([2, 3, 4, 5]);

    expect(subject.hasQuorum()).toBe(false);
    expect(subject.unheardPeers()).toEqual([2, 3, 4, 5]);
  });

  it('AC 48.9 — reset forgets everything, so a restarted node inherits no stale evidence', () => {
    const { watchdog: subject } = watchdog([2, 3]);

    subject.observe(2);
    expect(subject.hasQuorum()).toBe(true);
    subject.reset();
    expect(subject.hasQuorum()).toBe(false);
    expect(subject.unheardPeers()).toEqual([2, 3]);
  });

  it('AC 48.10 — a clock that goes backwards never invents staleness', () => {
    const { clock, watchdog: subject } = watchdog([2, 3]);

    subject.observe(2);
    clock.set(5_000); // a wall-clock step backwards, not a rewind of time
    expect(subject.hasQuorum()).toBe(true);
  });

  it('AC 48.11 — a window that is not a positive number is refused at construction', () => {
    // A zero window would demote a healthy leader on every call, and a NaN window
    // would silently never expire. Both are configuration errors, not states.
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new QuorumWatchdog({ selfId: 1, peers: [2], windowMs })).toThrow(/windowMs/);
    }
  });

  it('AC 48.13 — an observation can be recorded at an explicit moment, and the observer reports its own id', () => {
    // The explicit timestamp is what lets a transport hand over the moment a round
    // trip completed rather than the moment the record was written; the two differ by
    // whatever the caller did in between.
    const { clock, watchdog: subject } = watchdog([2, 3]);

    subject.observe(2, clock.now() - 900);
    expect(subject.hasQuorum()).toBe(true);
    clock.advance(200);
    expect(subject.hasQuorum()).toBe(false);
    expect(subject.id).toBe(1);
  });

  it('AC 48.15 — a member list that repeats this node does not count it twice', () => {
    // `config.peers` is meant to exclude self, and one caller passing the whole
    // member list would otherwise hand this node two votes.
    const { watchdog: subject } = watchdog([1, 2, 3]);

    expect(subject.size).toBe(3);
    expect(subject.majority).toBe(2);
    subject.observe(2);
    expect(subject.hasQuorum()).toBe(true);
    expect(subject.unheardPeers()).toEqual([3]);
  });

  it('AC 48.14 — the window is readable, so a caller can print the budget it is judged against', () => {
    const { watchdog: subject } = watchdog([2], 1_234);

    expect(subject.window).toBe(1_234);
    expect(subject.size).toBe(2);
  });

  it('AC 48.12 — a later answer replaces an earlier one instead of being added to it', () => {
    const { clock, watchdog: subject } = watchdog([2, 3]);

    subject.observe(2);
    clock.advance(800);
    subject.observe(2);
    clock.advance(400);

    // 1 200 ms after the first answer and 400 ms after the second: still heard.
    expect(subject.hasQuorum()).toBe(true);
    expect(subject.unheardPeers()).toEqual([3]);
  });
});
