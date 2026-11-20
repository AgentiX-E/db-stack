/**
 * I28 — E2 Rotation Auditor.
 *
 * Compliance-focused audit trail for all key rotation events.
 * Produces verifiable rotation records with:
 *   - Immutable event log (append-only)
 *   - Tamper-evident checksums (chain of SHA-256 hashes)
 *   - Compliance report generation (PCI-DSS, SOC2, HIPAA)
 *   - Export to machine-readable format (JSONL)
 *   - Verification: detect missing or tampered entries
 */

import type { RotationEvent } from '../interfaces/IKeyRotationManager.js';
import crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────

export interface AuditEntry {
  /** Sequence number (monotonic). */
  seq: number;
  /** The rotation event. */
  event: RotationEvent;
  /** SHA-256 hash of the previous entry (chain integrity). */
  prevHash: string;
  /** SHA-256 hash of this entry (tamper detection). */
  hash: string;
  /** When this entry was recorded. */
  recordedAt: number;
}

export interface AuditVerificationResult {
  valid: boolean;
  totalEntries: number;
  errors: string[];
  firstSeq: number;
  lastSeq: number;
  chainBroken: boolean;
}

export interface ComplianceReport {
  generatedAt: number;
  framework: string;
  totalRotations: number;
  successfulRotations: number;
  failedRotations: number;
  emergencyRotations: number;
  timeBasedRotations: number;
  countBasedRotations: number;
  averageIntervalMs: number;
  oldestActiveKeyCreatedAt: number | null;
  findings: string[];
  pass: boolean;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** One year in ms — the PCI-DSS 3.6 rotation window. */
const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * Copy an event so the trail owns its content.
 *
 * Through JSON on purpose: entry hashes cover `JSON.stringify(event)`, so the
 * object that is hashed has to serialise exactly like the original, including key
 * order. A structural clone would be a different shape of the same fact.
 */
function cloneEvent(event: RotationEvent): RotationEvent {
  return JSON.parse(JSON.stringify(event)) as RotationEvent;
}

/**
 * Why an event cannot be evidence, or `null` when it can.
 *
 * These are the invariants the rotation manager itself holds (see
 * `IKeyRotationManager`): `success` and `error` are complements, a successful
 * rotation has finished, and it moved the version it claims to have moved.
 */
function contradictionIn(event: RotationEvent): string | null {
  if (event.success && event.error !== null) return `success with error "${event.error}"`;
  if (!event.success && event.error === null) return 'failure with no error';
  if (event.success && event.completedAt === null) return 'success with no completion time';
  if (event.success && event.toVersion <= event.fromVersion) {
    return `success from v${event.fromVersion} to v${event.toVersion}`;
  }
  return null;
}

// ── RotationAuditor ────────────────────────────────────────

export class RotationAuditor {
  private entries: AuditEntry[] = [];
  private seqCounter = 0;

  // ── Recording ────────────────────────────────────────────

  /**
   * Record a rotation event in the audit trail.
   * Each entry is chained to the previous via SHA-256 hash.
   *
   * The event is **copied**, not referenced: an auditor that stored the caller's
   * object could be rewritten after the fact by the caller, and `verify()` would
   * then report tampering on a trail nobody had touched. The copy is made through
   * JSON because the hash covers `JSON.stringify(event)` — the bytes hashed here
   * have to be the bytes an export writes.
   *
   * A rotation event that describes two outcomes at once is refused, and refusing
   * consumes no sequence number: an event with `success: true` and an `error` is a
   * producer bug, not evidence, and admitting it would put a contradiction into
   * the compliance report as a success.
   */
  record(event: RotationEvent): AuditEntry {
    const contradiction = contradictionIn(event);
    if (contradiction !== null) {
      throw new Error(`rotation event ${event.id} contradicts itself: ${contradiction}`);
    }

    this.seqCounter++;
    const prevHash = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.hash : GENESIS_HASH;

    const entry: AuditEntry = {
      seq: this.seqCounter,
      event: cloneEvent(event),
      prevHash,
      hash: '', // Computed below
      recordedAt: Date.now(),
    };

    entry.hash = this._hashEntry(entry);
    this.entries.push(entry);

    return entry;
  }

  // ── Query ────────────────────────────────────────────────

  /** Get all audit entries. */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /** Get entries for a specific policy. */
  getEntriesByPolicy(policyId: string): AuditEntry[] {
    return this.entries.filter((e) => e.event.policyId === policyId);
  }

  /**
   * Get the last N entries.
   *
   * `0` and negative counts return nothing. `slice(-0)` is `slice(0)`, so the
   * guard is what stops "the last zero entries" from returning every entry.
   */
  recent(n: number): AuditEntry[] {
    if (n <= 0) return [];
    return this.entries.slice(-n);
  }

  /** Get entry by sequence number. */
  bySeq(seq: number): AuditEntry | null {
    return this.entries.find((e) => e.seq === seq) ?? null;
  }

  /** Count of recorded entries. */
  get count(): number {
    return this.entries.length;
  }

  // ── Verification ─────────────────────────────────────────

  /**
   * Verify the entire audit chain for integrity.
   * Checks:
   *   1. Sequential seq numbering (no gaps)
   *   2. Chain hash integrity (no tampering)
   *   3. Consistent timestamps (no time travel)
   */
  verify(): AuditVerificationResult {
    const errors: string[] = [];
    let chainBroken = false;

    if (this.entries.length === 0) {
      return {
        valid: true,
        totalEntries: 0,
        errors: [],
        firstSeq: 0,
        lastSeq: 0,
        chainBroken: false,
      };
    }

    let prevHash = GENESIS_HASH;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;

      // Check sequence continuity. No `chainBroken = true` here on purpose: `seq`
      // is part of the hashed content, so a gap cannot occur without that entry's
      // hash check failing too — and that check is what marks the chain broken. The
      // assignment used to sit here and could not change the result.
      if (entry.seq !== i + 1) {
        errors.push(`seq gap at index ${i}: expected ${i + 1}, got ${entry.seq}`);
      }

      // Check chain hash
      if (entry.prevHash !== prevHash) {
        errors.push(`chain broken at seq ${entry.seq}: expected prevHash ${prevHash}, got ${entry.prevHash}`);
        chainBroken = true;
      }

      // Verify this entry's hash
      const computedHash = this._hashEntry(entry);
      if (computedHash !== entry.hash) {
        errors.push(`hash mismatch at seq ${entry.seq}: entry may be tampered`);
        chainBroken = true;
      }

      // Check timestamp ordering
      if (i > 0 && entry.recordedAt < this.entries[i - 1]!.recordedAt) {
        errors.push(
          `timestamp regression at seq ${entry.seq}: ${entry.recordedAt} < ${this.entries[i - 1]!.recordedAt}`,
        );
      }

      prevHash = entry.hash;
    }

    return {
      valid: errors.length === 0,
      totalEntries: this.entries.length,
      errors,
      firstSeq: this.entries[0]!.seq,
      lastSeq: this.entries[this.entries.length - 1]!.seq,
      chainBroken,
    };
  }

  // ── Compliance Reports ───────────────────────────────────

  /**
   * Generate a compliance report for a given framework.
   *
   * A framework with no checks behind it cannot pass. The `switch` used to end at
   * HIPAA, so `generateReport('SOX')` returned `pass: true` with no findings —
   * the caller read assurance where nothing had run.
   */
  generateReport(framework: string): ComplianceReport {
    const events = this.entries.map((e) => e.event);
    const successful = events.filter((e) => e.success);
    const failed = events.filter((e) => !e.success);
    const emergency = events.filter((e) => e.trigger.kind === 'compromise');
    const timeBased = events.filter((e) => e.trigger.kind === 'time' || e.trigger.kind === 'schedule');
    const countBased = events.filter((e) => e.trigger.kind === 'count');

    // Every successful rotation carries a completion time: `record()` and
    // `importJSONL()` both refuse one that does not. So the oldest key still in
    // service is the earliest completion, and the interval arithmetic needs no
    // placeholder — a `?? 0` here would have reported a 1970 key as the oldest.
    const completed = [...successful].sort((a, b) => a.completedAt! - b.completedAt!);
    const firstCompletedAt = completed.length > 0 ? completed[0]!.completedAt! : null;
    const lastCompletedAt = completed.length > 0 ? completed[completed.length - 1]!.completedAt! : null;
    const spanMs = firstCompletedAt !== null && lastCompletedAt !== null ? lastCompletedAt - firstCompletedAt : 0;
    const averageIntervalMs = completed.length >= 2 ? spanMs / (completed.length - 1) : 0;

    const findings: string[] = [];
    let pass = true;

    // Framework-specific checks
    switch (framework.toUpperCase()) {
      case 'PCI-DSS': {
        // PCI-DSS 3.6: keys retired at least annually
        if (completed.length === 0) {
          findings.push('PCI-DSS 3.6: no key rotations recorded — keys must be rotated at least annually');
          pass = false;
          break;
        }
        if (spanMs > YEAR_MS) {
          findings.push('PCI-DSS 3.6.4: key rotation interval may exceed 1 year');
          pass = false;
        }
        break;
      }
      case 'SOC2': {
        // SOC2 CC6.3: documented rotation procedures
        if (events.length === 0) {
          findings.push('SOC2 CC6.3: no rotation events documented');
          pass = false;
        }
        if (failed.length > 0) {
          findings.push(`SOC2 CC6.3: ${failed.length} failed rotation(s) — review required`);
        }
        break;
      }
      case 'HIPAA': {
        // HIPAA §164.312(e)(1): transmission security
        if (events.length === 0) {
          findings.push('HIPAA 164.312: no encryption key rotation records');
          pass = false;
        }
        break;
      }
      default: {
        findings.push(`compliance framework "${framework}" is not supported: no checks were applied`);
        pass = false;
      }
    }

    return {
      generatedAt: Date.now(),
      framework,
      totalRotations: events.length,
      successfulRotations: successful.length,
      failedRotations: failed.length,
      emergencyRotations: emergency.length,
      timeBasedRotations: timeBased.length,
      countBasedRotations: countBased.length,
      averageIntervalMs,
      // The oldest key still in service: the completion of the earliest successful
      // rotation. A failed rotation created no key, so it cannot date one.
      oldestActiveKeyCreatedAt: firstCompletedAt,
      findings,
      pass,
    };
  }

  /**
   * Export audit trail as JSONL.
   */
  exportJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * Import audit trail from JSONL.
   *
   * This is a **verification**, not a copy. Every line is checked against the line
   * before it — sequence number, `prevHash` linkage, the entry's own hash, and the
   * coherence of the event it carries — before any of it becomes this auditor's
   * trail. The old implementation pushed entries while parsing, so a malformed line
   * left the trail half imported, and a forged line was accepted outright and then
   * used as the parent of the next real rotation.
   *
   * A chain has one genesis: importing into a non-empty trail would splice two
   * chains together with duplicate sequence numbers, so it is refused.
   */
  importJSONL(jsonl: string): number {
    if (this.entries.length > 0) {
      throw new Error(`audit import requires an empty trail: ${this.entries.length} entries already recorded`);
    }

    const lines = jsonl.split('\n').filter((line) => line.trim());
    const imported: AuditEntry[] = [];
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]!) as AuditEntry;
      } catch {
        throw new Error(`audit import rejected at line ${lineNumber}: not JSON`);
      }

      const expectedSeq = imported.length + 1;
      if (entry.seq !== expectedSeq) {
        throw new Error(`audit import rejected at line ${lineNumber}: expected seq ${expectedSeq}, got ${entry.seq}`);
      }
      if (entry.prevHash !== prevHash) {
        throw new Error(
          `audit import rejected at line ${lineNumber}: prevHash does not chain onto seq ${expectedSeq - 1}`,
        );
      }
      const contradiction = contradictionIn(entry.event);
      if (contradiction !== null) {
        throw new Error(`audit import rejected at line ${lineNumber}: event contradicts itself: ${contradiction}`);
      }
      if (this._hashEntry(entry) !== entry.hash) {
        throw new Error(
          `audit import rejected at line ${lineNumber}: hash mismatch — the line changed after it was hashed`,
        );
      }

      const verified: AuditEntry = { ...entry, event: cloneEvent(entry.event) };
      imported.push(verified);
      prevHash = verified.hash;
    }

    this.entries = imported;
    this.seqCounter = imported.length;
    return imported.length;
  }

  /**
   * Reset the audit trail.
   */
  reset(): void {
    this.entries = [];
    this.seqCounter = 0;
  }

  // ── Internal ─────────────────────────────────────────────

  private _hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
    // Hash: seq + prevHash + JSON(event) + recordedAt
    const content = [
      entry.seq.toString(),
      entry.prevHash,
      JSON.stringify(entry.event),
      entry.recordedAt.toString(),
    ].join('|');

    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}
