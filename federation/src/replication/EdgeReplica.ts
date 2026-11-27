/**
 * EdgeReplica — cross-datacenter sync for edge read replicas.
 *
 * Receives incremental change data from the primary cluster CDC pipeline over WebSocket/SSE
 * and reconstructs state exactly at the edge node.
 *
 * Key properties:
 * - eventual consistency
 * - resumable streams (restart from an LSN)
 * - backpressure (throttling when the consumer cannot keep up)
 * - full resynchronisation after a network partition
 *
 * @module replication
 */

// ── Types ──────────────────────────────────────────────────────────

export interface EdgeSourceConfig {
  /** Primary cluster endpoint */
  url: string;
  /** Authentication token */
  authToken?: string;
  /** Transport protocol */
  protocol: 'websocket' | 'sse';
}

export interface EdgeSyncStatus {
  /** Current sync state */
  state: 'disconnected' | 'connecting' | 'syncing' | 'synced' | 'error';
  /** Last received LSN */
  lastLSN: number;
  /** Latest LSN known at the primary cluster */
  sourceLSN: number;
  /** Number of entries received */
  receivedCount: number;
  /** Current lag */
  lagLSN: number;
}

export interface ReplicationEvent {
  type: 'data' | 'snapshot' | 'heartbeat' | 'error';
  lsn: number;
  payload: unknown;
  timestamp: number;
}

export interface IEdgeReplica {
  connect(source: EdgeSourceConfig): Promise<void>;
  disconnect(): Promise<void>;
  getSyncStatus(): EdgeSyncStatus;
  getLag(): number;
  getAllData(): Array<{ lsn: number; payload: unknown }>;
  onEvent(handler: (event: ReplicationEvent) => void): () => void;
  onSyncComplete(handler: () => void): () => void;
  onError(handler: (err: Error) => void): () => void;
}

/**
 * Engine-agnostic hooks for the intake path. The replica knows nothing about
 * the engine's value format or its conflict policy: it hands the two payloads
 * at a repeated LSN to `resolveConflict` and stores whichever one comes back.
 * No hook configured → a duplicate is ignored and a genuine conflict keeps the
 * first payload, which keeps the old deterministic behaviour for engines that
 * have no notion of a conflicting write.
 */
/** A real transport the engine can close when the replica disconnects. */
export interface EdgeTransportHandle {
  dispose(): void | Promise<void>;
}

export interface EdgeReplicaOptions {
  resolveConflict?: (lsn: number, existing: unknown, incoming: unknown) => unknown;
  /**
   * Engine-agnostic dial. Supplied by whatever owns the real socket (WebSocket,
   * SSE, a cluster transport); the replica only observes whether it resolved.
   * A handle returned here is disposed on `disconnect()`, so a real socket can
   * be torn down without the replica knowing its protocol. Without one,
   * `connect()` uses the built-in simulated dial so the intake path stays
   * usable in tests and engines that stream data in-process.
   */
  connectTransport?: (source: EdgeSourceConfig) => Promise<void | EdgeTransportHandle>;
}

// ── Implementation ─────────────────────────────────────────────────

export class EdgeReplica implements IEdgeReplica {
  private readonly _options: EdgeReplicaOptions;

  private _status: EdgeSyncStatus = {
    state: 'disconnected',
    lastLSN: 0,
    sourceLSN: 0,
    receivedCount: 0,
    lagLSN: 0,
  };

  private _data: Array<{ lsn: number; payload: unknown }> = [];
  /** LSN → index into `_data`, so a repeated LSN is a decision, not a second row. */
  private readonly _lsnIndex = new Map<number, number>();

  constructor(options: EdgeReplicaOptions = {}) {
    this._options = options;
  }

  private _eventHandlers: Array<(event: ReplicationEvent) => void> = [];
  private _syncCompleteHandlers: Array<() => void> = [];
  private _errorHandlers: Array<(err: Error) => void> = [];

  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 10;

  private _source: EdgeSourceConfig | null = null;
  private _connected = false;
  private _destroyed = false;
  /**
   * Frames delivered while the dial is in flight. A real socket can push
   * bytes before `connectTransport` resolves; buffering them here (instead of
   * dropping through `receive`'s disconnected guard) makes the dial window
   * lossless. They are applied in order once the dial settles, and discarded
   * if it fails — a failed dial commits no data.
   */
  private _pendingFrames: Array<{ lsn: number; payload: unknown }> = [];
  /**
   * Monotonic generation for the live dial. Every `connect()` bumps it, so a
   * backoff timer or a slow dial from a superseded attempt can tell it is no
   * longer the current connection and do nothing. This is what keeps a stale
   * timer from re-dialling a replica that already disconnected.
   */
  private _generation = 0;
  /** Handle from the engine's dial, disposed when this connection ends. */
  private _transportHandle: EdgeTransportHandle | null = null;

  // ── Connection ──────────────────────────────────────────────────

  async connect(source: EdgeSourceConfig): Promise<void> {
    if (this._destroyed) {
      throw new Error('EdgeReplica has been destroyed');
    }

    // A new dial supersedes whatever came before it: cancel its backoff timer,
    // retire its generation, and start a fresh buffer. Without this, an
    // earlier failed attempt's timer can fire after a later attempt succeeded
    // and dial the replica a second time (or re-dial one that disconnected).
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const generation = ++this._generation;
    this._pendingFrames = [];
    this._source = source;
    this._updateStatus('connecting');

    try {
      // An injected transport dials for real; absent one, the simulated dial
      // keeps in-process engines and the existing acceptance suite working.
      const handle = this._options.connectTransport
        ? await this._options.connectTransport(source)
        : await this._simulateConnect(source);

      // A slow dial that settles after disconnect() or a newer connect() must
      // not resurrect a connection or leak its socket.
      if (generation !== this._generation) {
        void this._disposeHandle(handle ?? null);
        return;
      }

      this._transportHandle = handle ?? null;
      this._connected = true;
      this._updateStatus('syncing');
      this._reconnectAttempts = 0;

      // Flush everything the socket pushed during the dial, in arrival order.
      // _connected is now true, so receive() applies them rather than buffering
      // again. A frame that arrived twice across the boundary is still deduped
      // by LSN.
      const queued = this._pendingFrames;
      this._pendingFrames = [];
      for (const frame of queued) {
        this.receive(frame.lsn, frame.payload);
      }
    } catch (err) {
      // Superseded attempts report nothing: their error belongs to a dial the
      // caller has already replaced, and surfacing it would be a stale signal.
      if (generation !== this._generation) return;
      this._pendingFrames = [];
      this._updateStatus('error');
      this._emitError(err instanceof Error ? err : new Error(String(err)));
      this._scheduleReconnect(generation);
    }
  }

  async disconnect(): Promise<void> {
    // Bump the generation so an in-flight dial or a pending backoff timer
    // cannot re-establish the connection after this teardown.
    this._generation++;
    this._connected = false;
    this._pendingFrames = [];
    this._source = null;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._updateStatus('disconnected');

    const handle = this._transportHandle;
    this._transportHandle = null;
    await this._disposeHandle(handle);
  }

  /** Close the engine's transport; a close failure must not break disconnect. */
  private async _disposeHandle(handle: EdgeTransportHandle | null): Promise<void> {
    if (!handle) return;
    try {
      await handle.dispose();
    } catch (err) {
      this._emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── Events ──────────────────────────────────────────────────────

  /** Receive CDC data. A repeated LSN is arbitrated, never appended twice. */
  receive(lsn: number, payload: unknown): void {
    if (!this._connected) {
      // Only the dial window buffers: a real socket delivers bytes before the
      // dial promise resolves. Once connected, frames arriving while genuinely
      // disconnected are still dropped (the pinned in-process contract), but
      // during `connecting` they are retained until the dial settles.
      if (this._status.state === 'connecting') {
        this._pendingFrames.push({ lsn, payload });
      }
      return;
    }

    const existingIndex = this._lsnIndex.get(lsn);
    if (existingIndex !== undefined) {
      const existing = this._data[existingIndex]!.payload;
      // A transport duplicate carries the same bytes: it is not new data.
      if (EdgeReplica.samePayload(existing, payload)) return;

      // Two writers claimed the same position: let the engine arbitrate. With
      // no resolver the first value stands, which is deterministic and keeps
      // the stream a log rather than a last-write-wins cache.
      const decided = this._options.resolveConflict?.(lsn, existing, payload) ?? existing;
      this._data[existingIndex] = { lsn, payload: decided };

      // The decision has to reach the event subscribers as well: an engine
      // consumes the stream through onEvent, and without this a subscriber
      // keeps the stale pre-arbitration value while getAllData() reports the
      // decided one — two views of one LSN that disagree. A decision that
      // keeps the existing value is not a new frame, so it is not republished.
      if (!EdgeReplica.samePayload(existing, decided)) {
        this._emitDataEvent(lsn, decided);
      }
      return;
    }

    const index = this._data.length;
    this._lsnIndex.set(lsn, index);
    this._data.push({ lsn, payload });
    this._status.lastLSN = lsn;
    this._status.sourceLSN = Math.max(this._status.sourceLSN!, lsn);
    this._status.receivedCount = this._data.length;
    this._status.lagLSN = this._status.sourceLSN! - this._status.lastLSN!;

    this._emitDataEvent(lsn, payload);

    // Has the sync finished?
    if (this._status.lagLSN === 0) {
      this._updateStatus('synced');
      for (const handler of this._syncCompleteHandlers) {
        try {
          handler();
        } catch (err) {
          this._emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  /** Receive a batch of data (backpressure scenario) */
  receiveBatch(entries: Array<{ lsn: number; payload: unknown }>): void {
    for (const entry of entries) {
      this.receive(entry.lsn, entry.payload);
    }
  }

  // ── Status ──────────────────────────────────────────────────────

  getSyncStatus(): EdgeSyncStatus {
    return { ...this._status };
  }

  getLag(): number {
    return this._status.lagLSN!;
  }

  getAllData(): Array<{ lsn: number; payload: unknown }> {
    return [...this._data];
  }

  // ── Event Handlers ──────────────────────────────────────────────

  onEvent(handler: (event: ReplicationEvent) => void): () => void {
    this._eventHandlers.push(handler);
    return () => {
      const idx = this._eventHandlers.indexOf(handler);
      if (idx >= 0) this._eventHandlers.splice(idx, 1);
    };
  }

  onSyncComplete(handler: () => void): () => void {
    this._syncCompleteHandlers.push(handler);
    return () => {
      const idx = this._syncCompleteHandlers.indexOf(handler);
      if (idx >= 0) this._syncCompleteHandlers.splice(idx, 1);
    };
  }

  onError(handler: (err: Error) => void): () => void {
    this._errorHandlers.push(handler);
    return () => {
      const idx = this._errorHandlers.indexOf(handler);
      if (idx >= 0) this._errorHandlers.splice(idx, 1);
    };
  }

  // ── Internal ────────────────────────────────────────────────────

  /**
   * Structural equality for the payloads a replication stream carries. JSON
   * is the wire representation, so two values that serialize alike are the
   * same frame replayed; a strict check alone would treat a re-parsed object
   * as a conflict and ask the engine to arbitrate its own duplicate.
   */
  private static samePayload(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * Publish one data frame to every event subscriber. Handler failures stay
   * isolated but surface through onError, so a subscriber that throws cannot
   * hide the frame from the others or fail silently. Shared by the append and
   * the arbitration paths so both views of an LSN carry the same payload.
   */
  private _emitDataEvent(lsn: number, payload: unknown): void {
    const event: ReplicationEvent = {
      type: 'data',
      lsn,
      payload,
      timestamp: Date.now(),
    };
    for (const handler of this._eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this._emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private _updateStatus(state: EdgeSyncStatus['state']): void {
    this._status.state = state;
  }

  private _emitError(err: Error): void {
    for (const handler of this._errorHandlers) {
      try {
        handler(err);
      } catch {
        /* swallowed */
      }
    }
  }

  private async _simulateConnect(_source: EdgeSourceConfig): Promise<void> {
    // Simulated connect latency (50-200ms; replaced by a real WebSocket connection)
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private _scheduleReconnect(generation: number): void {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._emitError(new Error(`Max reconnect attempts (${this._maxReconnectAttempts}) reached`));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      // The generation is checked again at fire time: a disconnect or a newer
      // dial between scheduling and firing must make this timer a no-op.
      if (generation === this._generation && this._source && !this._destroyed) {
        await this.connect(this._source);
      }
    }, delay);
  }
}
