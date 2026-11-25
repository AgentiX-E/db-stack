/**
 * AckTracker — the bounded wait for a peer's confirmation.
 *
 * `ITransport.send()` resolving `true` says the bytes reached a socket, so the
 * only party that can say "applied" is the peer. These cases pin the instrument
 * that listens for the answer: what a verdict is, what a timeout is, what an
 * answer to a question nobody asked is, and the difference between a peer that
 * refused and a sender that stopped waiting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AckTracker } from './AckTracker';
import { CDC_ACK_TYPE, buildAckFrame } from './cdcAck';
import { HLC } from '../hlc/HLC';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

const hlc = new HLC('ack-tester');

function ackFor(messageId: string, body?: unknown): TransportMessage {
  const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  return {
    messageId,
    sourcePeerId: 'peer-b',
    targetPeerId: 'peer-a',
    payload,
    timestamp: hlc.now(),
    createdAt: Date.now(),
    type: CDC_ACK_TYPE,
  };
}

function frameFor(messageId: string): TransportMessage {
  return {
    messageId,
    sourcePeerId: 'peer-a',
    targetPeerId: 'peer-b',
    payload: new TextEncoder().encode('change'),
    timestamp: hlc.now(),
    createdAt: Date.now(),
    type: 'replicate',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AckTracker', () => {
  it('AT.1 — an answer to a registered wait settles it', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const verdict = tracker.expect('m1');
    expect(tracker.pending).toBe(1);

    expect(tracker.handle(ackFor('m1'))).toBe(true);

    await expect(verdict).resolves.toEqual({ ok: true });
    expect(tracker.received).toBe(1);
    expect(tracker.pending).toBe(0);
  });

  it('AT.2 — a refusal is a verdict, not a timeout', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const verdict = tracker.expect('m2');
    tracker.handle(ackFor('m2', { ok: false, error: 'no leader in shard 7' }));

    await expect(verdict).resolves.toEqual({ ok: false, error: 'no leader in shard 7' });
    expect(tracker.timeouts).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(tracker.timeouts).toBe(0);
  });

  it('AT.3 — an unreadable body is a refusal, not a yes', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const verdict = tracker.expect('m3');
    tracker.handle({
      ...ackFor('m3'),
      payload: new TextEncoder().encode('{not json'),
    });

    const result = await verdict;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('is not JSON');
  });

  it('AT.4 — a wait that expires says so, in the caller’s own budget', async () => {
    const tracker = new AckTracker({ timeoutMs: 250 });

    const verdict = tracker.expect('m4');
    vi.advanceTimersByTime(250);

    const result = await verdict;
    expect(result.ok).toBe(false);
    expect(result.aborted).toBeUndefined();
    expect(result.error).toContain('no acknowledgement for m4 within 250 ms');
    expect(tracker.timeouts).toBe(1);
    expect(tracker.pending).toBe(0);
  });

  it('AT.5 — an abandoned wait is aborted, and is not a timeout', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const verdict = tracker.expect('m5');
    tracker.abandon('m5', 'the transport refused the frame');

    const result = await verdict;
    expect(result.aborted).toBe(true);
    expect(result.error).toContain('the transport refused the frame');
    expect(tracker.timeouts).toBe(0);
    expect(tracker.pending).toBe(0);
  });

  it('AT.6 — releasing answers every wait: our shutdown is not the peer’s decision', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const first = tracker.expect('m6a');
    const second = tracker.expect('m6b');
    tracker.release('the sender stopped');

    for (const verdict of await Promise.all([first, second])) {
      expect(verdict.aborted).toBe(true);
      expect(verdict.error).toContain('the sender stopped');
    }
    expect(tracker.pending).toBe(0);
    // Nothing may be charged after a shutdown.
    vi.advanceTimersByTime(5_000);
    expect(tracker.timeouts).toBe(0);
  });

  it('AT.7 — a released tracker does not start new waits', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });
    tracker.release('stopped');

    const verdict = await tracker.expect('m7');

    expect(verdict.aborted).toBe(true);
    expect(verdict.error).toContain('released before m7');
    expect(tracker.pending).toBe(0);
  });

  it('AT.8 — a frame that is not a confirmation is not consumed', () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    expect(tracker.handle(frameFor('m8'))).toBe(false);
    expect(tracker.pending).toBe(0);
    expect(tracker.unsolicited).toBe(0);
  });

  it('AT.9 — an answer to a question nobody asked is counted, not fatal', () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    expect(tracker.handle(ackFor('never-sent'))).toBe(true);
    expect(tracker.unsolicited).toBe(1);
    expect(tracker.received).toBe(0);
  });

  it('AT.10 — a second answer to the same frame is unsolicited', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });

    const verdict = tracker.expect('m10');
    tracker.handle(ackFor('m10'));
    await verdict;
    tracker.handle(ackFor('m10'));

    expect(tracker.received).toBe(1);
    expect(tracker.unsolicited).toBe(1);
  });

  it('AT.11 — two waits are two questions', async () => {
    const tracker = new AckTracker({ timeoutMs: 100 });

    const answered = tracker.expect('m11a');
    const expired = tracker.expect('m11b');
    tracker.handle(ackFor('m11a'));
    vi.advanceTimersByTime(100);

    expect(await answered).toEqual({ ok: true });
    expect((await expired).ok).toBe(false);
    expect(tracker.received).toBe(1);
    expect(tracker.timeouts).toBe(1);
  });

  it('AT.12 — the budget has to be a number a clock can use', () => {
    expect(() => new AckTracker({ timeoutMs: -1 })).toThrow(RangeError);
    expect(() => new AckTracker({ timeoutMs: Number.NaN })).toThrow(/ackTimeoutMs/);
    // Zero is legal: it means "take an answer that has already arrived, and no
    // more", which is what an in-process transport needs for a same-tick reply.
    expect(() => new AckTracker({ timeoutMs: 0 })).not.toThrow();
  });

  it('AT.13 — the counters are reported to the hooks that asked for them', async () => {
    const onTimeout = vi.fn();
    const onUnsolicited = vi.fn();
    const tracker = new AckTracker({ timeoutMs: 50, onTimeout, onUnsolicited });

    const verdict = tracker.expect('m13');
    vi.advanceTimersByTime(50);
    await verdict;
    tracker.handle(ackFor('ghost'));

    expect(onTimeout).toHaveBeenCalledWith('m13', 50);
    expect(onUnsolicited).toHaveBeenCalledWith('ghost');
  });

  it('AT.14 — abandoning nothing is not an error', () => {
    const tracker = new AckTracker({ timeoutMs: 100 });

    expect(() => tracker.abandon('m14', 'reason')).not.toThrow();
    expect(tracker.pending).toBe(0);
    expect(tracker.timeouts).toBe(0);
  });

  it('AT.15 — abandoning after the timer fired does not charge twice', async () => {
    const tracker = new AckTracker({ timeoutMs: 10 });

    const verdict = tracker.expect('m15');
    vi.advanceTimersByTime(10);
    await verdict;
    tracker.abandon('m15', 'too late');

    expect(tracker.timeouts).toBe(1);
    expect(tracker.pending).toBe(0);
  });

  it('AT.16 — the frame an acker builds answers the frame it was handed', async () => {
    const tracker = new AckTracker({ timeoutMs: 1_000 });
    const inbound = frameFor('m16');

    const verdict = tracker.expect('m16');
    tracker.handle(buildAckFrame(inbound, 'peer-b', hlc.now()));

    await expect(verdict).resolves.toEqual({ ok: true });
  });

  it('AT.18 — a timer that was already queued when the answer arrived is ignored', async () => {
    // `clearTimeout` cannot unqueue a callback the event loop has already taken, so
    // the timeout has to check that it is still the timer for this wait. Simulated by
    // making `clearTimeout` a no-op: the wait settles, and then the stale callback runs.
    const spy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((() => undefined) as never);

    const tracker = new AckTracker({ timeoutMs: 10 });
    const verdict = tracker.expect('m17');
    tracker.handle(ackFor('m17'));
    vi.advanceTimersByTime(10);

    await expect(verdict).resolves.toEqual({ ok: true });
    expect(tracker.timeouts).toBe(0);
    expect(tracker.pending).toBe(0);

    spy.mockRestore();
  });
});
