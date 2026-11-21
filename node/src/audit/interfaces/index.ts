/**
 * audit interfaces — Engine-agnostic audit log and export abstractions.
 *
 * @module @agentix-e/db-node/audit/interfaces
 */

import type { AuditEntry, AuditSeverity, ImportExportFormat } from '../../core/types.js';

/** Options for writing an audit entry. */
export interface WriteAuditEntryOptions {
  /** The operation being audited. */
  operation: string;
  /** Who performed the operation. */
  actor: string;
  /** Resource acted upon. */
  resource: string;
  /** Whether the operation succeeded. */
  result: 'success' | 'failure' | 'denied';
  /** Severity level. */
  severity?: AuditSeverity;
  /** Optional details. */
  details?: Record<string, unknown>;
  /** Trace ID for correlation. */
  traceId?: string;
}

/** Filter options for querying audit logs. */
export interface AuditQueryFilter {
  startTime?: Date;
  endTime?: Date;
  operation?: string;
  actor?: string;
  result?: 'success' | 'failure' | 'denied';
  severity?: AuditSeverity;
  limit?: number;
  offset?: number;
}

/**
 * Audit store — persistent audit log backend.
 */
export interface IAuditStore {
  /**
   * Write an audit entry.
   * Returns the generated entry ID.
   */
  write(entry: WriteAuditEntryOptions): Promise<string>;

  /**
   * Query audit entries with filters.
   */
  query(filter: AuditQueryFilter): Promise<AuditEntry[]>;

  /**
   * Get a single audit entry by ID.
   */
  get(id: string): Promise<AuditEntry | null>;

  /**
   * Get the total count of audit entries.
   */
  count(filter?: AuditQueryFilter): Promise<number>;

  /**
   * Delete entries older than the given timestamp.
   */
  pruneOlderThan(timestamp: Date): Promise<number>;

  /**
   * Graceful shutdown (optional).
   *
   * Stores that do background work after a write returns — compressing a rotated
   * segment, flushing a buffer — implement this so a caller can wait for that work
   * instead of discovering it as a file that disappears later. In-memory stores
   * have nothing to drain and may omit it.
   */
  close?(): Promise<void>;
}

/** Options for audit log export. */
export interface ExportOptions {
  /** Output format. */
  format: ImportExportFormat;
  /** Filter for entries to export. */
  filter?: AuditQueryFilter;
}

/**
 * Audit exporter — exports audit entries to structured file formats.
 */
export interface IAuditExporter {
  /**
   * Export audit entries to the given output path.
   * Returns the number of exported entries.
   */
  exportToFile(outputPath: string, options: ExportOptions): Promise<number>;

  /**
   * Export as a string (for API responses or streaming).
   */
  exportToString(options: ExportOptions): Promise<string>;
}
