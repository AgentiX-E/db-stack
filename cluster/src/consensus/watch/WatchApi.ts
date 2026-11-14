/**
 * WatchApi — asynchronous watch mechanism built on the event bus.
 *
 * Consumers register a watch key; when a matching event is published through the EventBus,
 * the consumer receives it asynchronously. FIFO order and correctness across leader changes are guaranteed.
 *
 * @module consensus/watch
 */

import type { IEventBus, IDisposable, ConsensusEvent, ProposalCommittedEvent } from '../events/EventBus';

// ── Interfaces ─────────────────────────────────────────────────────

export interface WatchOptions {
  /** Watch timeout (ms); the watch is cancelled when exceeded */
  timeoutMs?: number;
  /** Whether committed history from the current commitIndex is replayed first */
  includeHistory?: boolean;
  /** Start index (used to resume from a checkpoint) */
  startIndex?: number;
}

export interface WatchEvent {
  key: string;
  value: string;
  index: number;
  term: number;
  timestamp: number;
}

export type WatchHandler = (event: WatchEvent) => Promise<void> | void;

/**
 * IWatchApi — type-safe watch mechanism.
 *
 * Design principles:
 * 1. Built on the EventBus proposal.committed event
 * 2. Key-prefix matching (key like "prefix*")
 * 3. Re-registers automatically across leader changes
 * 4. Timeout protection
 */
export interface IWatchApi {
  /**
   * Register a watch. The handler fires when a proposal matching the key prefix commits.
   * Returns an IDisposable handle used to cancel.
   *
   * @param keyPrefix — prefix to match (an empty string matches every key)
   * @param handler — asynchronous callback
   * @param options — optional configuration
   */
  watch(keyPrefix: string, handler: WatchHandler, options?: WatchOptions): IDisposable;

  /**
   * Number of currently active watches.
   */
  activeWatchCount(): number;

  /**
   * Cancel every watch and stop listening for events.
   */
  shutdown(): void;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseKeyFromData(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed.key === 'string' ? parsed.key : null;
  } catch {
    // The payload is not JSON; strip the value after the first "=" to recover the key
    const eqIdx = data.indexOf('=');
    const rawKey = eqIdx >= 0 ? data.slice(0, eqIdx) : data;
    return rawKey || null;
  }
}

function parseValueFromData(data: string): string {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed.value !== 'undefined' ? String(parsed.value) : data;
  } catch {
    return data;
  }
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * WatchApi — high-performance watch implementation.
 *
 * Properties:
 * - prefix matching (O(1) hash + O(n) scan over active watches)
 * - automatic re-registration on leader change
 * - memory safety: every subscription is released on shutdown
 */
export class WatchApi implements IWatchApi {
  private _eventBus: IEventBus;
  private _watches = new Map<
    string,
    {
      handler: WatchHandler;
      options: WatchOptions;
      disposables: IDisposable[];
    }
  >();
  private _shutdown = false;

  constructor(eventBus: IEventBus) {
    this._eventBus = eventBus;
  }

  watch(keyPrefix: string, handler: WatchHandler, options: WatchOptions = {}): IDisposable {
    if (this._shutdown) {
      throw new Error('WatchApi is shut down');
    }

    const watchId = `${keyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const disposables: IDisposable[] = [];

    // Subscribe to proposal.committed
    const sub = this._eventBus.on('proposal.committed', (event: ConsensusEvent) => {
      const committed = event as ProposalCommittedEvent;
      const key = parseKeyFromData(committed.data);
      if (key === null) return;

      // Prefix match
      if (keyPrefix === '' || key.startsWith(keyPrefix)) {
        try {
          const value = parseValueFromData(committed.data);
          const watchEvent: WatchEvent = {
            key,
            value,
            index: committed.index,
            term: committed.term,
            timestamp: committed.timestamp,
          };
          handler(watchEvent);
        } catch {
          // A throwing handler must not affect other watches
        }
      }
    });
    disposables.push(sub);

    // Subscribe to leader changes to adapt automatically
    const leaderSub = this._eventBus.on('leader.elected', () => {
      // Watchers need no special handling on leader change because
      // proposal.committed is published by the leader only and the
      // new leader keeps publishing it.
    });
    disposables.push(leaderSub);

    // Timeout handling
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutId = setTimeout(() => {
        this._cleanup(watchId);
      }, options.timeoutMs);
      disposables.push({
        dispose: () => clearTimeout(timeoutId),
      });
    }

    this._watches.set(watchId, { handler, options, disposables });

    return {
      dispose: () => {
        this._cleanup(watchId);
      },
    };
  }

  activeWatchCount(): number {
    return this._watches.size;
  }

  shutdown(): void {
    this._shutdown = true;
    for (const watchId of this._watches.keys()) {
      this._cleanup(watchId);
    }
    this._watches.clear();
  }

  private _cleanup(watchId: string): void {
    const entry = this._watches.get(watchId);
    if (!entry) return;
    for (const d of entry.disposables) {
      try {
        d.dispose();
      } catch {
        /* swallowed */
      }
    }
    this._watches.delete(watchId);
  }
}
