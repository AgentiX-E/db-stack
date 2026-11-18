/**
 * Convergence, tested as a primitive.
 *
 * Why this file exists
 * --------------------
 * `Benchmark (cluster, real 3-node mTLS)` failed on CI run 44225232372 with
 * `expected [ null, 2, null ] to deeply equal [ 2, 2, 2 ]` immediately after
 * `cluster.findLeader()` resolved. That is not a flake and not a product bug: it
 * is a provable race in the assertion. `findLeader()` polls `isLeader()`, and
 * raft-core sets `state = Leader` and `currentLeader = self` *before* it appends
 * the no-op entry and sends the first heartbeat — so at the instant `findLeader()`
 * returns, no follower can possibly have been told who the leader is. The test
 * asserted a convergent property (every node eventually names the leader) at an
 * instant when convergence is guaranteed **not** to have happened yet.
 *
 * The same defect appeared elsewhere as a fixed `await sleep(2000)` with the
 * comment "give some time for leader info to propagate" — a guess in place of a
 * bound. Both are the same mistake: waiting by hoping rather than waiting on the
 * property, with a deadline.
 *
 * So the wait becomes an object with a contract that can be tested without a
 * cluster: read, decide, sleep, and give up only at a deadline, reporting what was
 * actually observed. These cases pin that contract, with an injected clock and an
 * injected sleep so the answers are exact and the suite takes microseconds.
 *
 * Acceptance criteria:
 *   AC 45.1  the first accepted value is returned with the attempt count and elapsed time
 *   AC 45.2  the first read happens even when the budget is already spent
 *   AC 45.3  a read that throws is retried, and the error survives into the failure
 *   AC 45.4  sleeps happen only between attempts, with the configured interval
 *   AC 45.5  no sleep is started after the deadline has passed
 *   AC 45.6  a read started inside the budget counts even if it finishes after
 *   AC 45.7  the interval defaults to 50 ms
 *   AC 45.8  the failure names the label, the attempts, the budget and the last sighting
 *   AC 45.9  a value that cannot be serialised is described, not thrown on
 *   AC 45.10 a long observation is truncated to one readable line
 *   AC 45.11 an unserialisable absence is described as its string form
 *   AC 46.1  agreement is returned once every reader reports the same value
 *   AC 46.2  a lagging reader defers acceptance to a later round instead of failing
 *   AC 46.3  a value the caller rejects is not accepted even when all readers agree
 *   AC 46.4  the readers of a round are read concurrently
 *   AC 46.5  a rejected reader is retried, and its reason is reported on timeout
 *   AC 46.6  persistent disagreement fails with the values that were observed
 *   AC 46.7  a group with no readers never counts as agreeing
 *   AC 46.8  a caller-supplied equality accepts structurally equal readings
 *   AC 46.9  without one, readings are compared by identity
 */

import { describe, it, expect } from 'vitest';
import { pollUntil, awaitAgreement, ConvergenceTimeoutError } from '../../testing/convergence';

/** A clock the test advances by hand, so deadlines are exact and nothing sleeps. */
function manualClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe('pollUntil', () => {
  it('AC 45.1 — returns the first accepted value with its attempt count and elapsed time', async () => {
    const clock = manualClock();
    const seen: string[] = [];
    const answers = ['no', 'no', 'yes'];

    const result = await pollUntil(
      async () => {
        const next = answers[seen.length]!;
        seen.push(next);
        clock.advance(7);
        return next;
      },
      (value) => value === 'yes',
      { timeoutMs: 10_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );

    expect(result.value).toBe('yes');
    expect(result.attempts).toBe(3);
    // Wall time, not work time: three reads of 7 ms plus the two 100 ms gaps
    // between them. A wait is reported by what it cost the caller.
    expect(result.elapsedMs).toBe(221);
    expect(seen).toEqual(['no', 'no', 'yes']);
  });

  it('AC 45.2 — the first read happens even when the budget is already spent', async () => {
    let reads = 0;

    // A zero budget bounds waiting, it does not forbid looking. A check that is
    // skipped because the deadline was already reached reports "not converged"
    // about a property nobody read.
    await expect(
      pollUntil(
        async () => {
          reads++;
          return 'no';
        },
        () => false,
        { timeoutMs: 0, intervalMs: 50, now: () => 0, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ConvergenceTimeoutError);

    expect(reads).toBe(1);
  });

  it('AC 45.3 — a read that throws is retried, and the error survives into the failure', async () => {
    const clock = manualClock();
    const boom = new Error('peer socket closed');

    const error = await pollUntil<string>(
      async () => {
        throw boom;
      },
      () => true,
      { timeoutMs: 250, intervalMs: 100, label: 'a readable peer', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    const failure = error as ConvergenceTimeoutError;
    expect(failure.attempts).toBeGreaterThan(1);
    expect(failure.lastError).toBe(boom);
    expect(failure.message).toContain('peer socket closed');
  });

  it('AC 45.4 — sleeps happen only between attempts, with the configured interval', async () => {
    const clock = manualClock();
    let reads = 0;

    await pollUntil(
      async () => ++reads,
      () => false,
      { timeoutMs: 300, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    ).catch(() => undefined);

    // Reads at t=0, 100, 200, 300 → four attempts, three gaps between them, and the
    // fourth gap is refused because the deadline has passed.
    expect(reads).toBe(4);
    expect(clock.sleeps).toEqual([100, 100, 100]);
  });

  it('AC 45.5 — no sleep is started after the deadline has passed', async () => {
    const clock = manualClock();
    const sleeps: number[] = [];

    await pollUntil(
      async () => {
        clock.advance(400); // the read itself overruns the 250 ms budget
        return 'no';
      },
      () => false,
      {
        timeoutMs: 250,
        intervalMs: 100,
        now: clock.now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    ).catch(() => undefined);

    // The overrunning read is the last one: paying a full extra interval after the
    // deadline is how a "250 ms" wait becomes a 350 ms one.
    expect(sleeps).toEqual([]);
  });

  it('AC 45.6 — a read started inside the budget counts even if it finishes after', async () => {
    const clock = manualClock();
    let reads = 0;

    const result = await pollUntil(
      async () => {
        reads++;
        clock.advance(1_000); // RPC that outlives the whole budget
        return 'converged';
      },
      (value) => value === 'converged',
      { timeoutMs: 50, intervalMs: 10, now: clock.now, sleep: clock.sleep },
    );

    expect(result.value).toBe('converged');
    expect(result.attempts).toBe(1);
    expect(reads).toBe(1);
  });

  it('AC 45.7 — the interval defaults to 50 ms', async () => {
    const clock = manualClock();

    await pollUntil(
      async () => 'no',
      () => false,
      { timeoutMs: 100, now: clock.now, sleep: clock.sleep },
    ).catch(() => undefined);

    expect(clock.sleeps).toEqual([50, 50]);
  });

  it('AC 45.8 — the failure names the label, the attempts, the budget and the last sighting', async () => {
    const clock = manualClock();

    const error = (await pollUntil(
      async () => ({ leader: null }),
      (value) => value.leader !== null,
      { timeoutMs: 100, intervalMs: 100, label: 'the cluster to agree', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error.name).toBe('ConvergenceTimeoutError');
    expect(error.message).toContain('the cluster to agree');
    expect(error.message).toContain('100ms');
    expect(error.message).toContain('attempts=2');
    // The observed value, verbatim: "it timed out" cannot distinguish a stale
    // follower from a leader that never sent anything.
    expect(error.message).toContain('{"leader":null}');
    expect(error.label).toBe('the cluster to agree');
    expect(error.timeoutMs).toBe(100);
  });

  it('AC 45.9 — a value that cannot be serialised is described rather than thrown on', async () => {
    const clock = manualClock();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Building a failure message must not become a second failure: JSON.stringify
    // throws on a cycle, and a wait that dies while explaining itself reports the
    // wrong error.
    const error = (await pollUntil(
      async () => circular,
      () => false,
      { timeoutMs: 0, label: 'a cycle', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('[object Object]');
  });

  it('AC 45.10 — a long observation is truncated to one readable line', async () => {
    const clock = manualClock();

    const error = (await pollUntil(
      async () => 'x'.repeat(600),
      () => false,
      { timeoutMs: 0, label: 'a long value', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    // A state dump belongs in a log, not in an assertion message: the observation is
    // cut, and the cut is visible.
    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(600);
  });

  it('AC 45.11 — an unserialisable absence is described as its string form', async () => {
    const clock = manualClock();

    // `JSON.stringify(undefined)` is `undefined`, not a string: the `??` is what keeps
    // the message from rendering "undefined" by accident of concatenation.
    const error = (await pollUntil(
      async () => undefined,
      () => false,
      { timeoutMs: 0, label: 'nothing at all', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('last observed: undefined');
  });

  it('AC 45.12 — the real clock and the real sleep are what a caller gets by omission', async () => {
    let reads = 0;

    // No `now`, no `sleep`: this is the path every production caller takes, and it
    // has to be a real wait rather than an injected one. A one-millisecond budget with
    // a zero interval is long enough for at least two attempts and short enough to
    // keep the suite instant.
    const error = (await pollUntil(
      async () => {
        reads++;
        return 'no';
      },
      () => false,
      { timeoutMs: 1, intervalMs: 0, label: 'the real clock' },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(error.attempts).toBeGreaterThanOrEqual(2);
  });

  it('AC 45.13 — a reader that throws something other than an Error is still quoted', async () => {
    const clock = manualClock();

    // Not every rejection is an Error: a transport can reject with a string, and a
    // failure message that renders "undefined" for it loses the only diagnostic there.
    const error = (await pollUntil(
      async () => {
        throw 'peer 3 is unreachable';
      },
      () => true,
      { timeoutMs: 0, label: 'a string rejection', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('peer 3 is unreachable');
  });
});

describe('awaitAgreement', () => {
  it('AC 46.1 — agreement is returned once every reader reports the same value', async () => {
    const clock = manualClock();
    const rounds = new Map<number, number>();

    const readers = [0, 1, 2].map((id) => async () => {
      const round = (rounds.get(id) ?? 0) + 1;
      rounds.set(id, round);
      // Reader 2 learns one round later than the others, which is exactly the
      // shape CI observed: [ null, 2, null ].
      return id === 2 && round === 1 ? null : 7;
    });

    const result = await awaitAgreement(readers, {
      timeoutMs: 1_000,
      intervalMs: 100,
      require: (value) => value !== null,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.value).toEqual([7, 7, 7]);
    expect(result.attempts).toBe(2);
  });

  it('AC 46.2 — a lagging reader defers acceptance to a later round instead of failing', async () => {
    const clock = manualClock();
    let round = 0;

    const readers = [
      async () => 4,
      async () => {
        round++;
        return round >= 3 ? 4 : null;
      },
    ];

    const result = await awaitAgreement(readers, {
      timeoutMs: 10_000,
      intervalMs: 25,
      require: (value) => value !== null,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.value).toEqual([4, 4]);
    expect(result.attempts).toBe(3);
    expect(clock.sleeps).toEqual([25, 25]);
  });

  it('AC 46.3 — a value the caller rejects is not accepted even when all readers agree', async () => {
    const clock = manualClock();

    const error = (await awaitAgreement([async () => null, async () => null], {
      timeoutMs: 50,
      intervalMs: 50,
      require: (value) => value !== null,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('[null,null]');
  });

  it('AC 46.4 — the readers of a round are read concurrently', async () => {
    const clock = manualClock();
    let started = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reader = async (value: number) => {
      started++;
      if (started === 2) release();
      // Resolves only when the sibling has also started: a sequential loop would
      // hang here instead of converging, which is the property being pinned.
      await both;
      return value;
    };

    const result = await awaitAgreement([() => reader(1), () => reader(1)], {
      timeoutMs: 1_000,
      intervalMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.value).toEqual([1, 1]);
    expect(started).toBe(2);
  });

  it('AC 46.5 — a rejected reader is retried, and its reason is reported on timeout', async () => {
    const clock = manualClock();
    const down = new Error('node 3 did not answer getLeader within 500 ms');

    const error = (await awaitAgreement(
      [
        async () => 2,
        async () => {
          throw down;
        },
      ],
      { timeoutMs: 100, intervalMs: 100, label: 'leader agreement', now: clock.now, sleep: clock.sleep },
    ).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.lastError).toBe(down);
    expect(error.message).toContain('node 3 did not answer');
  });

  it('AC 46.6 — persistent disagreement fails with the values that were observed', async () => {
    const clock = manualClock();

    const error = (await awaitAgreement([async () => 2, async () => 3, async () => 2], {
      timeoutMs: 100,
      intervalMs: 100,
      label: 'one leader',
      now: clock.now,
      sleep: clock.sleep,
    }).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('one leader');
    expect(error.message).toContain('[2,3,2]');
  });

  it('AC 46.7 — a group with no readers never counts as agreeing', async () => {
    // A cluster that lost every node must not be reported as unanimous. The wait
    // still honours its budget and reports the empty observation.
    const clock = manualClock();

    const error = (await awaitAgreement<number>([], {
      timeoutMs: 0,
      intervalMs: 100,
      label: 'one leader',
      now: clock.now,
      sleep: clock.sleep,
    }).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.message).toContain('[]');
    expect(error.attempts).toBe(1);
  });

  it('AC 46.8 — a caller-supplied equality accepts structurally equal readings', async () => {
    const clock = manualClock();

    // Two nodes reporting the same leader in the same term are in agreement even
    // though their readings are two different objects.
    const result = await awaitAgreement([async () => ({ leader: 2, term: 4 }), async () => ({ leader: 2, term: 4 })], {
      timeoutMs: 1_000,
      intervalMs: 100,
      equal: (left, right) => left.leader === right.leader && left.term === right.term,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.value).toEqual([
      { leader: 2, term: 4 },
      { leader: 2, term: 4 },
    ]);
    expect(result.attempts).toBe(1);
  });

  it('AC 46.9 — without that equality, readings are compared by identity', async () => {
    const clock = manualClock();

    // The default is deliberately not structural: silently deciding that two
    // records "look the same" would let a group agree on a summary while the values
    // behind it differ. Callers that read records must say what sameness means.
    const error = (await awaitAgreement([async () => ({ leader: 2 }), async () => ({ leader: 2 })], {
      timeoutMs: 0,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((err: unknown) => err)) as ConvergenceTimeoutError;

    expect(error).toBeInstanceOf(ConvergenceTimeoutError);
    expect(error.attempts).toBe(1);
  });
});
