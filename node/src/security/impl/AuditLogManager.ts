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
  type AuditIntegrityResult,
  type AuditRetentionAnchor,
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
  /** What retention has removed from the head of the chain, if anything. */
  private anchor: AuditRetentionAnchor | null = null;

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
      // Append immediately so subsequent events in the batch chain onto this one.
      this._append(event);
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

    // Pagination. A negative limit cannot mean "everything" — it means the caller
    // computed a count that went wrong — and `slice(0, -1)` would silently return
    // all but the last row, so the only safe reading of a non-positive limit is
    // "no results". A negative offset is clamped to the start of the result.
    const offset = Math.max(0, q.offset ?? 0);
    const limit = q.limit ?? results.length;
    if (limit <= 0) return [];
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

  async verifyIntegrity(): Promise<AuditIntegrityResult> {
    const errors: string[] = [];
    // A chain that lost its head still continues from a known hash: the anchor the
    // retention policy recorded when it removed those events. Without this, every
    // prune would report the manager's own policy as tampering.
    let prevHash = this.anchor?.lastRemovedHash ?? GENESIS_HASH;
    const expectedSeq = (this.anchor?.lastRemovedSeq ?? 0) + 1;

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i]!;

      // Sequence check
      if (event.seq !== expectedSeq + i) {
        errors.push(`seq gap at index ${i}: expected ${expectedSeq + i}, got ${event.seq}`);
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

      // Keep walking from the computed hash when the stored one is gone, so a
      // single damaged record costs one error instead of breaking every successor
      // after it. The damage is reported once, where it happened.
      prevHash = event.hash ?? computed;
    }

    return {
      valid: errors.length === 0,
      errors,
      truncated: this.anchor === null ? null : { ...this.anchor },
    };
  }

  // ── Export ────────────────────────────────────────────────

  async exportJSONL(query?: AuditQuery): Promise<string> {
    const events = query ? await this.query(query) : this.events;
    return events.map((e) => JSON.stringify(e)).join('\n');
  }

  // ── Pruning ───────────────────────────────────────────────

  async prune(olderThanMs: number): Promise<number> {
    return this._pruneOlderThan(Date.now() - olderThanMs);
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

    // Retention is applied after the write, never before it: an event that is too
    // old for the window is still evidence, and the file keeps it.
    this._applyRetention();
  }

  // ── Retention ─────────────────────────────────────────────

  /**
   * Remove the leading events older than `cutoff`, keeping `minRetain` events.
   *
   * Only a prefix is removed. Retention on a hash chain cannot delete an event in
   * the middle: the entry after it hashes a parent that would then be missing from
   * the trail, and no anchor can express "one gap, in the middle". A non-monotonic
   * timestamp therefore stops the scan — it never causes a hole.
   */
  private _pruneOlderThan(cutoff: number): number {
    return this._dropLeading(this._leadingOlderThan(cutoff));
  }

  /**
   * How many leading events are older than `cutoff`.
   *
   * The prefix is a search, and `findIndex` is that search over a list instead of a
   * `while` whose body advances an index: emptying such a body leaves an index that
   * never moves, which is a loop no timer can interrupt — JavaScript cannot
   * preëmpt synchronous code, so the case running it never reports and a mutation
   * run records an abandoned run rather than a failing test (P3-18).
   *
   * `findIndex` answers `-1` when nothing is kept, which is every event: the whole
   * list is the prefix.
   */
  private _leadingOlderThan(cutoff: number): number {
    const firstKept = this.events.findIndex((event) => !(event.timestamp < cutoff));
    return firstKept === -1 ? this.events.length : firstKept;
  }

  /** Everything the retention policy says about the current window. */
  private _applyRetention(): void {
    const { maxAgeMs, maxEvents, minRetain } = this.retention;
    const now = Date.now();

    let drop = 0;
    if (maxAgeMs > 0) {
      drop = this._leadingOlderThan(now - maxAgeMs);
    }
    // The count ceiling can force a bigger prefix than the age rule did, but it can
    // never remove events the age rule would have kept inside the window: the
    // surplus is by definition at the head.
    if (maxEvents > 0 && this.events.length - drop > maxEvents) {
      drop = this.events.length - maxEvents;
    }

    this._dropLeading(drop);
  }

  /**
   * Remove `count` events from the head and record that it happened.
   *
   * The anchor is what keeps the retained chain verifiable: the first survivor's
   * `prevHash` points at the newest removed event, so verification starts there
   * rather than at genesis.
   */
  private _dropLeading(count: number): number {
    // `minRetain` is a floor for every caller: an explicit `prune()` and the policy
    // applied on flush both go through here, so the floor cannot be honoured by one
    // path and forgotten by the other.
    const allowed = Math.min(count, this.events.length - this.retention.minRetain);
    if (allowed <= 0) return 0;

    const removed = this.events.slice(0, allowed);
    const newest = removed[removed.length - 1]!;
    this.anchor = {
      removedEvents: (this.anchor?.removedEvents ?? 0) + removed.length,
      lastRemovedSeq: newest.seq,
      lastRemovedHash: newest.hash ?? '',
      at: Date.now(),
    };
    this.events = this.events.slice(allowed);

    return removed.length;
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
      // A copy, not the caller's object: an audit record that shares structure with
      // its producer can be rewritten after the fact — `partial.actor.id = 'x'` would
      // change a stored event and the next `verifyIntegrity()` would blame tampering
      // on a document nobody had touched.
      ...structuredClone(partial),
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
    const timer = setInterval(() => {
      void this.flush();
    }, AUTO_FLUSH_INTERVAL_MS);
    // A referenced interval keeps the event loop alive, so a service that enabled
    // auto-flush could never exit — and neither could a test process. `destroy()`
    // still clears it; this only stops the timer from being the reason a process
    // stays up.
    timer.unref();
    this.flushTimer = timer;
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
