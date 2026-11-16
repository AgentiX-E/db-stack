/**
 * I29 — E3 Audit Logging interfaces.
 *
 * Structured audit event recording for all database operations.
 * Provides tamper-evident logging with query, analysis, and compliance export.
 */

// ── Audit Event ─────────────────────────────────────────────

/** Audit severity level. */
export type AuditSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/** Audit event category. */
export type AuditCategory =
  | 'authentication'
  | 'authorization'
  | 'data_access'
  | 'schema_change'
  | 'configuration'
  | 'security'
  | 'connection'
  | 'query'
  | 'system'
  | 'compliance';

/** Structured audit event. */
export interface AuditEvent {
  /** Unique event identifier (UUID v4). */
  id: string;
  /** Monotonic sequence number. */
  seq: number;
  /** When the event occurred (epoch ms). */
  timestamp: number;
  /** Event category. */
  category: AuditCategory;
  /** Severity level. */
  severity: AuditSeverity;
  /** Action performed (e.g., "CREATE_TABLE", "GRANT_ROLE"). */
  action: string;
  /** Human-readable description. */
  message: string;
  /** Who performed the action. */
  actor: {
    /** User id or service name. */
    id: string;
    /** IP address (optional). */
    ip?: string;
    /** Session id (optional). */
    sessionId?: string;
  };
  /** What resource was acted upon. */
  resource: {
    /** Resource type (table, index, role, config). */
    type: string;
    /** Resource identifier. */
    id: string;
    /** Resource path / namespace. */
    path?: string;
  };
  /** Whether the action succeeded. */
  success: boolean;
  /** Error details (if failed). */
  error?: {
    code: string;
    message: string;
  };
  /** Arbitrary structured metadata. */
  metadata?: Record<string, unknown>;
  /** SHA-256 hash of the event (tamper detection). */
  hash?: string;
  /** Hash of the previous event (chain integrity). */
  prevHash?: string;
}

// ── Audit Query ─────────────────────────────────────────────

/** Filter criteria for audit queries. */
export interface AuditQuery {
  /** Filter by time range (epoch ms). */
  timeRange?: {
    from: number;
    to: number;
  };
  /** Filter by categories. */
  categories?: AuditCategory[];
  /** Filter by severities. */
  severities?: AuditSeverity[];
  /** Filter by actor id(s). */
  actorIds?: string[];
  /** Filter by resource type. */
  resourceTypes?: string[];
  /** Filter by success status. */
  success?: boolean;
  /** Free-text search in message and action. */
  search?: string;
  /** Maximum results to return. */
  limit?: number;
  /** Results offset for pagination. */
  offset?: number;
  /** Sort by field. */
  sortBy?: 'timestamp' | 'seq' | 'severity' | 'category';
  /** Sort direction. */
  sortDir?: 'asc' | 'desc';
}

// ── Audit Statistics ────────────────────────────────────────

export interface AuditStats {
  totalEvents: number;
  eventsByCategory: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  eventsByActor: Record<string, number>;
  failedEvents: number;
  oldestEventAt: number | null;
  newestEventAt: number | null;
}

// ── Audit Integrity ─────────────────────────────────────────

/**
 * What retention has removed from the head of the chain.
 *
 * A hash chain cannot lose its first event and remain a chain: the survivor that
 * followed it has a `prevHash` pointing at a hash nothing in the trail computes.
 * Retention is allowed to delete, so the deletion has to be *recorded* — this is
 * the record. It lets `verifyIntegrity()` answer "the trail starts at seq N, and
 * the entry before it hashed to H" instead of reporting the retention policy as
 * tampering.
 *
 * It is memory state, not a file: it attests to what this manager removed, not to
 * what an attacker with access to the process removed. A hole punched behind the
 * manager's back still shows up as a `seq gap`.
 */
export interface AuditRetentionAnchor {
  /** Total number of events removed from the head of the chain. */
  removedEvents: number;
  /** Sequence number of the newest removed event. */
  lastRemovedSeq: number;
  /** Hash of the newest removed event — the parent the retained chain hangs from. */
  lastRemovedHash: string;
  /** When the most recent removal happened (epoch ms). */
  at: number;
}

/** Result of {@link IAuditLogger.verifyIntegrity}. */
export interface AuditIntegrityResult {
  /** True when every retained event chains correctly onto its parent. */
  valid: boolean;
  /** One message per finding, in chain order. */
  errors: string[];
  /** Null until retention removes something; then what it removed. */
  truncated: AuditRetentionAnchor | null;
}

// ── Audit Logger Interface ──────────────────────────────────

export interface IAuditLogger {
  /** Record a single audit event. */
  log(event: Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>): Promise<AuditEvent>;

  /** Record multiple events in batch (atomic). */
  logBatch(events: Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>[]): Promise<AuditEvent[]>;

  /** Query audit events with filters. */
  query(query: AuditQuery): Promise<AuditEvent[]>;

  /** Get audit statistics. */
  getStats(): Promise<AuditStats>;

  /**
   * Verify audit chain integrity.
   *
   * `valid` means every retained event hashes to its recorded hash and chains
   * onto its predecessor. When retention has removed the head of the chain, the
   * removal is reported in `truncated` and does **not** make the result invalid —
   * but a gap inside the retained window does.
   */
  verifyIntegrity(): Promise<AuditIntegrityResult>;

  /** Export audit trail as JSONL for compliance. */
  exportJSONL(query?: AuditQuery): Promise<string>;

  /**
   * Drop events older than `olderThanMs`, keeping at least
   * {@link AuditRetentionPolicy.minRetain} events.
   *
   * Only a *prefix* is ever removed: an event inside the window is never deleted,
   * because that would leave a hole in the chain that no anchor can describe.
   * Returns the number of events removed.
   */
  prune(olderThanMs: number): Promise<number>;

  /** Flush any buffered events to persistent storage. */
  flush(): Promise<void>;
}

// ── Audit Retention Policy ──────────────────────────────────

export interface AuditRetentionPolicy {
  /**
   * Maximum number of events to keep. `0` means no ceiling.
   *
   * This bounds the in-memory window, not the file: the JSONL trail is
   * append-only evidence and is never rewritten, because rewriting a hash-chained
   * file invalidates the hashes it contains.
   */
  maxEvents?: number;
  /**
   * Maximum age of an event in the in-memory window, in ms. `0` means no age
   * limit. Applied when the buffer is flushed, after the events are written.
   */
  maxAgeMs?: number;
  /** Minimum events to keep regardless of age. */
  minRetain?: number;
}
