/**
 * types.ts — Canonical type definitions for the db-operations framework.
 *
 * These types are engine-agnostic. They define the vocabulary for all
 * operational interfaces without referencing any engine-specific types.
 *
 * @module @agentix-e/db-operations-core/types
 */

// ══════════════════════════════════════════════════════════════════════
//  Component Identity
// ══════════════════════════════════════════════════════════════════════

/** Engine type identifier. Each database engine registers under a unique type. */
export type EngineType = 'sqlvec' | 'graphvec' | 'custom';

/** Component lifecycle phase. */
export type LifecyclePhase =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'failed';

// ══════════════════════════════════════════════════════════════════════
//  Health & Probes
// ══════════════════════════════════════════════════════════════════════

/** K8s-style health probe result. */
export interface ProbeResult {
  /** Whether the probe passed. */
  ok: boolean;
  /** Human-readable reason if not ok. */
  message?: string;
  /** Arbitrary details for diagnostics. */
  details?: Record<string, unknown>;
}

/** Composite health status for a registered component. */
export interface ComponentHealth {
  /** Unique component identifier. */
  componentId: string;
  /** Component display name. */
  componentName: string;
  /** Liveness probe result (is the component alive?). */
  liveness: ProbeResult;
  /** Readiness probe result (can the component serve requests?). */
  readiness: ProbeResult;
  /** Uptime in seconds. */
  uptimeSeconds: number;
  /** Last known error, if any. */
  lastError: string | null;
}

/** Aggregate health status for the entire database instance. */
export interface HealthStatus {
  /** Overall status. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Uptime in seconds. */
  uptimeSeconds: number;
  /** Per-component health summaries. */
  components: ComponentHealth[];
  /** Global last error. */
  lastError: string | null;
}

// ══════════════════════════════════════════════════════════════════════
//  Metrics
// ══════════════════════════════════════════════════════════════════════

/** Supported metric types. */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

/** Metric label key-value pair. */
export interface MetricLabel {
  key: string;
  value: string;
}

/** A single metric datapoint for snapshot/export. */
export interface MetricPoint {
  name: string;
  type: MetricType;
  value: number;
  labels: MetricLabel[];
  timestamp: number;
}

/** Snapshot of all current metrics. */
export interface MetricsSnapshot {
  points: MetricPoint[];
  capturedAt: number;
}

// ══════════════════════════════════════════════════════════════════════
//  Backup
// ══════════════════════════════════════════════════════════════════════

/** Snapshot type. */
export type SnapshotType = 'full' | 'incremental' | 'logical';

/** Snapshot lifecycle state. */
export type SnapshotState =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'verifying'
  | 'verified';

/** Backup metadata. */
export interface BackupMetadata {
  /** Unique snapshot identifier. */
  snapshotId: string;
  /** Snapshot type (full, incremental, logical). */
  type: SnapshotType;
  /** Snapshot state. */
  state: SnapshotState;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of completion. */
  completedAt?: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Number of files in the snapshot. */
  fileCount: number;
  /** The snapshot this one is based on (for incrementals). */
  parentSnapshotId?: string;
  /** Storage path or URI. */
  location: string;
  /** SHA-256 checksum of the manifest. */
  checksum?: string;
}

/** Backup operation result. */
export interface BackupResult {
  /** Whether the backup was created successfully. */
  success: boolean;
  /** Snapshot metadata if successful. */
  snapshot?: BackupMetadata;
  /** Error message on failure. */
  error?: string;
}

/** Restore operation result. */
export interface RestoreResult {
  /** Whether the restore succeeded. */
  success: boolean;
  /** Target LSN or recovery point. */
  recoveryPoint?: string;
  /** Error message on failure. */
  error?: string;
  /** Duration of the restore operation in ms. */
  durationMs: number;
}

/** Point-in-Time-Recovery target specification. */
export interface PITRTarget {
  /** Target timestamp (ISO-8601). */
  targetTime?: string;
  /** Target WAL/LSN position. */
  targetLsn?: string;
  /** Explicit snapshot ID. */
  snapshotId?: string;
}

/** Retention policy for backup pruning. */
export interface RetentionPolicy {
  /** Maximum number of full snapshots to retain. */
  maxFullSnapshots: number;
  /** Maximum total size of all snapshots (bytes). */
  maxTotalBytes: number;
  /** Minimum age of snapshots to consider for deletion (ISO-8601 duration). */
  minAge?: string;
  /** Always keep snapshots newer than this duration (e.g., 'P7D' = 7 days). */
  keepRecent?: string;
}

// ══════════════════════════════════════════════════════════════════════
//  Security & Audit
// ══════════════════════════════════════════════════════════════════════

/** Audit entry severity. */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Audit entry. */
export interface AuditEntry {
  /** Unique entry ID (ULID or UUID). */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Operation that was performed. */
  operation: string;
  /** Who performed the operation. */
  actor: string;
  /** Resource acted upon. */
  resource: string;
  /** Whether the operation succeeded. */
  result: 'success' | 'failure' | 'denied';
  /** Severity level. */
  severity: AuditSeverity;
  /** Optional details. */
  details?: Record<string, unknown>;
  /** Trace ID for distributed tracing correlation. */
  traceId?: string;
}

/** TLS certificate metadata. */
export interface CertInfo {
  /** Subject CN. */
  subject: string;
  /** Issuer CN. */
  issuer: string;
  /** Serial number. */
  serialNumber: string;
  /** Not-before timestamp (ISO-8601). */
  validFrom: string;
  /** Not-after timestamp (ISO-8601). */
  validTo: string;
  /** Days remaining until expiry. */
  daysRemaining: number;
  /** File path on disk. */
  path: string;
  /** Fingerprint (SHA-256). */
  fingerprint: string;
}

/** Certificate expiry warning levels. */
export type CertWarningLevel = 'ok' | 'warning' | 'critical' | 'expired';

/** Security compliance check result. */
export interface SecurityCheck {
  /** Check identifier. */
  id: string;
  /** Check category (e.g., 'tls', 'auth', 'encryption'). */
  category: string;
  /** Human-readable description. */
  description: string;
  /** Severity when failed. */
  severity: 'PASS' | 'WARN' | 'FAIL';
  /** Detailed message. */
  message: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

// ══════════════════════════════════════════════════════════════════════
//  Monitoring
// ══════════════════════════════════════════════════════════════════════

/** Connection pool status. */
export interface ConnectionPoolStatus {
  /** Total connections in pool. */
  total: number;
  /** Currently active connections. */
  active: number;
  /** Idle connections waiting to be reused. */
  idle: number;
  /** Connections waiting to be acquired. */
  waiting: number;
  /** Maximum pool size. */
  maxSize: number;
  /** Pool utilization ratio (active / max). */
  utilization: number;
}

/** Resource usage snapshot. */
export interface ResourceUsageSnapshot {
  /** Memory usage in bytes. */
  memoryBytes: number;
  /** Memory limit in bytes (0 = unlimited). */
  memoryLimitBytes: number;
  /** Memory utilization ratio. */
  memoryUtilization: number;
  /** Current queries per second rate. */
  queriesPerSec: number;
  /** Maximum allowed queries per second. */
  maxQueriesPerSec: number;
  /** CPU usage percentage (0-100). */
  cpuPercent: number;
  /** Connection pool status. */
  connectionPool: ConnectionPoolStatus;
  /** Disk usage in bytes. */
  diskUsedBytes: number;
  /** Disk free in bytes. */
  diskFreeBytes: number;
}

/** Slow query entry. */
export interface SlowQueryEntry {
  /** SQL or operation text. */
  query: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Timestamp when the query started. */
  startTime: string;
  /** Who executed the query. */
  actor?: string;
  /** Shard or partition identifier. */
  shardId?: string;
  /** Whether the query was completed or canceled. */
  completed: boolean;
}

/** Deadlock event. */
export interface DeadlockEvent {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Transaction IDs involved in the deadlock. */
  transactions: string[];
  /** Resources locked by each transaction. */
  resources: string[];
  /** Resolved by killing transaction (or 'automatic'). */
  resolvedBy: string;
}

/** Monitor alert severity. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Alert rule configuration. */
export interface AlertRule {
  /** Rule identifier. */
  id: string;
  /** Rule display name. */
  name: string;
  /** Metric or condition to evaluate. */
  condition: string;
  /** Severity when triggered. */
  severity: AlertSeverity;
  /** Whether the rule is active. */
  enabled: boolean;
  /** ISO-8601 duration for evaluation window. */
  windowDuration: string;
  /** ISO-8601 duration minimum wait before re-triggering. */
  repeatInterval?: string;
  /** Threshold value (interpreted per rule type). */
  threshold: number;
}

// ══════════════════════════════════════════════════════════════════════
//  Storage & Maintenance
// ══════════════════════════════════════════════════════════════════════

/** Maintenance operation type. */
export type MaintenanceOp = 'VACUUM' | 'ANALYZE' | 'REINDEX' | 'REBUILD';

/** Maintenance operation result. */
export interface MaintenanceResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Operation type. */
  operation: MaintenanceOp;
  /** Target identifier (shard ID, table name, index name). */
  target: string;
  /** Human-readable message. */
  message: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Optional detail fields. */
  details?: Record<string, unknown>;
}

/** Database storage stats. */
export interface StorageStats {
  /** Database file size in bytes. */
  fileSizeBytes: number;
  /** Page count. */
  pageCount: number;
  /** Page size in bytes. */
  pageSize: number;
  /** Approximate number of live rows. */
  rowCount: number;
  /** Approximate number of dead rows (awaiting VACUUM). */
  deadRowCount: number;
  /** Fraction of file that is free pages (0.0–1.0). */
  freeSpaceRatio: number;
}

/** Index fragmentation report. */
export interface IndexFragmentation {
  /** Index name. */
  indexName: string;
  /** Table the index belongs to. */
  tableName: string;
  /** Number of pages used by the index. */
  pageCount: number;
  /** Estimated fragmentation ratio (0.0–1.0). */
  fragmentationRatio: number;
}

// ══════════════════════════════════════════════════════════════════════
//  Import / Export
// ══════════════════════════════════════════════════════════════════════

/** Supported import/export formats. */
export type ImportExportFormat = 'csv' | 'jsonl' | 'ndjson' | 'json-array';

/** Import result. */
export interface ImportResult {
  /** Total rows/records processed. */
  totalRows: number;
  /** Rows successfully imported. */
  importedRows: number;
  /** Rows that failed with validation errors. */
  failedRows: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Validation error details. */
  errors?: Array<{ row: number; message: string }>;
}

/** Export result. */
export interface ExportResult {
  /** Total rows exported. */
  totalRows: number;
  /** File format. */
  format: ImportExportFormat;
  /** Output path or stream identifier. */
  outputPath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

// ══════════════════════════════════════════════════════════════════════
//  Replication
// ══════════════════════════════════════════════════════════════════════

/** Replication lag level classification. */
export type LagLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

/** Replication status for a single target. */
export interface ReplicationTargetStatus {
  /** Target node or DC identifier. */
  targetId: string;
  /** Whether the target is connected. */
  connected: boolean;
  /** Replication lag in milliseconds (null if unknown). */
  lagMs: number | null;
  /** Lag level classification. */
  lagLevel: LagLevel;
  /** Number of pending outbox entries. */
  pendingCount: number;
  /** Timestamp of last successful delivery. */
  lastSuccessAt: string | null;
  /** Last error message (null if healthy). */
  lastError: string | null;
}

/** Aggregate replication status. */
export interface ReplicationStatus {
  /** Overall status. */
  overall: LagLevel;
  /** Per-target statuses. */
  targets: ReplicationTargetStatus[];
}

// ══════════════════════════════════════════════════════════════════════
//  Migration / Schema
// ══════════════════════════════════════════════════════════════════════

/** Migration execution state. */
export type MigrationState = 'pending' | 'running' | 'applied' | 'failed' | 'rolled-back';

/** A single migration step. */
export interface MigrationDescriptor {
  /** Migration version (monotonically increasing, e.g., 2026071100). */
  version: number;
  /** Human-readable description. */
  description: string;
  /** Migration state. */
  state: MigrationState;
  /** ISO-8601 timestamp when applied. */
  appliedAt?: string;
  /** Checksum of the migration content. */
  checksum: string;
  /** Duration in milliseconds. */
  durationMs?: number;
}

/** Migration plan (ordered list of pending + current migrations). */
export interface MigrationPlan {
  /** Current schema version. */
  currentVersion: number;
  /** Target version after plan execution. */
  targetVersion: number;
  /** Ordered list of pending migrations. */
  pending: MigrationDescriptor[];
  /** Namespace (e.g., 'sqlvec', 'graphvec', or per-engine). */
  namespace: string;
}
// ── Backwards-compatible aliases ──
/** @deprecated Use {@link BackupMetadata} instead. */
export type BackupSnapshot = BackupMetadata;
/** @deprecated Use {@link ResourceUsageSnapshot} instead. */
export type ResourceUsage = ResourceUsageSnapshot;

/** @deprecated Move to @agentix-e/db-operations-health/types. */
export interface ComponentRegistrationOptions {
  /** Optional metadata key-value pairs. */
  metadata?: Record<string, string>;
  /** Whether the component is critical (failure degrades overall status). */
  critical?: boolean;
}
