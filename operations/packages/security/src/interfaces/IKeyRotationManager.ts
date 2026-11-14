/**
 * I28 — E2 Key Rotation Policy interfaces.
 *
 * Defines rotation triggers, scheduling rules, and re-encryption
 * strategy for automated key lifecycle management.
 */

import type { WrappedKey } from "../impl/KeyManager.js";

// ── Rotation Trigger ───────────────────────────────────────

/** What triggers a key rotation. */
export type RotationTrigger =
  | { kind: "time"; maxAgeMs: number }
  | { kind: "count"; maxEncryptions: number }
  | { kind: "volume"; maxBytes: number }
  | { kind: "manual" }
  | { kind: "schedule"; cron: string }
  | { kind: "compromise"; reason: string };

/** Rotation priority — determines order when multiple rotations are pending. */
export type RotationPriority = "low" | "normal" | "high" | "critical";

// ── Rotation Policy ────────────────────────────────────────

export interface KeyRotationPolicy {
  /** Unique policy identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What triggers rotation */
  trigger: RotationTrigger;
  /** Whether to re-encrypt existing data after rotation */
  reEncrypt: boolean;
  /** Max batch size for re-encryption (0 = no limit) */
  reEncryptBatchSize: number;
  /** Key versions to keep after rotation (0 = unlimited) */
  maxKeyVersions: number;
  /** Rotation priority */
  priority: RotationPriority;
  /** Whether this policy is active */
  enabled: boolean;
}

// ── Rotation State ─────────────────────────────────────────

export interface KeyRotationState {
  /** The policy this state belongs to */
  policyId: string;
  /** Current key version */
  currentVersion: number;
  /** Timestamp of last rotation */
  lastRotatedAt: number | null;
  /** Number of encryptions since last rotation */
  encryptionsSinceRotation: number;
  /** Bytes encrypted since last rotation */
  bytesSinceRotation: number;
  /** Whether a rotation is in progress */
  rotationInProgress: boolean;
  /** Number of re-encryption operations remaining */
  pendingReEncryptions: number;
  /** When the next scheduled rotation is due (epoch ms) */
  nextRotationDue: number | null;
}

// ── Rotation Event ─────────────────────────────────────────

export interface RotationEvent {
  /** Unique event identifier */
  id: string;
  /** Policy that triggered the rotation */
  policyId: string;
  /** Old key version (before rotation) */
  fromVersion: number;
  /** New key version (after rotation) */
  toVersion: number;
  /** Trigger that caused the rotation */
  trigger: RotationTrigger;
  /** When the rotation started */
  startedAt: number;
  /** When the rotation completed (null if still in progress) */
  completedAt: number | null;
  /** Whether the rotation succeeded */
  success: boolean;
  /** Error message if failed */
  error: string | null;
  /** Number of blobs re-encrypted (0 if re-encrypt disabled) */
  reEncryptedCount: number;
  /** Version of key that was retired (if maxKeyVersions exceeded) */
  retiredVersion: number | null;
}

// ── Rotation Statistics ────────────────────────────────────

export interface RotationStats {
  totalRotations: number;
  successfulRotations: number;
  failedRotations: number;
  lastRotationAt: number | null;
  averageDurationMs: number;
  totalReEncrypted: number;
  activeKeyVersions: number;
}

// ── Re-encryption Result ───────────────────────────────────

export interface ReEncryptionResult {
  totalBlobs: number;
  reEncrypted: number;
  skipped: number; // Already using new key
  failed: number;
  durationMs: number;
}

// ── Key Rotation Manager Interface ─────────────────────────

export interface IKeyRotationManager {
  /** Register a rotation policy. */
  registerPolicy(policy: KeyRotationPolicy): void;
  /** Get all registered policies. */
  getPolicies(): KeyRotationPolicy[];
  /** Check if any policy triggers a rotation. Returns policies that are due. */
  checkPolicies(): Promise<KeyRotationPolicy[]>;
  /** Execute rotation for a specific policy. */
  rotate(policyId: string): Promise<RotationEvent>;
  /** Get the rotation state for a policy. */
  getState(policyId: string): Promise<KeyRotationState | null>;
  /** Get rotation event history. */
  getHistory(policyId?: string): Promise<RotationEvent[]>;
  /** Get overall rotation statistics. */
  getStats(): Promise<RotationStats>;
  /** Re-encrypt data with the newest key after rotation. */
  reEncrypt(policyId: string, blobIterator: AsyncIterable<Buffer>): Promise<ReEncryptionResult>;
  /** Force an emergency rotation (e.g., key compromise). */
  emergencyRotate(policyId: string, reason: string): Promise<RotationEvent>;
  /** Start the scheduler (periodic policy checks). */
  startScheduler(checkIntervalMs: number): void;
  /** Stop the scheduler. */
  stopScheduler(): void;
}
