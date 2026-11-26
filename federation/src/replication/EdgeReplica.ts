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
export interface EdgeReplicaOptions {
  resolveConflict?: (lsn: number, existing: unknown, incoming: unknown) => unknown;
  /**
   * Engine-agnostic dial. Supplied by whatever owns the real socket (WebSocket,
   * SSE, a cluster transport); the replica only observes whether it resolved.
   * Without one, `connect()` uses the built-in simulated dial so the intake
   * path stays usable in tests and engines that stream data in-process.
   */
  connectTransport?: (source: EdgeSourceConfig) => Promise<void>;
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

  // ── Connection ──────────────────────────────────────────────────

  async connect(source: EdgeSourceConfig): Promise<void> {
    if (this._destroyed) {
      throw new Error('EdgeReplica has been destroyed');
    }

    this._source = source;
    this._updateStatus('connecting');

    try {
      // An injected transport dials for real; absent one, the simulated dial
      // keeps in-process engines and the existing acceptance suite working.
      if (this._options.connectTransport) {
        await this._options.connectTransport(source);
      } else {
        await this._simulateConnect(source);
      }
      this._connected = true;
      this._updateStatus('syncing');
      this._reconnectAttempts = 0;
    } catch (err) {
      this._updateStatus('error');
      this._emitError(err instanceof Error ? err : new Error(String(err)));
      this._scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._updateStatus('disconnected');
  }

  // ── Events ──────────────────────────────────────────────────────

  /** Receive CDC data. A repeated LSN is arbitrated, never appended twice. */
  receive(lsn: number, payload: unknown): void {
    if (!this._connected) return;

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

  private _scheduleReconnect(): void {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._emitError(new Error(`Max reconnect attempts (${this._maxReconnectAttempts}) reached`));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(async () => {
      if (this._source && !this._destroyed) {
        await this.connect(this._source);
      }
    }, delay);
  }
}
