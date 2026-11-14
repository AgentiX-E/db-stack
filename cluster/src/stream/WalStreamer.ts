/**
 * WalStreamer — Concrete implementation of IWalStreamer.
 *
 * Bridges IWalStorage (Raft log persistence) to external consumers.
 * Supports real-time tailing, historical replay, filtering, catch-up,
 * and backpressure through async subscriber handlers.
 *
 * Architecture:
 *   [IWalStorage] ──readRange──► [WalStreamer] ──StreamEvent──► [Subscriber 1]
 *                                                              ► [Subscriber 2]
 *                                                              ► [Subscriber N]
 *
 * Delivery semantics: at-least-once (subscribers ack to advance position).
 */

import type { IWalStreamer, StreamEvent, StreamFilter, StreamAck, StreamSubscription, StreamHandler, WalStreamConfig } from "./IWalStreamer";
import type { IWalStorage } from "../interfaces/wal/IWalStorage";
import type { LogEntry } from "../interfaces/types";

// ── Default Config ─────────────────────────────────────────

const DEFAULT_CONFIG: WalStreamConfig = {
  maxBufferSize: 1000,
  pollIntervalMs: 100,
  replayBatchSize: 500,
  emitData: true,
};

// ── Internal subscription state ────────────────────────────

interface InternalSubscription {
  id: string;
  subscriberId: string;
  handler: StreamHandler;
  filter: StreamFilter;
  active: boolean;
  eventsEmitted: number;
  lastAckedSequence: number;
  lastAckedIndex: number;
  buffer: StreamEvent[];
}

// ── WalStreamer ────────────────────────────────────────────

export class WalStreamer implements IWalStreamer {
  private storage: IWalStorage | null = null;
  private config: WalStreamConfig = { ...DEFAULT_CONFIG };
  private subscriptions = new Map<string, InternalSubscription>();
  private _active = false;
  private _globalSequence = 0;
  private _lastEmittedIndex = 0;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _polling = false;

  // ── Lifecycle ─────────────────────────────────────────────

  get active(): boolean { return this._active; }

  async init(storage: IWalStorage, config?: Partial<WalStreamConfig>): Promise<void> {
    this.storage = storage;
    if (config) {
      this.config = { ...DEFAULT_CONFIG, ...config };
    }
    // Discover the current high-water mark
    const lastRes = await storage.lastEntry();
    if (lastRes.success && lastRes.data) {
      this._lastEmittedIndex = lastRes.data.index;
    }
  }

  async start(): Promise<void> {
    if (!this.storage) throw new Error("WalStreamer: not initialized — call init() first");
    if (this._active) return;

    this._active = true;
    this._startPolling();
  }

  async stop(): Promise<void> {
    this._active = false;
    this._stopPolling();
    // Drain all subscription buffers
    for (const sub of this.subscriptions.values()) {
      sub.buffer.length = 0;
    }
  }

  // ── Subscription ───────────────────────────────────────────

  async subscribe(
    subscriberId: string,
    handler: StreamHandler,
    filter?: StreamFilter,
  ): Promise<StreamSubscription> {
    const id = `sub-${subscriberId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const internal: InternalSubscription = {
      id,
      subscriberId,
      handler,
      filter: filter ?? {},
      active: true,
      eventsEmitted: 0,
      lastAckedSequence: 0,
      lastAckedIndex: filter?.fromIndex ?? 0,
      buffer: [],
    };
    this.subscriptions.set(id, internal);
    return this.toPublic(internal);
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;
    sub.active = false;
    sub.buffer.length = 0;
    this.subscriptions.delete(subscriptionId);
  }

  // ── Replay ────────────────────────────────────────────────

  async replay(
    fromIndex: number,
    toIndex: number,
    handler: StreamHandler,
    filter?: StreamFilter,
  ): Promise<number> {
    if (!this.storage) throw new Error("WalStreamer: not initialized");

    let emitted = 0;
    let current = Math.max(1, fromIndex); // Clamp to minimum index 1

    while (current <= toIndex) {
      const end = Math.min(current + this.config.replayBatchSize - 1, toIndex);
      const res = await this.storage.readRange(current, end + 1);

      if (!res.success || !res.data) break;

      for (const entry of res.data) {
        const event = this.entryToEvent(entry);
        if (!this.matchesFilter(event, filter)) continue;

        await handler(event);
        emitted++;
      }

      current = end + 1;
      if (current > toIndex) break;
    }

    return emitted;
  }

  // ── Position Tracking ─────────────────────────────────────

  async ack(ack: StreamAck): Promise<void> {
    // Find the subscription by subscriberId (may have multiple subscriptions per subscriber)
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriberId === ack.subscriberId) {
        sub.lastAckedSequence = Math.max(sub.lastAckedSequence, ack.sequence);
        sub.lastAckedIndex = Math.max(sub.lastAckedIndex, ack.entryIndex);
      }
    }
  }

  async getPosition(): Promise<{ sequence: number; entryIndex: number }> {
    return { sequence: this._globalSequence, entryIndex: this._lastEmittedIndex };
  }

  async getLag(subscriberId: string): Promise<number> {
    let maxAckedSeq = 0;
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriberId === subscriberId) {
        maxAckedSeq = Math.max(maxAckedSeq, sub.lastAckedSequence);
      }
    }
    return Math.max(0, this._globalSequence - maxAckedSeq);
  }

  async getSubscriptions(): Promise<StreamSubscription[]> {
    return [...this.subscriptions.values()].map((s) => this.toPublic(s));
  }

  // ── Catch-up ──────────────────────────────────────────────

  async catchUp(subscriberId: string): Promise<number> {
    if (!this.storage) throw new Error("WalStreamer: not initialized");

    const subs = [...this.subscriptions.values()].filter(
      (s) => s.subscriberId === subscriberId && s.active,
    );

    if (subs.length === 0) return 0;

    let totalReplayed = 0;
    const currentLastRes = await this.storage.lastEntry();
    if (!currentLastRes.success || !currentLastRes.data) return 0;

    const currentLastIndex = currentLastRes.data.index;

    for (const sub of subs) {
      // Start from lastAckedIndex+1 (acked means processed up to that index),
      // or from filter.fromIndex, whichever is later. Clamp to minimum 1.
      const baseIdx = Math.max(sub.lastAckedIndex + 1, 1);
      const fromIdx = Math.max(baseIdx, sub.filter.fromIndex ?? 1);
      if (fromIdx > currentLastIndex) continue; // Truly beyond: fromIdx > currentLastIndex
      // fromIdx == currentLastIndex: replay 1 entry
      // fromIdx < currentLastIndex: replay range

      const replayed = await this.replay(fromIdx, currentLastIndex, sub.handler, sub.filter);
      sub.lastAckedIndex = currentLastIndex;
      sub.eventsEmitted += replayed;
      totalReplayed += replayed;
    }

    return totalReplayed;
  }

  // ── Internal: Polling ─────────────────────────────────────

  private _startPolling(): void {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      void this._pollNewEntries();
    }, this.config.pollIntervalMs);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _pollNewEntries(): Promise<void> {
    if (!this.storage || !this._active || this._polling) return;
    this._polling = true;

    try {
      const lastRes = await this.storage.lastEntry();
      if (!lastRes.success || !lastRes.data) {
        this._polling = false;
        return;
      }

      const latestIndex = lastRes.data.index;
      if (latestIndex <= this._lastEmittedIndex) {
        this._polling = false;
        return;
      }

      // Read new entries
      const fromIdx = this._lastEmittedIndex + 1;
      const toIdx = Math.min(fromIdx + this.config.replayBatchSize - 1, latestIndex);
      const rangeRes = await this.storage.readRange(fromIdx, toIdx + 1);

      if (!rangeRes.success || !rangeRes.data) {
        this._polling = false;
        return;
      }

      for (const entry of rangeRes.data) {
        const event = this.entryToEvent(entry);
        this._lastEmittedIndex = entry.index;
        await this._dispatchToSubscribers(event);
      }
    } finally {
      this._polling = false;
    }
  }

  // ── Internal: Dispatch ─────────────────────────────────────

  private async _dispatchToSubscribers(event: StreamEvent): Promise<void> {
    const activeSubs = [...this.subscriptions.values()].filter((s) => s.active);

    // Fan-out to all matching subscribers
    await Promise.all(
      activeSubs.map(async (sub) => {
        if (!this.matchesFilter(event, sub.filter)) return;

        // Backpressure: if buffer exceeds max, block
        while (sub.buffer.length >= this.config.maxBufferSize) {
          await this._delay(10);
        }

        sub.buffer.push(event);
        sub.eventsEmitted++;

        try {
          await sub.handler(event);
        } finally {
          // Remove from buffer after handler completes
          const idx = sub.buffer.indexOf(event);
          if (idx >= 0) sub.buffer.splice(idx, 1);
        }
      }),
    );
  }

  // ── Internal: Helpers ─────────────────────────────────────

  private entryToEvent(entry: LogEntry): StreamEvent {
    this._globalSequence++;
    return {
      sequence: this._globalSequence,
      entry: this.config.emitData ? entry : { ...entry, data: undefined },
      emittedAt: Date.now(),
      groupId: (entry as LogEntry & { groupId?: string }).groupId ?? "default",
    };
  }

  private matchesFilter(event: StreamEvent, filter?: StreamFilter): boolean {
    if (!filter) return true;

    if (filter.commands && filter.commands.length > 0) {
      if (!filter.commands.includes(event.entry.command)) return false;
    }

    if (filter.minTerm !== undefined) {
      if (event.entry.term < filter.minTerm) return false;
    }

    if (filter.fromIndex !== undefined) {
      if (event.entry.index < filter.fromIndex) return false;
    }

    if (filter.dataMatch) {
      try {
        if (!filter.dataMatch(event.entry.data)) return false;
      } catch {
        return false; // Predicate threw — treat as no-match
      }
    }

    return true;
  }

  private toPublic(internal: InternalSubscription): StreamSubscription {
    return {
      id: internal.id,
      filter: internal.filter,
      active: internal.active,
      eventsEmitted: internal.eventsEmitted,
      lastAckedSequence: internal.lastAckedSequence,
    };
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
