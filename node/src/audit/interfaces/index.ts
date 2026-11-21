/**
 * audit interfaces — Engine-agnostic audit log and export abstractions.
 *
 * @module @agentix-e/db-node/audit/interfaces
 */

import type { AuditEntry, AuditSeverity, ImportExportFormat } from '../../core/types.js';
import type { AuditChainFailure, AuditChainFailureReason, AuditTrailVerification } from '../impl/auditChain.js';

export type { AuditChainFailure, AuditChainFailureReason, AuditTrailVerification };

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
   * Prove that the trail is what it says it is.
   *
   * An audit store is the component a regulator asks "how do you know nobody
   * edited this", so the answer cannot be a property of the deployment's
   * discipline. Every store in this package chains each entry to the one before
   * it and answers this call by recomputing the chain; an implementation that
   * cannot do so must say `ok: false` rather than answer `ok: true` because it
   * checked nothing.
   *
   * The report names the first link that does not hold — an edited entry, a
   * deleted one, a re-ordered pair, a line that is not JSON — and counts what it
   * examined, so "no failures" is distinguishable from "no entries".
   */
  verify(): Promise<AuditTrailVerification>;

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
