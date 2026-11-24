/**
 * CDCManager — Change Data Capture manager for cross-DC event streaming.
 *
 * Owns the local change stream: changes applied to the local Raft group are
 * captured here and offered, in capture order, to every registered handler.
 * Per-DC routing is not this layer's job — `MultiLeaderReplication` owns one
 * durable outbox per target and is the only path that crosses a datacenter.
 *
 * Invariants:
 *   MA2 — every captured event is offered to every handler, at-least-once
 *   MA3 — a full buffer triggers a drain and a backpressure signal, never a
 *         discard; `getDeliveryStats()` makes the accounting checkable
 *   MA5 — graceful shutdown drains the buffer before it stops
 *
 * This class used to construct one `CDCEngine` per federation target, start it,
 * stop it, and never hand it an event. Those engines model PostgreSQL's
 * table/row shape (`tableName`, `oldValues`, `newValues`) and this manager
 * models key/value changes; the only way to feed one from the other was to
 * invent a table name from a key. `getEngineCount()` therefore answered a
 * question about decoration: a two-target federation reported two engines and
 * zero events ever reached either. The engines are gone, and with them `hlc`
 * and `maxLagMs`, two constructor fields nothing read.
 */

import { EventEmitter } from 'events';

export interface CDCManagerConfig {
  nodeId: string;
  /** Maximum events buffered before the manager drains instead of growing */
  maxBufferSize?: number;
  /** Tick interval for flushing CDC events (ms) */
  tickMs?: number;
}

export interface CDCEvent {
  eventId: string;
  key: string;
  value: string;
  type: 'insert' | 'update' | 'delete';
  sourceNodeId: string;
  sourceDc: string;
  hlcTimestamp: { wallTime: number; logical: number; nodeId: string };
  appliedAt: number;
}

export type CDCEventHandler = (event: CDCEvent) => Promise<void>;

/**
 * What the manager did with the events it was given.
 *
 * `captured === delivered + bufferSize` holds whenever no drain is in flight:
 * every event is either retired by a flush or still queued. `requeued` and
 * `deliveryFailures` are cumulative diagnostics — a re-queued event is counted
 * once when it goes back and once again when it is finally delivered, so they
 * do not enter the identity. `handlers` is the number of consumers the events
 * were offered to; a non-zero `captured` with zero `handlers` is a stream
 * nobody is reading, which is a dashboard fact rather than a delivery failure.
 */
export interface CDCDeliveryStats {
  captured: number;
  delivered: number;
  requeued: number;
  deliveryFailures: number;
  bufferSize: number;
  handlers: number;
}

export class CDCManager {
  private readonly config: { nodeId: string; maxBufferSize: number; tickMs: number };
  private readonly emitter = new EventEmitter();
  private readonly eventBuffer: CDCEvent[] = [];
  private readonly eventHandlers: Set<CDCEventHandler> = new Set();

  private started = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private isApplyingBackpressure = false;
  private draining = false;
  private flushChain: Promise<void> = Promise.resolve();

  private readonly counters = { captured: 0, delivered: 0, requeued: 0, deliveryFailures: 0 };

  constructor(config: CDCManagerConfig) {
    this.config = {
      nodeId: config.nodeId,
      maxBufferSize: config.maxBufferSize ?? 10_000,
      tickMs: config.tickMs ?? 100,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;

    // Flush loop. `flushBuffer()` never rejects — every handler failure is
    // caught and re-queued — so the catch here is for the timer, not the work.
    this.tickTimer = setInterval(() => {
      void this.flushBuffer();
    }, this.config.tickMs);

    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // MA5: graceful shutdown — drain what is buffered, then detach.
    await this.flushBuffer();
    this.emitter.removeAllListeners();
  }

  /**
   * Capture a CDC event from the local write path.
   *
   * A full buffer is a reason to drain, not a reason to discard. The caller
   * awaits this method, so the drain is the producer's backpressure: the write
   * path slows down to the consumer's rate instead of losing changes at a
   * threshold. If the drain cannot free space because a handler is refusing,
   * the event is still buffered — the buffer is allowed to exceed its bound and
   * `isBackpressured()` stays true until the consumer catches up.
   */
  async capture(event: CDCEvent): Promise<void> {
    if (!this.started) {
      throw new Error('CDCManager not started');
    }

    if (this.eventBuffer.length >= this.config.maxBufferSize) {
      this.isApplyingBackpressure = true;
      this.emitter.emit('backpressure', {
        bufferSize: this.eventBuffer.length,
        maxBufferSize: this.config.maxBufferSize,
      });
      // A handler that captures re-entrantly would deadlock on this await, so
      // only a producer outside the current drain may wait for one.
      if (!this.draining) await this.flushBuffer();
    }

    this.eventBuffer.push(event);
    this.counters.captured++;
    this.emitter.emit('event-captured', event);

    if (this.eventBuffer.length >= this.config.maxBufferSize * 0.8) {
      this.emitter.emit('buffer-warning', {
        bufferSize: this.eventBuffer.length,
        threshold: this.config.maxBufferSize * 0.8,
      });
    }
  }

  /**
   * Register a handler for CDC events.
   */
  onEvent(handler: CDCEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Register a backpressure callback.
   */
  onBackpressure(callback: (info: { bufferSize: number; maxBufferSize: number }) => void): () => void {
    this.emitter.on('backpressure', callback);
    return () => {
      this.emitter.off('backpressure', callback);
    };
  }

  /**
   * Get current buffer size.
   */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Check if backpressure is active.
   */
  isBackpressured(): boolean {
    return this.isApplyingBackpressure;
  }

  /**
   * Check if started.
   */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Delivery accounting. See `CDCDeliveryStats` for the invariant.
   */
  getDeliveryStats(): CDCDeliveryStats {
    return {
      captured: this.counters.captured,
      delivered: this.counters.delivered,
      requeued: this.counters.requeued,
      deliveryFailures: this.counters.deliveryFailures,
      bufferSize: this.eventBuffer.length,
      handlers: this.eventHandlers.size,
    };
  }

  /**
   * Drain the buffer.
   *
   * Drains are serialised: the tick loop and a producer that found the buffer
   * full may both call this, and two interleaved drains of the same array would
   * deliver an event twice or re-order a batch. Chaining onto the previous
   * promise makes the second caller wait, and by then the buffer is empty.
   */
  async flushBuffer(): Promise<void> {
    const next = this.flushChain.then(() => this.drainOnce());
    this.flushChain = next.catch(() => undefined);
    return next;
  }

  // ── Private ──────────────────────────────────────────────

  private async drainOnce(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      this.isApplyingBackpressure = false;
      return;
    }

    this.draining = true;
    try {
      const batch = this.eventBuffer.splice(0);

      // Lowest index any handler refused to accept. Everything from here on is
      // still owed — to that handler, and to every handler that has not seen it.
      let undeliveredFrom = batch.length;

      for (const handler of this.eventHandlers) {
        for (let i = 0; i < batch.length; i++) {
          const event = batch[i]!;
          try {
            await handler(event);
          } catch (err: unknown) {
            this.counters.deliveryFailures++;
            if (i < undeliveredFrom) undeliveredFrom = i;
            this.emitter.emit('delivery-failed', {
              key: event.key,
              eventId: event.eventId,
              index: i,
              error: err instanceof Error ? err.message : String(err),
            });
            // This handler's cursor stops at the event it refused. Delivery is
            // at-least-once and order-preserving, so the tail must be re-offered
            // from here rather than skipped: a handler that failed on one event
            // has not seen the ones behind it.
            break;
          }
        }
      }

      // The prefix each handler accepted is retired; the tail goes back. When a
      // handler refuses its very first event, `undeliveredFrom` is `0` and the
      // whole batch is still owed — which is why the count below is the prefix
      // length and not `batch.length - requeued`.
      this.counters.delivered += undeliveredFrom;
      if (undeliveredFrom < batch.length) {
        this.prepend(batch.slice(undeliveredFrom));
        this.counters.requeued += batch.length - undeliveredFrom;
        this.isApplyingBackpressure = true;
      } else {
        this.isApplyingBackpressure = false;
      }

      // The count is what reached the handlers, not what left the buffer.
      this.emitter.emit('flushed', undeliveredFrom);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Put events back at the head of the buffer, preserving order.
   *
   * `unshift(...events)` throws `RangeError: Maximum call stack size exceeded`
   * once the argument list is large enough, and the batch size here is a
   * configuration value — so the splice goes in chunks whose offsets compose to
   * the original order.
   */
  private prepend(events: CDCEvent[]): void {
    const CHUNK = 4096;
    for (let offset = 0; offset < events.length; offset += CHUNK) {
      this.eventBuffer.splice(offset, 0, ...events.slice(offset, offset + CHUNK));
    }
  }
}
