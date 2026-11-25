/**
 * AckTracker — the one place a bounded wait for a peer's confirmation lives.
 *
 * `ITransport.send()` resolves `true` when the bytes reached a socket, which is a
 * statement about the sender's kernel rather than about the receiver. The only
 * party that knows whether a change was applied is the peer, so a sender that
 * retires an outbox entry on `send()` is retiring it on a claim nobody made.
 * `cdcAck.ts` describes what an ack means; this class is how one is waited for.
 *
 * It existed twice, or it would have. `ExactlyOnceCDCPipeline` grew the first
 * copy — a map of waiters, a timer per waiter, an abort path for shutdown, and
 * counters for an operator — and `MultiLeaderReplication` needs the same
 * behaviour for the same reason. Two copies of "wait, but not for ever, and
 * answer `aborted` when *we* stopped" is two chances for one of them to charge a
 * retry for our own shutdown.
 *
 * What this class deliberately does not do is decide what a verdict *means*.
 * A pipeline moves a checkpoint, a replication worker marks an entry delivered or
 * failed; both need the verdict and neither needs the other's policy. So the
 * tracker answers the question and the callers keep their consequences.
 */

import { CDC_ACK_TYPE, parseAck } from './cdcAck';
import type { CdcAckVerdict } from './cdcAck';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

export interface AckTrackerOptions {
  /** How long one confirmation is waited for, in milliseconds. */
  timeoutMs: number;
  /**
   * Called when a wait expires. The verdict has already been settled; this is the
   * moment an operator's counter moves, and it is a callback rather than a
   * subclass because a hook is cheaper than a second implementation.
   */
  onTimeout?(messageId: string, timeoutMs: number): void;
  /**
   * Called when a confirmation arrives for an id nobody is waiting for.
   *
   * Not an error: a frame that timed out and was re-sent keeps its id, so the
   * late answer to the first attempt arrives after the wait it belonged to has
   * ended. It is worth counting, because a *rising* count against a stable
   * outstanding count means the peer is answering slower than the budget.
   */
  onUnsolicited?(messageId: string): void;
}

interface Waiter {
  settle(verdict: CdcAckVerdict): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AckTracker {
  private readonly awaiting = new Map<string, Waiter>();
  private readonly options: AckTrackerOptions;
  private closed = false;
  private receivedCount = 0;
  private timeoutCount = 0;
  private unsolicitedCount = 0;

  constructor(options: AckTrackerOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new RangeError(`ackTimeoutMs must be a non-negative number, got ${options.timeoutMs}`);
    }
    this.options = options;
  }

  /** Frames currently being waited for. */
  get pending(): number {
    return this.awaiting.size;
  }

  /** Confirmations that matched a waiter. */
  get received(): number {
    return this.receivedCount;
  }

  /** Waits that expired without an answer. */
  get timeouts(): number {
    return this.timeoutCount;
  }

  /** Confirmations that arrived for an id nobody was waiting for. */
  get unsolicited(): number {
    return this.unsolicitedCount;
  }

  /**
   * Start waiting for the confirmation of one frame.
   *
   * The timer is unref'd: an unanswered frame must not keep a shutting-down
   * process alive for the length of the budget.
   *
   * A tracker that has been released answers `aborted` immediately rather than
   * waiting for a peer that is, by construction, no longer being listened to.
   */
  expect(messageId: string): Promise<CdcAckVerdict> {
    if (this.closed) {
      return Promise.resolve({
        ok: false,
        error: `the tracker was released before ${messageId} could be awaited`,
        aborted: true,
      });
    }

    return new Promise<CdcAckVerdict>((settle) => {
      const timer = setTimeout(() => {
        // The answer may have settled this while the timer was already queued.
        if (this.awaiting.get(messageId)?.timer !== timer) return;
        this.awaiting.delete(messageId);
        this.timeoutCount += 1;
        this.options.onTimeout?.(messageId, this.options.timeoutMs);
        settle({
          ok: false,
          error: `no acknowledgement for ${messageId} within ${this.options.timeoutMs} ms`,
        });
      }, this.options.timeoutMs);
      timer.unref?.();
      this.awaiting.set(messageId, { settle, timer });
    });
  }

  /**
   * Match an inbound frame to the wait it answers.
   *
   * @returns `true` when the frame was a confirmation this tracker consumed, so a
   *   caller can stop treating it as a change to apply. A frame that is not an ack
   *   is not consumed — the type check lives here so no caller has to remember it.
   */
  handle(frame: TransportMessage): boolean {
    if (frame.type !== CDC_ACK_TYPE) return false;

    const waiting = this.awaiting.get(frame.messageId);
    if (waiting === undefined) {
      this.unsolicitedCount += 1;
      this.options.onUnsolicited?.(frame.messageId);
      return true;
    }

    this.awaiting.delete(frame.messageId);
    clearTimeout(waiting.timer);
    this.receivedCount += 1;
    waiting.settle(parseAck(frame.payload, frame.messageId));
    return true;
  }

  /**
   * Stop waiting for every in-flight frame without learning anything.
   *
   * `aborted` rather than `ok: false`: the peer has not refused, and charging an
   * entry an attempt for our own shutdown would spend a retry budget on a
   * decision the peer never saw.
   */
  release(reason: string): void {
    this.closed = true;
    for (const [messageId, waiting] of [...this.awaiting]) {
      this.awaiting.delete(messageId);
      clearTimeout(waiting.timer);
      waiting.settle({ ok: false, error: `${reason} (${messageId})`, aborted: true });
    }
  }

  /**
   * Abandon one frame: its send was refused or threw, so nothing will answer.
   *
   * A no-op when nobody is waiting, which is what makes it safe to call from a
   * `catch` that may run after the timer has already fired.
   */
  abandon(messageId: string, reason: string): void {
    const waiting = this.awaiting.get(messageId);
    if (waiting === undefined) return;
    this.awaiting.delete(messageId);
    clearTimeout(waiting.timer);
    waiting.settle({ ok: false, error: `${reason} (${messageId})`, aborted: true });
  }
}
