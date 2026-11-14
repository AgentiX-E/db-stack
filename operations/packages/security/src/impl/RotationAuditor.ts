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

// ── RotationAuditor ────────────────────────────────────────

export class RotationAuditor {
  private entries: AuditEntry[] = [];
  private seqCounter = 0;

  // ── Recording ────────────────────────────────────────────

  /**
   * Record a rotation event in the audit trail.
   * Each entry is chained to the previous via SHA-256 hash.
   */
  record(event: RotationEvent): AuditEntry {
    this.seqCounter++;
    const prevHash = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.hash : GENESIS_HASH;

    const entry: AuditEntry = {
      seq: this.seqCounter,
      event,
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

  /** Get the last N entries. */
  recent(n: number): AuditEntry[] {
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

      // Check sequence continuity
      if (entry.seq !== i + 1) {
        errors.push(`seq gap at index ${i}: expected ${i + 1}, got ${entry.seq}`);
        chainBroken = true;
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
   */
  generateReport(framework: string): ComplianceReport {
    const events = this.entries.map((e) => e.event);
    const successful = events.filter((e) => e.success);
    const failed = events.filter((e) => !e.success);
    const emergency = events.filter((e) => e.trigger.kind === 'compromise');
    const timeBased = events.filter((e) => e.trigger.kind === 'time' || e.trigger.kind === 'schedule');
    const countBased = events.filter((e) => e.trigger.kind === 'count');

    // Average interval between rotations
    let averageIntervalMs = 0;
    const sorted = [...successful].sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    if (sorted.length >= 2) {
      const totalInterval = (sorted[sorted.length - 1]!.completedAt ?? 0) - (sorted[0]!.completedAt ?? 0);
      averageIntervalMs = totalInterval / (sorted.length - 1);
    }

    const findings: string[] = [];
    let pass = true;

    // Framework-specific checks
    switch (framework.toUpperCase()) {
      case 'PCI-DSS': {
        // PCI-DSS 3.6: keys retired at least annually
        if (sorted.length > 0) {
          const firstRot = sorted[0]!.completedAt ?? sorted[0]!.startedAt;
          const lastRot = sorted[sorted.length - 1]!.completedAt ?? sorted[sorted.length - 1]!.startedAt;
          const spanMs = lastRot - firstRot;
          if (spanMs > 365 * 24 * 3600 * 1000) {
            findings.push('PCI-DSS 3.6.4: key rotation interval may exceed 1 year');
            pass = false;
          }
        }
        if (sorted.length === 0) {
          findings.push('PCI-DSS 3.6: no key rotations recorded — keys must be rotated at least annually');
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
      oldestActiveKeyCreatedAt: events.length > 0 ? events[0]!.startedAt : null,
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
   */
  importJSONL(jsonl: string): number {
    const lines = jsonl.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const entry = JSON.parse(line) as AuditEntry;
      this.entries.push(entry);
      if (entry.seq > this.seqCounter) {
        this.seqCounter = entry.seq;
      }
    }
    return lines.length;
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
