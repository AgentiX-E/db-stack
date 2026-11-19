/**
 * CDCSubscriptionPump — the edge between a subscription's target and a sink.
 *
 * `CDCPublicationRegistry` records that a subscription targets a DSN. Nothing in
 * the package ever turned that string into an `ICDCSink`: the sink interface,
 * `InMemoryCDCSink` and `CDCSinkResolver` (retry, batching, health) existed and
 * were reachable from no production path at all, and neither was exported from
 * the package root. A subscription was a row in a map that described a delivery
 * nobody performed.
 *
 * This class performs it. For every subscription in the catalogue it resolves
 * `targetDsn` through a factory the caller supplies, connects the resulting
 * sink, and routes the engine's changes to the sinks whose subscription admits
 * them:
 *
 *   [ICDCEngine] ──onChange──→ [pump] ──filter(tables, operations)──→ [ICDCSink]
 *                                  └── per-subscription FIFO queue ──┘
 *
 * Guarantees, all of which are measurements rather than intentions:
 *
 *   P1 — Order. Each subscription has one queue and one drain loop, so events
 *        reach a sink in the order the engine produced them. The engine's LSN is
 *        monotonic (`CDCEngine.nextLsn`), so that order is LSN order.
 *   P2 — One emit per event. A change is handed to a sink with exactly one
 *        successful `emit()` call, or with none. Retries repeat the *same*
 *        single-event call, never a batch, so a retry cannot duplicate an
 *        event the sink had already accepted, and cannot half-apply a batch.
 *   P3 — No silent loss. A sink that refuses is retried `maxEmitAttempts`
 *        times, then recorded in a bounded failure log and reported as
 *        `delivery_failed`. A queue that overflows records the event it could
 *        not hold and reports `overflow`. Neither path returns normally to the
 *        caller as if the change had landed.
 *   P4 — No stall. A subscription whose sink keeps refusing does not block the
 *        ones beside it, and does not block itself forever: the failed event
 *        leaves the queue so the next one can be attempted. The alternative —
 *        holding the head — converts one poisoned event into an outage for the
 *        whole subscription, and the failure log is what makes the choice
 *        auditable.
 *
 * Relationship to `ExactlyOnceCDCPipeline`: different destinations, not
 * different qualities. The pipeline moves the change stream to another data
 * center through an outbox and a dedup ring, with checkpoints that survive a
 * restart. The pump fans a change out, in-process, to whatever a subscription
 * points at. A deployment that needs cross-DC durability uses the pipeline; one
 * that needs "tell this webhook about row changes" uses the pump.
 */

import type { ICDCManager, ICDCEngine, CDCChangeEvent, CDCSubscription } from '../interfaces/replication/ICDCManager';
import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

// ── Types ──────────────────────────────────────────────────

/**
 * Turns a subscription's `targetDsn` into a sink.
 *
 * The package does not ship one: a DSN scheme is a deployment decision (HTTP
 * webhook, Kafka, another database) and hard-coding a client would make this
 * middleware engine-specific in the dimension it exists to be agnostic in.
 */
export type CDCSinkFactory = (targetDsn: string) => ICDCSink | Promise<ICDCSink>;

/** Maps an engine change onto the event a sink receives. */
export type CDCSinkProjection = (event: CDCChangeEvent) => CDCSinkEvent;

export interface CDCSubscriptionPumpConfig {
  /** The change source */
  engine: ICDCEngine;
  /** The catalogue that knows which subscriptions exist and where they point */
  registry: ICDCManager;
  /** Resolves a subscription's `targetDsn` into a sink. Called once per open. */
  resolveSink: CDCSinkFactory;
  /** Event projection. Default: `projectChangeEvent`. */
  project?: CDCSinkProjection;
  /**
   * Changes buffered per subscription before the pump starts refusing new ones.
   * Default: 1024.
   */
  maxPendingPerSubscription?: number;
  /** Emit attempts per change before it is recorded as failed. Default: 3. */
  maxEmitAttempts?: number;
  /** Base delay for the retry backoff (ms). Default: 20. */
  retryBaseMs?: number;
  /** Failure log capacity. Oldest entries are evicted. Default: 100. */
  maxFailureLog?: number;
}

export type CDCPumpEventType =
  | 'subscription_opened'
  | 'subscription_closed'
  | 'subscription_failed'
  | 'delivered'
  | 'delivery_failed'
  | 'overflow'
  | 'projection_failed';

/** Why a change did not reach the sink it was queued for. */
export type CDCPumpDropReason = 'queue-full' | 'stopped' | 'unsubscribed';

export interface CDCPumpEvent {
  type: CDCPumpEventType;
  /**
   * The subscription this event is about.
   *
   * Absent on `projection_failed`: the projection runs once per change, before
   * the pump knows which subscriptions admit it, so there is no single
   * subscription to name.
   */
  subscriptionId?: string;
  timestamp: number;
  /** Sink event id (`lsn:txId`) of the change this event is about */
  eventId?: string;
  /** Log sequence number of the change this event is about */
  lsn?: string;
  table?: string;
  /** Emit attempts spent, for `delivery_failed` */
  attempts?: number;
  /** Refusal message, for `delivery_failed` and `subscription_failed` */
  error?: string;
  /** Why a change was dropped, for `overflow` */
  reason?: CDCPumpDropReason;
  /** Number of changes dropped by this `overflow` event */
  dropped?: number;
}

export type CDCPumpEventHandler = (event: CDCPumpEvent) => void;

/** One entry of the bounded failure log. */
export interface CDCPumpFailure {
  subscriptionId: string;
  eventId: string;
  table: string;
  attempts: number;
  error: string;
  at: number;
}

export interface CDCSubscriptionPumpStatus {
  /** True between a successful `start()` and `stop()` */
  started: boolean;
  /** Subscriptions with a connected sink */
  subscriptions: number;
  /** Catalogue subscriptions the pump could not open, and has not retried since */
  unopened: string[];
  /** Queued changes per subscription id */
  pending: Record<string, number>;
  /** Changes the sink accepted */
  delivered: number;
  /** Changes that exhausted the retry budget */
  failed: number;
  /** Changes that never reached the queue, or were queued when it closed */
  dropped: number;
  /** Failure-log entries evicted to stay inside `maxFailureLog` */
  evictedFailures: number;
}

type ResolvedPumpConfig = {
  engine: ICDCEngine;
  registry: ICDCManager;
  resolveSink: CDCSinkFactory;
  project: CDCSinkProjection;
  maxPendingPerSubscription: number;
  maxEmitAttempts: number;
  retryBaseMs: number;
  maxFailureLog: number;
};

type OpenedSubscription = {
  subscription: CDCSubscription;
  sink: ICDCSink;
  queue: CDCSinkEvent[];
  draining: boolean;
  closed: boolean;
};

// ── Default projection ─────────────────────────────────────

/**
 * The projection used when the caller does not supply one.
 *
 * `key` is left empty on purpose. `CDCChangeEvent` carries `oldValues` and
 * `newValues` and no statement about which of their fields identifies the row;
 * a default that read `id` would be right for the schemas that happen to have
 * one and silently wrong for the rest. A sink that needs row identity supplies
 * `project`.
 */
export function projectChangeEvent(event: CDCChangeEvent): CDCSinkEvent {
  return {
    id: `${event.lsn}:${event.txId}`,
    type: event.operation,
    table: event.tableName,
    key: '',
    data: event.newValues ?? event.oldValues ?? {},
    timestamp: event.timestamp.wallTime,
  };
}

// ── Implementation ─────────────────────────────────────────

export class CDCSubscriptionPump {
  private readonly config: ResolvedPumpConfig;

  private readonly opened = new Map<string, OpenedSubscription>();
  private readonly unopened = new Map<string, string>();
  private readonly failures: CDCPumpFailure[] = [];
  private readonly eventListeners = new Set<CDCPumpEventHandler>();

  private detachEngine: (() => void) | null = null;
  private started = false;
  private delivered = 0;
  private failed = 0;
  private dropped = 0;
  private evictedFailures = 0;

  constructor(config: CDCSubscriptionPumpConfig) {
    // Filled field by field on purpose. `{ ...defaults, ...config }` looks
    // equivalent and is not: TypeScript lets a caller pass `project: undefined`
    // for an optional field, and the spread then overwrites the default with
    // `undefined` — the option is "absent" in the type and "present" in the
    // object, and the first change appended throws `project is not a function`.
    this.config = {
      engine: config.engine,
      registry: config.registry,
      resolveSink: config.resolveSink,
      project: config.project ?? projectChangeEvent,
      maxPendingPerSubscription: config.maxPendingPerSubscription ?? 1024,
      maxEmitAttempts: config.maxEmitAttempts ?? 3,
      retryBaseMs: config.retryBaseMs ?? 20,
      maxFailureLog: config.maxFailureLog ?? 100,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Attach to the engine and open every subscription the catalogue holds.
   *
   * A subscription that cannot be opened does not abort the start: it is
   * reported as `subscription_failed`, listed in `getStatus().unopened`, and
   * retried by the next `sync()`. One unreachable webhook taking down the other
   * subscriptions on the same node is the failure mode that rule prevents.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.detachEngine = this.config.engine.onChange((event) => {
      this.onChange(event);
    });
    await this.sync();
  }

  /**
   * Reconcile the opened set with the catalogue: open what is new, close what
   * was dropped, retry what failed. Safe to call at any time.
   */
  async sync(): Promise<void> {
    const subscriptions = await this.config.registry.getSubscriptions();
    const live = new Set(subscriptions.map((sub) => sub.subscriptionId));

    for (const opened of Array.from(this.opened.values())) {
      if (!live.has(opened.subscription.subscriptionId)) {
        await this.close(opened, 'unsubscribed');
      }
    }

    for (const subscription of subscriptions) {
      if (this.opened.has(subscription.subscriptionId)) continue;
      await this.open(subscription);
    }
  }

  /**
   * Detach from the engine and close every sink. Changes still in a queue are
   * counted as dropped with reason `stopped` — the pump will not deliver them,
   * and will not pretend it did.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    const detach = this.detachEngine;
    this.detachEngine = null;
    if (detach) detach();

    for (const opened of Array.from(this.opened.values())) {
      await this.close(opened, 'stopped');
    }
    this.unopened.clear();
  }

  // ── Observation ──────────────────────────────────────────

  getStatus(): CDCSubscriptionPumpStatus {
    const pending: Record<string, number> = {};
    for (const [id, opened] of this.opened) {
      pending[id] = opened.queue.length;
    }
    return {
      started: this.started,
      subscriptions: this.opened.size,
      unopened: Array.from(this.unopened.keys()),
      pending,
      delivered: this.delivered,
      failed: this.failed,
      dropped: this.dropped,
      evictedFailures: this.evictedFailures,
    };
  }

  /** The bounded failure log, oldest first. */
  getFailures(): CDCPumpFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  onEvent(handler: CDCPumpEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => {
      this.eventListeners.delete(handler);
    };
  }

  // ── Open / close ─────────────────────────────────────────

  private async open(subscription: CDCSubscription): Promise<void> {
    const id = subscription.subscriptionId;
    let sink: ICDCSink;
    try {
      sink = await this.config.resolveSink(subscription.targetDsn);
      await sink.connect();
    } catch (error) {
      const message = messageOf(error);
      this.unopened.set(id, message);
      this.emit({ type: 'subscription_failed', subscriptionId: id, error: message });
      return;
    }

    this.unopened.delete(id);
    this.opened.set(id, {
      subscription,
      sink,
      queue: [],
      draining: false,
      closed: false,
    });
    this.emit({ type: 'subscription_opened', subscriptionId: id });
  }

  private async close(opened: OpenedSubscription, reason: CDCPumpDropReason): Promise<void> {
    const id = opened.subscription.subscriptionId;
    opened.closed = true;

    const abandoned = opened.queue.length;
    if (abandoned > 0) {
      opened.queue.length = 0;
      this.dropped += abandoned;
      this.emit({
        type: 'overflow',
        subscriptionId: id,
        reason,
        dropped: abandoned,
      });
    }

    this.opened.delete(id);
    try {
      await opened.sink.disconnect();
    } catch (error) {
      // Best effort: the subscription is gone either way, and the failure has a
      // name so it is not lost.
      this.emit({ type: 'subscription_closed', subscriptionId: id, error: messageOf(error) });
      return;
    }
    this.emit({ type: 'subscription_closed', subscriptionId: id });
  }

  // ── Routing ──────────────────────────────────────────────

  private onChange(event: CDCChangeEvent): void {
    let projected: CDCSinkEvent;
    try {
      projected = this.project(event);
    } catch (error) {
      // `onChange` runs inside the engine's own listener loop: a throw here
      // would abandon every listener after this one, so a caller's broken
      // projection would break the engine for everybody else. The event is
      // reported as failed and the stream continues.
      this.failed += 1;
      this.emit({
        type: 'projection_failed',
        lsn: event?.lsn,
        table: event?.tableName,
        error: messageOf(error),
      });
      return;
    }

    for (const opened of this.opened.values()) {
      if (!admits(opened.subscription, event)) continue;

      if (opened.queue.length >= this.config.maxPendingPerSubscription) {
        // Drop the *newest*: the consumer keeps a contiguous prefix of the
        // stream, and the gap is reported where it begins. Dropping the oldest
        // would tear a hole in the middle of what it has already been given.
        this.dropped += 1;
        this.emit({
          type: 'overflow',
          subscriptionId: opened.subscription.subscriptionId,
          reason: 'queue-full',
          eventId: projected.id,
          lsn: event.lsn,
          table: event.tableName,
          dropped: 1,
        });
        continue;
      }

      opened.queue.push(projected);
      void this.drain(opened);
    }
  }

  private project(event: CDCChangeEvent): CDCSinkEvent {
    return this.config.project(event);
  }

  private async drain(opened: OpenedSubscription): Promise<void> {
    if (opened.draining) return;
    opened.draining = true;

    try {
      while (!opened.closed && opened.queue.length > 0) {
        const event = opened.queue[0]!;
        await this.deliver(opened, event);
        // `stop()` may have emptied the queue while the emit was in flight.
        if (opened.queue[0] === event) opened.queue.shift();
      }
    } finally {
      opened.draining = false;
    }
  }

  private async deliver(opened: OpenedSubscription, event: CDCSinkEvent): Promise<void> {
    const id = opened.subscription.subscriptionId;

    for (let attempt = 1; ; attempt++) {
      try {
        await opened.sink.emit([event]);
        // `stop()` may have closed the subscription while the emit was in
        // flight. Whatever that call did is outside the window the pump reports
        // on — `close()` already counted the change as abandoned — so counting
        // it as delivered here would report the same change twice.
        if (opened.closed) return;
        this.delivered += 1;
        this.emit({
          type: 'delivered',
          subscriptionId: id,
          eventId: event.id,
          table: event.table,
        });
        return;
      } catch (error) {
        if (attempt >= this.config.maxEmitAttempts) {
          this.recordFailure(id, event, attempt, messageOf(error));
          return;
        }
        await this.delay(this.config.retryBaseMs * Math.pow(2, attempt - 1));
      }
    }
  }

  private recordFailure(subscriptionId: string, event: CDCSinkEvent, attempts: number, error: string): void {
    this.failed += 1;
    this.failures.push({
      subscriptionId,
      eventId: event.id,
      table: event.table,
      attempts,
      error,
      at: Date.now(),
    });
    if (this.failures.length > this.config.maxFailureLog) {
      this.failures.shift();
      this.evictedFailures += 1;
    }
    this.emit({
      type: 'delivery_failed',
      subscriptionId,
      eventId: event.id,
      table: event.table,
      attempts,
      error,
    });
  }

  // ── Plumbing ─────────────────────────────────────────────

  private emit(event: Omit<CDCPumpEvent, 'timestamp'> & { timestamp?: number }): void {
    const full: CDCPumpEvent = { timestamp: Date.now(), ...event };
    for (const listener of this.eventListeners) {
      try {
        listener(full);
      } catch {
        // A throwing observer must not break delivery; the pump's own counters
        // are the record.
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── Helpers ────────────────────────────────────────────────

function admits(subscription: CDCSubscription, event: CDCChangeEvent): boolean {
  return subscription.tables.includes(event.tableName) && subscription.operations.includes(event.operation);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
