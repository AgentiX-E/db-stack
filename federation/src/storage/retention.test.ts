/**
 * Retention windows — the four numbers that must contain each other.
 *
 * The outbox has four windows and they were four constants in three files:
 * the dedup ring remembered a message id for 30 minutes (10 in the pipeline,
 * 1 by default), the retry budget was 60 seconds, the dead-letter queue kept an
 * entry for 7 days, and the delivery index was pruned at the entry TTL of 14
 * days. Nothing compared them, and the comparison is the whole point: a window
 * that is shorter than the thing it must cover is not a tuning choice, it is a
 * lost change.
 *
 *   RW.1   the defaults are the windows the product documents, and they are legal
 *   RW.2   the dedup window covers the retry budget plus the acknowledgement wait
 *   RW.3   the retry budget holds at least one backoff
 *   RW.4   nothing is widened to make a request legal
 *   RW.5   a disabled window (`0`) is legal where `0` means "nothing to keep"
 *   RW.6   the delivery index is the entry TTL, stated so the containment is visible
 *   RW.7   the first violation from the shortest window outward is the one reported
 *   RW.8   a violation names its rule and both numbers
 *   RW.9   a window that is not a duration is refused before it is compared
 *   RW.10  Infinity is a duration, and it is contagious in one direction
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, deriveRetention, RetentionViolation, type RetentionRequest } from './retention';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface LegalCase {
  name: string;
  request?: RetentionRequest;
  expected: Partial<Record<keyof RetentionRequest | 'deliveryIndexMs', number>>;
}

describe('deriveRetention — legal combinations', () => {
  const legal: LegalCase[] = [
    {
      name: 'the defaults',
      expected: {
        dedupMs: 30 * MINUTE,
        retryWindowMs: MINUTE,
        retryBackoffMaxMs: 2_000,
        deadLetterTtlMs: 7 * DAY,
        entryTtlMs: 14 * DAY,
        deliveryIndexMs: 14 * DAY,
      },
    },
    {
      name: 'no request at all is the same as an empty one',
      request: {},
      expected: { dedupMs: 30 * MINUTE, retryWindowMs: MINUTE },
    },
    {
      name: 'a longer retry budget with a dedup window that covers it',
      request: { retryWindowMs: 5 * MINUTE, dedupMs: 10 * MINUTE },
      expected: { retryWindowMs: 5 * MINUTE, dedupMs: 10 * MINUTE },
    },
    {
      name: 'a dedup window exactly as long as the budget and the ack wait',
      request: { retryWindowMs: 5 * MINUTE, ackTimeoutMs: 5 * MINUTE, dedupMs: 10 * MINUTE },
      expected: { dedupMs: 10 * MINUTE },
    },
    {
      name: 'a retry budget that dead-letters on the first failure, with no dedup',
      request: { retryWindowMs: 0, ackTimeoutMs: 0, dedupMs: 0 },
      expected: { retryWindowMs: 0, dedupMs: 0 },
    },
    {
      name: 'a disabled dead-letter queue and a legal budget',
      request: { deadLetterTtlMs: 0 },
      expected: { deadLetterTtlMs: 0, retryWindowMs: MINUTE },
    },
    {
      name: 'an entry TTL exactly at the budget',
      request: { retryWindowMs: 2 * MINUTE, entryTtlMs: 2 * MINUTE, dedupMs: 2 * MINUTE },
      expected: { entryTtlMs: 2 * MINUTE, deliveryIndexMs: 2 * MINUTE },
    },
    {
      // The entry TTL prunes delivered markers, not pending entries: a short
      // housekeeping cycle is a policy, not a containment.
      name: 'an entry TTL far shorter than the retry budget',
      request: { retryWindowMs: 10 * MINUTE, entryTtlMs: 1_000, dedupMs: 10 * MINUTE },
      expected: { entryTtlMs: 1_000, deliveryIndexMs: 1_000 },
    },
    {
      // The dead-letter clock starts after the budget is spent: sequential, not
      // nested.
      name: 'a dead-letter TTL far shorter than the retry budget',
      request: { retryWindowMs: 10 * MINUTE, deadLetterTtlMs: 1_000, dedupMs: 10 * MINUTE },
      expected: { deadLetterTtlMs: 1_000 },
    },
    {
      name: 'an unbounded budget with a receiver that never forgets',
      request: {
        retryWindowMs: Number.POSITIVE_INFINITY,
        dedupMs: Number.POSITIVE_INFINITY,
      },
      expected: {
        retryWindowMs: Number.POSITIVE_INFINITY,
        dedupMs: Number.POSITIVE_INFINITY,
      },
    },
  ];

  for (const item of legal) {
    it(item.name, () => {
      const windows = deriveRetention(item.request);
      for (const [key, value] of Object.entries(item.expected)) {
        expect(windows[key as keyof typeof windows], key).toBe(value);
      }
    });
  }

  it('RW.1: every documented default is a finite non-negative duration', () => {
    for (const [key, value] of Object.entries(DEFAULT_RETENTION)) {
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
  });

  it('RW.6: the delivery index is the entry TTL, so it covers the retry budget', () => {
    const windows = deriveRetention({ retryWindowMs: 3 * MINUTE, entryTtlMs: 9 * MINUTE });
    expect(windows.deliveryIndexMs).toBe(windows.entryTtlMs);
    expect(windows.deliveryIndexMs).toBeGreaterThanOrEqual(windows.retryWindowMs);
  });

  it('RW.6: a request may restate a derived window without changing it', () => {
    const once = deriveRetention({ retryWindowMs: 4 * MINUTE, entryTtlMs: 8 * MINUTE });
    const twice = deriveRetention({ ...once });
    expect(twice).toEqual(once);
  });

  it('RW.2: a derived set of windows is itself a legal request', () => {
    expect(() => deriveRetention(deriveRetention())).not.toThrow();
  });
});

interface IllegalCase {
  name: string;
  request: RetentionRequest;
  rule: string;
}

describe('deriveRetention — illegal combinations are refused', () => {
  const illegal: IllegalCase[] = [
    {
      name: 'a dedup window shorter than the retry budget',
      request: { retryWindowMs: 10 * MINUTE, dedupMs: 5 * MINUTE },
      rule: 'dedup-covers-retry',
    },
    {
      name: 'a dedup window that covers the budget but not the acknowledgement wait',
      request: { retryWindowMs: 5 * MINUTE, ackTimeoutMs: 5 * MINUTE, dedupMs: 6 * MINUTE },
      rule: 'dedup-covers-retry',
    },
    {
      name: 'a backoff ceiling longer than the budget that contains it',
      request: { retryWindowMs: 1_000, retryBackoffMaxMs: 2_000 },
      rule: 'retry-covers-backoff',
    },
    {
      name: 'an unbounded retry budget with a receiver that forgets',
      request: { retryWindowMs: Number.POSITIVE_INFINITY, dedupMs: 30 * MINUTE },
      rule: 'dedup-covers-retry',
    },
  ];

  for (const item of illegal) {
    it(item.name, () => {
      let caught: unknown;
      try {
        deriveRetention(item.request);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RetentionViolation);
      expect((caught as RetentionViolation).rule).toBe(item.rule);
    });
  }

  it('RW.7: the shortest broken containment is the one reported', () => {
    // Broken twice: the backoff is longer than the budget, and the budget is
    // longer than the receiver remembers. The inner relation is the one that
    // explains the other, so it is the one named.
    const request = { retryWindowMs: 1_000, retryBackoffMaxMs: 2_000, dedupMs: 500 };
    expect(() => deriveRetention(request)).toThrow(/retry-covers-backoff/);
  });

  it('RW.10: Infinity is a duration; NaN and negatives are not', () => {
    expect(
      deriveRetention({ retryWindowMs: Number.POSITIVE_INFINITY, dedupMs: Number.POSITIVE_INFINITY }).retryWindowMs,
    ).toBe(Number.POSITIVE_INFINITY);
    for (const bad of [Number.NaN, -1] as const) {
      expect(() => deriveRetention({ retryWindowMs: bad }), String(bad)).toThrow(/window-not-a-duration/);
    }
  });

  it('RW.8: the message names the rule and both numbers', () => {
    let caught: unknown;
    try {
      deriveRetention({ retryWindowMs: 600_000, dedupMs: 300_000 });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toContain('dedup-covers-retry');
    expect(message).toContain('300000');
    expect(message).toContain('600000');
  });

  it('RW.9: a window that is not a duration is refused before it is compared', () => {
    for (const bad of [Number.NaN, -1] as const) {
      let caught: unknown;
      try {
        deriveRetention({ retryWindowMs: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught, String(bad)).toBeInstanceOf(RetentionViolation);
      expect((caught as RetentionViolation).rule).toBe('window-not-a-duration');
      expect((caught as Error).message).toContain('retryWindowMs');
    }
  });
});

describe('deriveRetention — the derivation is the only source', () => {
  it('RW.5: an unspecified window comes from the defaults, not from zero', () => {
    const windows = deriveRetention({ retryWindowMs: 2 * MINUTE });
    expect(windows.dedupMs).toBe(DEFAULT_RETENTION.dedupMs);
    expect(windows.deadLetterTtlMs).toBe(DEFAULT_RETENTION.deadLetterTtlMs);
    expect(windows.entryTtlMs).toBe(DEFAULT_RETENTION.entryTtlMs);
    expect(windows.retryWindowMs).toBe(2 * MINUTE);
  });

  it('RW.4: nothing is widened to make a request legal', () => {
    // A twenty-day budget is legal on its own, and it is not legal against the
    // default thirty-minute receiver memory. The answer is to lengthen the
    // memory, never to shorten the budget behind the caller's back.
    expect(() => deriveRetention({ retryWindowMs: 20 * DAY })).toThrow(/dedup-covers-retry/);
    expect(deriveRetention({ retryWindowMs: 20 * DAY, dedupMs: 20 * DAY }).retryWindowMs).toBe(20 * DAY);
  });
});
