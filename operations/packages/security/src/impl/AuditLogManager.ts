/**
 * I29 — E3 Audit Log Manager.
 *
 * Production-grade structured audit logger with:
 *   - Hash-chained tamper-evident event log (SHA-256)
 *   - In-memory ring buffer + batched JSONL persistence
 *   - Full-featured query engine (time, category, severity, actor, free-text)
 *   - Configurable retention policy with automatic pruning
 *   - Chain integrity verification
 *   - Compliance export (JSONL)
 */

import {
  type IAuditLogger,
  type AuditEvent,
  type AuditQuery,
  type AuditStats,
  type AuditSeverity,
  type AuditCategory,
  type AuditRetentionPolicy,
} from '../interfaces/IAuditLogger.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Constants ──────────────────────────────────────────────

const MAX_BUFFER_SIZE = 100;
const AUTO_FLUSH_INTERVAL_MS = 10_000; // 10s
const DEFAULT_RETENTION_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 90 days
const DEFAULT_RETENTION_MAX_EVENTS = 1_000_000;
const GENESIS_HASH = crypto.createHash('sha256').update('audit-genesis').digest('hex');

// ── AuditLogManager ─────────────────────────────────────────

export class AuditLogManager implements IAuditLogger {
  private events: AuditEvent[] = [];
  private seqCounter = 0;
  private buffer: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private logFilePath: string;
  private retention: Required<AuditRetentionPolicy>;

  constructor(options?: { logFilePath?: string; retention?: AuditRetentionPolicy; autoStart?: boolean }) {
    this.logFilePath = options?.logFilePath ?? path.join(process.cwd(), 'audit.jsonl');
    this.retention = {
      maxEvents: options?.retention?.maxEvents ?? DEFAULT_RETENTION_MAX_EVENTS,
      maxAgeMs: options?.retention?.maxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS,
      minRetain: options?.retention?.minRetain ?? 1000,
    };

    if (options?.autoStart === true) {
      this._startAutoFlush();
    }
  }

  // ── Logging ───────────────────────────────────────────────

  async log(partial: Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>): Promise<AuditEvent> {
    const event = this._buildEvent(partial);
    this._append(event);
    return event;
  }

  async logBatch(
    partials: Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>[],
  ): Promise<AuditEvent[]> {
    const results: AuditEvent[] = [];
    for (const partial of partials) {
      const event = this._buildEvent(partial);
      results.push(event);
      // Push immediately so subsequent events chain correctly
      this.events.push(event);
      this.buffer.push(event);
    }
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      void this.flush();
    }
    return results;
  }

  // ── Query ─────────────────────────────────────────────────

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    let results = [...this.events];

    // Time range
    if (q.timeRange) {
      results = results.filter((e) => e.timestamp >= q.timeRange!.from && e.timestamp <= q.timeRange!.to);
    }

    // Categories
    if (q.categories && q.categories.length > 0) {
      results = results.filter((e) => q.categories!.includes(e.category));
    }

    // Severities
    if (q.severities && q.severities.length > 0) {
      results = results.filter((e) => q.severities!.includes(e.severity));
    }

    // Actor IDs
    if (q.actorIds && q.actorIds.length > 0) {
      results = results.filter((e) => q.actorIds!.includes(e.actor.id));
    }

    // Resource types
    if (q.resourceTypes && q.resourceTypes.length > 0) {
      results = results.filter((e) => q.resourceTypes!.includes(e.resource.type));
    }

    // Success
    if (q.success !== undefined) {
      results = results.filter((e) => e.success === q.success);
    }

    // Free-text search
    if (q.search) {
      const term = q.search.toLowerCase();
      results = results.filter(
        (e) =>
          e.message.toLowerCase().includes(term) ||
          e.action.toLowerCase().includes(term) ||
          e.actor.id.toLowerCase().includes(term) ||
          e.resource.id.toLowerCase().includes(term),
      );
    }

    // Sort
    const sortBy = q.sortBy ?? 'timestamp';
    const sortDir = q.sortDir ?? 'asc';
    results.sort((a, b) => {
      let cmp: number;
      if (sortBy === 'seq') cmp = a.seq - b.seq;
      else if (sortBy === 'severity') cmp = severityWeight(a.severity) - severityWeight(b.severity);
      else if (sortBy === 'category') cmp = a.category.localeCompare(b.category);
      else cmp = a.timestamp - b.timestamp;

      return sortDir === 'desc' ? -cmp : cmp;
    });

    // Pagination
    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  // ── Statistics ────────────────────────────────────────────

  async getStats(): Promise<AuditStats> {
    const stats: AuditStats = {
      totalEvents: this.events.length,
      eventsByCategory: {},
      eventsBySeverity: {},
      eventsByActor: {},
      failedEvents: 0,
      oldestEventAt: this.events.length > 0 ? this.events[0]!.timestamp : null,
      newestEventAt: this.events.length > 0 ? this.events[this.events.length - 1]!.timestamp : null,
    };

    for (const event of this.events) {
      stats.eventsByCategory[event.category] = (stats.eventsByCategory[event.category] || 0) + 1;
      stats.eventsBySeverity[event.severity] = (stats.eventsBySeverity[event.severity] || 0) + 1;
      stats.eventsByActor[event.actor.id] = (stats.eventsByActor[event.actor.id] || 0) + 1;
      if (!event.success) stats.failedEvents++;
    }

    return stats;
  }

  // ── Integrity Verification ────────────────────────────────

  async verifyIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i]!;

      // Sequence check
      if (event.seq !== i + 1) {
        errors.push(`seq gap at index ${i}: expected ${i + 1}, got ${event.seq}`);
      }

      // Chain check
      if (event.prevHash !== prevHash) {
        errors.push(`chain broken at seq ${event.seq}: prevHash mismatch`);
      }

      // Hash check
      const computed = this._computeHash(event);
      if (computed !== event.hash) {
        errors.push(`hash mismatch at seq ${event.seq}: event may be tampered`);
      }

      prevHash = event.hash ?? computed;
    }

    return { valid: errors.length === 0, errors };
  }

  // ── Export ────────────────────────────────────────────────

  async exportJSONL(query?: AuditQuery): Promise<string> {
    const events = query ? await this.query(query) : this.events;
    return events.map((e) => JSON.stringify(e)).join('\n');
  }

  // ── Pruning ───────────────────────────────────────────────

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const before = this.events.length;

    // Keep minRetain events regardless of age
    const minRetain = this.retention.minRetain;
    const eligible = this.events.filter((e) => e.timestamp < cutoff);

    if (eligible.length <= minRetain) return 0;

    // Remove the oldest eligible events, but keep minRetain
    const toRemove = eligible.slice(0, eligible.length - minRetain);
    const idsToRemove = new Set(toRemove.map((e) => e.id));

    this.events = this.events.filter((e) => !idsToRemove.has(e.id));
    return before - this.events.length;
  }

  // ── Flush ─────────────────────────────────────────────────

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(this.logFilePath, lines, 'utf-8');
    this.buffer = [];

    // Auto-prune after flush
    if (this.retention.maxEvents && this.events.length > this.retention.maxEvents) {
      const excess = this.events.length - this.retention.maxEvents;
      const minRetain = this.retention.minRetain;
      const toRemove = Math.min(excess, this.events.length - minRetain);
      if (toRemove > 0) {
        this.events = this.events.slice(toRemove);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Stop the auto-flush timer.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    void this.flush();
  }

  /**
   * Get total event count (for testing).
   */
  get eventCount(): number {
    return this.events.length;
  }

  // ── Internal ─────────────────────────────────────────────

  private _buildEvent(partial: Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>): AuditEvent {
    this.seqCounter++;
    const prevHash: string = this.events.length > 0 ? (this.events[this.events.length - 1]!.hash ?? '') : GENESIS_HASH;

    const event: Omit<AuditEvent, 'hash'> = {
      ...partial,
      id: crypto.randomUUID(),
      seq: this.seqCounter,
      timestamp: Date.now(),
      prevHash,
    };

    return { ...event, hash: this._computeHash(event) };
  }

  private _append(event: AuditEvent): void {
    this.events.push(event);
    this.buffer.push(event);

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      void this.flush();
    }
  }

  private _computeHash(event: Omit<AuditEvent, 'hash'>): string {
    const content = JSON.stringify({
      id: event.id,
      seq: event.seq,
      timestamp: event.timestamp,
      category: event.category,
      severity: event.severity,
      action: event.action,
      message: event.message,
      actor: event.actor,
      resource: event.resource,
      success: event.success,
      error: event.error,
      metadata: event.metadata,
      prevHash: event.prevHash,
    });
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  private _startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, AUTO_FLUSH_INTERVAL_MS);
  }
}

// ── Helpers ─────────────────────────────────────────────────

function severityWeight(s: AuditSeverity): number {
  switch (s) {
    case 'debug':
      return 0;
    case 'info':
      return 1;
    case 'warning':
      return 2;
    case 'error':
      return 3;
    case 'critical':
      return 4;
    default:
      return -1;
  }
}
