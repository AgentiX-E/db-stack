/**
 * IEventBus — type-safe consensus event bus
 *
 * Every Raft state-transition event is published here; both synchronous and asynchronous subscribers are supported.
 * The Disposable pattern guarantees zero subscription leaks.
 *
 * @module consensus/events
 */

// ── Event types ────────────────────────────────────────────────────

export type RaftRole = 'follower' | 'candidate' | 'leader';

export interface RaftEvent {
  type: string;
  timestamp: number;
  nodeId: number;
}

export interface LeaderElectedEvent extends RaftEvent {
  type: 'leader.elected';
  term: number;
  leaderId: number;
}

export interface LeaderLostEvent extends RaftEvent {
  type: 'leader.lost';
  term: number;
  reason: 'election_timeout' | 'step_down' | 'transfer';
}

export interface StepDownEvent extends RaftEvent {
  type: 'leader.step_down';
  term: number;
}

export interface ProposalCommittedEvent extends RaftEvent {
  type: 'proposal.committed';
  index: number;
  term: number;
  data: string;
}

export interface ProposalAppliedEvent extends RaftEvent {
  type: 'proposal.applied';
  index: number;
  term: number;
}

export interface SnapshotCreatedEvent extends RaftEvent {
  type: 'snapshot.created';
  index: number;
  term: number;
}

export interface SnapshotRestoredEvent extends RaftEvent {
  type: 'snapshot.restored';
  index: number;
  term: number;
}

export interface RoleChangedEvent extends RaftEvent {
  type: 'role.changed';
  from: RaftRole;
  to: RaftRole;
  term: number;
}

export interface MembershipChangedEvent extends RaftEvent {
  type: 'membership.changed';
  added: number[];
  removed: number[];
  newConfig: number[];
}

export type ConsensusEvent =
  | LeaderElectedEvent
  | LeaderLostEvent
  | StepDownEvent
  | ProposalCommittedEvent
  | ProposalAppliedEvent
  | SnapshotCreatedEvent
  | SnapshotRestoredEvent
  | RoleChangedEvent
  | MembershipChangedEvent;

// ── Subscriber interfaces ──────────────────────────────────────────
// Function types rather than classes keep the hot path allocation-free

/**
 * IDisposable — handle that releases a subscription.
 * Calling dispose() unsubscribes and prevents a leak.
 */
export interface IDisposable {
  dispose(): void;
}

/** Asynchronous event handler */
export type AsyncEventHandler<T extends ConsensusEvent = ConsensusEvent> = (event: T) => Promise<void> | void;

/** Synchronous event handler (performance-sensitive path) */
export type SyncEventHandler<T extends ConsensusEvent = ConsensusEvent> = (event: T) => void;

/**
 * Internal handler type covering both subscriber flavours.
 *
 * Declared explicitly instead of the `Function` builtin so an accidental call
 * signature mismatch is a compile error rather than a runtime
 * `undefined is not a function`. The parameter is `any` on purpose: the bus
 * stores handlers for every event type in one map and dispatches by runtime
 * type tag, so the generic parameter of the public `on<T>()` overloads cannot
 * be recovered here. The public surface stays fully generic.
 */
type EventHandler = (event: any) => void | Promise<void>;

/** One registered subscriber. */
interface EventSubscription {
  handler: EventHandler;
  async: boolean;
  once: boolean;
}

// ── Implementation ─────────────────────────────────────────────────

export interface IEventBus {
  /**
   * Publish an event to every subscriber registered for its type.
   * Asynchronous subscribers run on the microtask queue and never block the publisher.
   * Synchronous subscribers run immediately.
   */
  emit<T extends ConsensusEvent>(event: T): void;

  /**
   * Subscribe (synchronous by default, which preserves event order).
   * Returns an IDisposable handle used to unsubscribe.
   */
  on<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable;

  /**
   * Asynchronous subscription (events are consumed FIFO on the microtask queue).
   * Intended for consumers whose handling takes a long time.
   */
  onAsync<T extends ConsensusEvent>(type: T['type'], handler: AsyncEventHandler<T>): IDisposable;

  /**
   * One-shot subscription. Automatically unsubscribed after the first event.
   */
  once<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable;

  /**
   * Current number of subscribers (diagnostics).
   */
  subscriberCount(type?: string): number;

  /** Remove every subscription (used to reset between tests). */
  reset(): void;
}

// ── Implementation ─────────────────────────────────────────────────

import type { ListenerFailureReporter } from '../../observability/ListenerFailureReporter';

/** Options for {@link EventBus}. */
export interface EventBusOptions {
  /**
   * Sink for exceptions thrown by subscribers (C-04). The bus still isolates a
   * crashing subscriber; this only makes the failure observable. Absent by
   * default so existing construction sites keep their exact behaviour.
   */
  onListenerFailure?: ListenerFailureReporter;
}

/**
 * EventBus — high-performance consensus event bus.
 *
 * Design notes:
 * 1. Synchronous subscribers run inline (ordering is guaranteed)
 * 2. Asynchronous subscribers are deferred through setImmediate (off the critical path)
 * 3. Every callback is wrapped in try/catch (one crashed subscriber cannot affect the others)
 * 4. Disposable pattern (zero-leak assertions in the test suite)
 * 5. A swallowed exception is reported to an optional, engine-agnostic sink
 */
export class EventBus implements IEventBus {
  // Map<eventType, Set<{handler, async}>>
  private _subscribers = new Map<string, Set<EventSubscription>>();
  private _emitInProgress = new Map<string, boolean>();
  private readonly _report: ListenerFailureReporter;

  constructor(options: EventBusOptions = {}) {
    this._report = options.onListenerFailure ?? (() => {});
  }

  emit(event: ConsensusEvent): void {
    const subs = this._subscribers.get(event.type);
    if (!subs || subs.size === 0) return;

    // Guard against recursive emit (infinite loop)
    if (this._emitInProgress.get(event.type)) return;
    this._emitInProgress.set(event.type, true);

    const toRemove: EventHandler[] = [];

    try {
      for (const sub of subs) {
        try {
          if (sub.async) {
            setImmediate(() => {
              try {
                sub.handler(event);
              } catch (error) {
                // C-04: isolated, but no longer silent.
                this._safeReport('EventBus.async', error, event.type);
              }
            });
          } else {
            sub.handler(event);
          }
        } catch (error) {
          // One crashed subscriber must not affect the others (C-04: report it).
          this._safeReport('EventBus.sync', error, event.type);
          continue;
        }
        if (sub.once) {
          toRemove.push(sub.handler);
        }
      }
    } finally {
      this._emitInProgress.set(event.type, false);
    }

    for (const h of toRemove) {
      for (const s of subs) {
        if (s.handler === h) subs.delete(s);
      }
    }
  }

  /**
   * Report a swallowed subscriber exception without letting a broken reporter
   * become a second failure. Isolation is the bus's first duty; observability is
   * the second, and must never cost the first.
   */
  private _safeReport(source: string, error: unknown, _eventType: string): void {
    try {
      this._report({ source, error, at: Date.now() });
    } catch {
      // A reporter that throws is a broken reporter, not a reason to stop the bus.
    }
  }

  on<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, false, false);
  }

  onAsync<T extends ConsensusEvent>(type: T['type'], handler: AsyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, true, false);
  }

  once<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, false, true);
  }

  private _subscribe(type: string, handler: EventHandler, async: boolean, once: boolean): IDisposable {
    if (!this._subscribers.has(type)) {
      this._subscribers.set(type, new Set());
    }
    const subs = this._subscribers.get(type)!;
    const entry = { handler, async, once };
    subs.add(entry);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        subs.delete(entry);
        if (subs.size === 0) {
          this._subscribers.delete(type);
        }
      },
    };
  }

  subscriberCount(type?: string): number {
    if (type) {
      return this._subscribers.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const subs of this._subscribers.values()) {
      total += subs.size;
    }
    return total;
  }

  reset(): void {
    this._subscribers.clear();
    this._emitInProgress.clear();
  }
}
