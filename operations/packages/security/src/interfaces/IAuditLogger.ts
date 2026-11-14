/**
 * I29 — E3 Audit Logging interfaces.
 *
 * Structured audit event recording for all database operations.
 * Provides tamper-evident logging with query, analysis, and compliance export.
 */

// ── Audit Event ─────────────────────────────────────────────

/** Audit severity level. */
export type AuditSeverity = "debug" | "info" | "warning" | "error" | "critical";

/** Audit event category. */
export type AuditCategory =
  | "authentication"
  | "authorization"
  | "data_access"
  | "schema_change"
  | "configuration"
  | "security"
  | "connection"
  | "query"
  | "system"
  | "compliance";

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
  sortBy?: "timestamp" | "seq" | "severity" | "category";
  /** Sort direction. */
  sortDir?: "asc" | "desc";
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

// ── Audit Logger Interface ──────────────────────────────────

export interface IAuditLogger {
  /** Record a single audit event. */
  log(event: Omit<AuditEvent, "id" | "seq" | "timestamp" | "hash" | "prevHash">): Promise<AuditEvent>;

  /** Record multiple events in batch (atomic). */
  logBatch(events: Omit<AuditEvent, "id" | "seq" | "timestamp" | "hash" | "prevHash">[]): Promise<AuditEvent[]>;

  /** Query audit events with filters. */
  query(query: AuditQuery): Promise<AuditEvent[]>;

  /** Get audit statistics. */
  getStats(): Promise<AuditStats>;

  /** Verify audit chain integrity. */
  verifyIntegrity(): Promise<{ valid: boolean; errors: string[] }>;

  /** Export audit trail as JSONL for compliance. */
  exportJSONL(query?: AuditQuery): Promise<string>;

  /** Prune events older than the given timestamp. */
  prune(olderThanMs: number): Promise<number>;

  /** Flush any buffered events to persistent storage. */
  flush(): Promise<void>;
}

// ── Audit Retention Policy ──────────────────────────────────

export interface AuditRetentionPolicy {
  /** Maximum number of events to keep. */
  maxEvents?: number;
  /** Maximum age of events (ms). */
  maxAgeMs?: number;
  /** Minimum events to keep regardless of age. */
  minRetain?: number;
}
