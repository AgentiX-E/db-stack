/**
 * I28 — E2 Key Rotation Policy interfaces.
 *
 * Defines rotation triggers, scheduling rules, and re-encryption
 * strategy for automated key lifecycle management.
 */

import type { WrappedKey } from '../impl/KeyManager.js';

// ── Rotation Trigger ───────────────────────────────────────

/** What triggers a key rotation. */
export type RotationTrigger =
  | { kind: 'time'; maxAgeMs: number }
  | { kind: 'count'; maxEncryptions: number }
  | { kind: 'volume'; maxBytes: number }
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string }
  | { kind: 'compromise'; reason: string };

/** Rotation priority — determines order when multiple rotations are pending. */
export type RotationPriority = 'low' | 'normal' | 'high' | 'critical';

// ── Rotation Policy ────────────────────────────────────────

export interface KeyRotationPolicy {
  /** Unique policy identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What triggers rotation */
  trigger: RotationTrigger;
  /**
   * Whether existing data must be re-encrypted after a rotation.
   *
   * The manager cannot reach the data — it lives in the engine, behind
   * {@link ReEncryptSource} — so this flag is what decides whether the source is
   * asked at all, and {@link RotationEvent.reEncryption} records what happened.
   * A policy that asks for re-encryption and gets none is reported as `deferred`,
   * not as a clean rotation.
   */
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
  /**
   * Re-encryption passes still owed: `1` when the last pass stopped at
   * `reEncryptBatchSize` with blobs still to read, `0` when the source was
   * exhausted.
   *
   * Passes, not blobs: the manager never sees the source's size, so a blobs-left
   * number would be a guess dressed as a measurement.
   */
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
  /** Number of blobs re-encrypted by this rotation (0 unless `reEncryption` is `completed`) */
  reEncryptedCount: number;
  /** What happened to the re-encryption this policy asked for. */
  reEncryption: ReEncryptionOutcome;
  /** Version of key that was retired (if maxKeyVersions exceeded) */
  retiredVersion: number | null;
}

/**
 * What became of a policy's `reEncrypt` request.
 *
 * `deferred` is a rotation that succeeded but left data on the old key, and it is
 * a separate state from `failed` because a caller reacts differently: deferred
 * means "find a source and run `reEncrypt`", failed means "the source was there
 * and it broke".
 */
export type ReEncryptionOutcome = 'not-requested' | 'completed' | 'deferred' | 'failed';

/**
 * Where the blobs to re-encrypt come from — the engine-agnostic seam.
 *
 * A rotation manager drives crypto and policy; it has no idea how a database
 * stores rows, documents or objects. The caller supplies a callback that walks
 * whatever the engine has, yields each blob under the old key, yields `null` for
 * a blob the engine already knows is on the current key (the only component that
 * can know that is the one holding the version metadata), and is called again
 * while {@link KeyRotationState.pendingReEncryptions} is `1`.
 *
 * Returning `null` (or a promise of `null`) means "not now": the rotation is
 * recorded as `deferred` rather than pretending the data was migrated.
 */
export type ReEncryptSource = (
  policyId: string,
  newVersion: number,
) => AsyncIterable<Buffer | null> | null | Promise<AsyncIterable<Buffer | null> | null>;

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
  /** Blobs taken from the source, including the ones it declined to hand over. */
  totalBlobs: number;
  /** Blobs rewritten under the new key and verified to round-trip. */
  reEncrypted: number;
  /** Blobs the source yielded as `null`: already under the current key. */
  skipped: number;
  /** Blobs that could not be re-encrypted: undecryptable, or did not round-trip. */
  failed: number;
  durationMs: number;
}

// ── Key Rotation Manager Interface ─────────────────────────

export interface IKeyRotationManager {
  /** Register a rotation policy. */
  registerPolicy(policy: KeyRotationPolicy): void;
  /** Get all registered policies. */
  getPolicies(): KeyRotationPolicy[];
  /**
   * Check if any policy triggers a rotation; returns the policies that are due.
   *
   * Ordered by `priority` (critical first), because this is the order the
   * scheduler works through and a document store that is going to rotate one key
   * this tick should rotate the compromised one. Registration order breaks ties.
   */
  checkPolicies(): Promise<KeyRotationPolicy[]>;
  /** Execute rotation for a specific policy. */
  rotate(policyId: string): Promise<RotationEvent>;
  /** Get the rotation state for a policy. */
  getState(policyId: string): Promise<KeyRotationState | null>;
  /** Get rotation event history. */
  getHistory(policyId?: string): Promise<RotationEvent[]>;
  /** Get overall rotation statistics. */
  getStats(): Promise<RotationStats>;
  /**
   * Re-encrypt data with the newest key after rotation.
   *
   * Reads at most `policy.reEncryptBatchSize` blobs per pass (`0` = one pass over
   * everything) and leaves `pendingReEncryptions` set while work remains, so a
   * caller can bound the work a rotation does without losing track of the rest.
   */
  reEncrypt(policyId: string, blobIterator: AsyncIterable<Buffer | null>): Promise<ReEncryptionResult>;

  /**
   * Record an encryption so the `count` and `volume` triggers have a counter.
   *
   * On the interface, not only on the class: `RotationTrigger` declares `count`
   * and `volume`, and without this method no code holding an
   * `IKeyRotationManager` could ever make those triggers fire. Recording against
   * an unknown policy is a no-op — the caller is often encrypting during startup,
   * before policies are registered.
   */
  recordEncryption(policyId: string, bytes: number): void;
  /** Force an emergency rotation (e.g., key compromise). */
  emergencyRotate(policyId: string, reason: string): Promise<RotationEvent>;
  /** Start the scheduler (periodic policy checks). */
  startScheduler(checkIntervalMs: number): void;
  /** Stop the scheduler. */
  stopScheduler(): void;
}
