/**
 * I28 — E2 Key Rotation Manager.
 *
 * Production-grade automated key rotation with policy enforcement,
 * re-encryption orchestration, audit trail, and emergency rotation.
 *
 * Architecture:
 *   [Rotation Scheduler] ──periodic check──→ [Policy Engine]
 *                                               │
 *                          ┌────────────────────┘
 *                          ▼
 *   [Rotation Executor] ──▒─→ rotateKey() ──→ [ReEncryption Engine]
 *                          │                        │
 *                          │   [Audit Log]           ├─ batch fetch
 *                          │                        ├─ decrypt(old)
 *                          │                        ├─ encrypt(new)
 *                          └────────────────────────┤─ commit
 *                                                     ├─ verify
 *                                                     └─ retire old key
 */

import {
  type IKeyRotationManager,
  type KeyRotationPolicy,
  type KeyRotationState,
  type RotationEvent,
  type RotationPriority,
  type RotationStats,
  type ReEncryptSource,
  type ReEncryptionOutcome,
  type ReEncryptionResult,
} from '../interfaces/IKeyRotationManager.js';
import type { IEncryptionManager } from '../interfaces/index.js';
import { KeyManager } from './KeyManager.js';

// ── Constants ──────────────────────────────────────────────

const RE_ENCRYPT_BATCH_SIZE = 256;
const DEFAULT_SCHEDULER_INTERVAL_MS = 300_000; // 5 minutes

/**
 * Order the scheduler works through due policies in.
 *
 * `RotationPriority` documents itself as "determines order when multiple
 * rotations are pending", and nothing read it: `checkPolicies` returned
 * registration order, so a `critical` policy queued behind three `low` ones waited
 * for all three. A record, not a `switch`, so adding a priority is a type error
 * here rather than a silent fall through to `undefined`.
 */
const PRIORITY_RANK: Record<RotationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export interface KeyRotationOptions {
  /**
   * Where re-encryption reads its blobs from.
   *
   * Without it a policy that asks for re-encryption still rotates the key, and the
   * event records `reEncryption: 'deferred'` — the alternative was what the class
   * used to do: accept `reEncrypt: true`, rotate nothing else, and report success
   * with `reEncryptedCount: 0`.
   */
  reEncryptSource?: ReEncryptSource;
}

// ── KeyRotationManager ─────────────────────────────────────

export class KeyRotationManager implements IKeyRotationManager {
  private policies = new Map<string, KeyRotationPolicy>();
  private states = new Map<string, KeyRotationState>();
  private history: RotationEvent[] = [];
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private encryption: IEncryptionManager,
    private keyManager?: KeyManager,
    private options: KeyRotationOptions = {},
  ) {}

  // ── Policy Management ────────────────────────────────────

  registerPolicy(policy: KeyRotationPolicy): void {
    const existing = this.states.get(policy.id);
    this.policies.set(policy.id, policy);

    if (existing) {
      // Re-registering an id replaces the policy, so the due time is recomputed:
      // it was derived from a trigger that no longer exists, and a re-registration
      // that changed a `time` trigger's age would otherwise keep the old deadline
      // for the lifetime of the process. Counters and history are kept — they
      // describe the key, not the policy.
      existing.nextRotationDue = this._computeNextDue(policy);
      return;
    }

    this.states.set(policy.id, {
      policyId: policy.id,
      currentVersion: this.keyManager?.version ?? 1,
      lastRotatedAt: null,
      encryptionsSinceRotation: 0,
      bytesSinceRotation: 0,
      rotationInProgress: false,
      pendingReEncryptions: 0,
      nextRotationDue: this._computeNextDue(policy),
    });
  }

  getPolicies(): KeyRotationPolicy[] {
    return Array.from(this.policies.values());
  }

  // ── Policy Checks ────────────────────────────────────────

  async checkPolicies(): Promise<KeyRotationPolicy[]> {
    const now = Date.now();
    const due: KeyRotationPolicy[] = [];

    for (const policy of this.policies.values()) {
      if (!policy.enabled) continue;

      const state = this.states.get(policy.id);
      if (!state || state.rotationInProgress) continue;

      if (this._isDue(policy, state, now)) {
        due.push(policy);
      }
    }

    // Stable sort, so policies of equal priority keep registration order and a
    // scheduler tick is reproducible.
    return due.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  }

  // ── Rotation Execution ───────────────────────────────────

  async rotate(policyId: string): Promise<RotationEvent> {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error(`KeyRotation: unknown policy "${policyId}"`);

    // `registerPolicy` is the only writer of `policies`, and it writes the state in
    // the same call, so a policy that was found has state. The guard that used to
    // sit here could not fire: nothing removes a state, and `emergencyRotate`
    // registers before it rotates.
    const state = this.states.get(policyId)!;

    if (state.rotationInProgress) {
      throw new Error(`KeyRotation: rotation already in progress for "${policyId}"`);
    }

    state.rotationInProgress = true;

    const event: RotationEvent = {
      id: this._generateEventId(),
      policyId,
      fromVersion: state.currentVersion,
      // A rotation starts by creating no version. It used to start by claiming
      // `currentVersion + 1`, which a *failed* rotation then left in the audit
      // trail — a version number that was never created, reported as fact.
      toVersion: state.currentVersion,
      trigger: policy.trigger,
      startedAt: Date.now(),
      completedAt: null,
      success: false,
      error: null,
      reEncryptedCount: 0,
      reEncryption: 'not-requested',
      retiredVersion: null,
    };

    try {
      // Execute key rotation
      await this.encryption.rotateKey();

      // Update state
      const newVersion = state.currentVersion + 1;
      state.currentVersion = newVersion;
      state.lastRotatedAt = Date.now();
      state.encryptionsSinceRotation = 0;
      state.bytesSinceRotation = 0;
      state.nextRotationDue = this._computeNextDue(policy);

      event.toVersion = newVersion;
      event.completedAt = Date.now();
      event.success = true;

      // Retire oldest key if maxKeyVersions exceeded
      if (policy.maxKeyVersions > 0) {
        // The key that falls out of the window is the one `maxKeyVersions` behind
        // the new one. No separate `> 0` check: a version number that does not
        // exist is exactly what `hasKeyVersion` answers, and version 0 never exists
        // (the manager starts at 1). Two guards for one question is how the wrong
        // one ends up being the one that matters.
        const retireVersion = newVersion - policy.maxKeyVersions;
        if (this.keyManager?.hasKeyVersion(retireVersion)) {
          // We don't actually delete the key (decryption still needed),
          // but mark it as retired for audit purposes
          event.retiredVersion = retireVersion;
        }
      }

      // Last, and outside the failure path above: a re-encryption that cannot run
      // does not un-rotate the key.
      event.reEncryption = await this._reEncryptAfterRotation(policy, newVersion, event);
    } catch (error) {
      event.error = String(error);
      event.completedAt = Date.now();
      // `success` is not left as it was: it is set before the post-rotation steps,
      // so a failure there — a key manager that could not be consulted, a
      // re-encryption source that threw — used to be recorded as a success with an
      // error string attached. An event that carries an error did not succeed.
      event.success = false;
    } finally {
      state.rotationInProgress = false;
    }

    this.history.push(event);
    return event;
  }

  async emergencyRotate(policyId: string, reason: string): Promise<RotationEvent> {
    const policy = this.policies.get(policyId);
    if (!policy) {
      // Auto-create an emergency policy
      this.registerPolicy({
        id: policyId,
        name: `Emergency rotation: ${reason}`,
        trigger: { kind: 'compromise', reason },
        reEncrypt: true,
        reEncryptBatchSize: RE_ENCRYPT_BATCH_SIZE,
        maxKeyVersions: 5,
        priority: 'critical',
        enabled: true,
      });
    }

    // `rotate` does not consult `nextRotationDue` for a compromise policy — such a
    // policy is due until it has been rotated (see `_isDue`) — so there is no
    // deadline to force here. Setting one used to be a second, unread source of
    // truth for "is this immediate", overwritten by the rotation itself.
    const event = await this.rotate(policyId);
    // `rotate` pushed this very object onto the history and returned it, so the
    // trigger is changed here rather than copied in. The block that used to look
    // the event up by id and write it back wrote the object to the slot it already
    // occupied: seven mutants of it survived because the rewrite did nothing.
    event.trigger = { kind: 'compromise', reason };

    return event;
  }

  // ── Re-encryption ────────────────────────────────────────

  async reEncrypt(policyId: string, blobIterator: AsyncIterable<Buffer | null>): Promise<ReEncryptionResult> {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error(`KeyRotation: unknown policy "${policyId}"`);

    const result: ReEncryptionResult = {
      totalBlobs: 0,
      reEncrypted: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    };

    const t0 = Date.now();
    const batch = policy.reEncryptBatchSize;
    let stoppedAtBound = false;

    try {
      for await (const blob of blobIterator) {
        if (batch > 0 && result.totalBlobs >= batch) {
          // The bound is on the pass, not on the work: the blob just pulled is
          // still in the source, so the pass stops *before* counting it.
          stoppedAtBound = true;
          break;
        }
        result.totalBlobs++;

        if (blob === null) {
          // The source is the only component that knows which key version a blob
          // was written with, so "already under the new key" is its answer to
          // give. It used to be inferred from a decryption failure, which counted
          // an unreadable blob as a job well skipped.
          result.skipped++;
          continue;
        }

        let plaintext: Buffer | null = null;
        try {
          plaintext = await this.encryption.decrypt(blob);
          const ciphertext = await this.encryption.encrypt(plaintext);
          const verified = await this.encryption.decrypt(ciphertext);
          try {
            if (verified.equals(plaintext)) result.reEncrypted++;
            else result.failed++;
          } finally {
            verified.fill(0);
          }
        } catch {
          result.failed++;
        } finally {
          // Both exits, not only the good one. A verification mismatch or a
          // cipher error used to return the plaintext to the caller's heap
          // un-wiped, which is the state an attacker wants it in.
          plaintext?.fill(0);
        }
      }
    } catch (error) {
      // The source itself failed. The pass did not finish, so the debt stays
      // visible instead of being reported as a completed migration.
      this.states.get(policyId)!.pendingReEncryptions = 1;
      throw error;
    }

    result.durationMs = Date.now() - t0;
    this.states.get(policyId)!.pendingReEncryptions = stoppedAtBound ? 1 : 0;
    return result;
  }

  // ── State & History ──────────────────────────────────────

  async getState(policyId: string): Promise<KeyRotationState | null> {
    return this.states.get(policyId) ?? null;
  }

  async getHistory(policyId?: string): Promise<RotationEvent[]> {
    if (!policyId) return [...this.history];
    return this.history.filter((e) => e.policyId === policyId);
  }

  async getStats(): Promise<RotationStats> {
    const events = this.history;
    const successful = events.filter((e) => e.success);
    const failed = events.filter((e) => !e.success);

    const totalDuration = successful.reduce((sum, e) => sum + ((e.completedAt ?? e.startedAt) - e.startedAt), 0);

    return {
      totalRotations: events.length,
      successfulRotations: successful.length,
      failedRotations: failed.length,
      lastRotationAt: events.length > 0 ? events[events.length - 1]!.startedAt : null,
      averageDurationMs: successful.length > 0 ? totalDuration / successful.length : 0,
      totalReEncrypted: events.reduce((sum, e) => sum + e.reEncryptedCount, 0),
      activeKeyVersions: this.keyManager?.versionCount ?? 0,
    };
  }

  // ── Scheduler ────────────────────────────────────────────

  startScheduler(checkIntervalMs: number = DEFAULT_SCHEDULER_INTERVAL_MS): void {
    if (this.schedulerTimer) return;

    const timer = setInterval(() => {
      void this._schedulerTick();
    }, checkIntervalMs);
    // Without this the process cannot exit while the scheduler runs: `setInterval`
    // holds the event loop open, so a service that forgot `stopScheduler` hangs on
    // shutdown, and a test process never finishes. `stopScheduler` still clears it.
    timer.unref();
    this.schedulerTimer = timer;
  }

  stopScheduler(): void {
    // No `if`: clearing a timer that is not running is a defined no-op, and a guard
    // around a no-op is a statement no test can tell from its absence.
    clearInterval(this.schedulerTimer ?? undefined);
    this.schedulerTimer = null;
  }

  // ── Recording ────────────────────────────────────────────

  /**
   * Record that an encryption operation occurred (for count/volume triggers).
   *
   * An unknown policy is a no-op rather than an error: callers encrypt during
   * startup and during shutdown, in both cases before or after policies exist, and
   * a counter that throws would turn an operational ordering detail into an outage.
   */
  recordEncryption(policyId: string, bytes: number): void {
    const state = this.states.get(policyId);
    if (state) {
      state.encryptionsSinceRotation++;
      state.bytesSinceRotation += bytes;
    }
  }

  // ── Internal: Re-encryption after a rotation ─────────────

  /**
   * Ask the caller's source to re-encrypt, and record what happened.
   *
   * Never throws: the key has already rotated by the time this runs, so a failure
   * here is not a failed rotation — it is data still on the old key, which the
   * event says in as many words.
   */
  private async _reEncryptAfterRotation(
    policy: KeyRotationPolicy,
    newVersion: number,
    event: RotationEvent,
  ): Promise<ReEncryptionOutcome> {
    if (!policy.reEncrypt) return 'not-requested';

    const source = this.options.reEncryptSource;
    if (!source) return 'deferred';

    // One failure path, not two. Asking the source and walking what it returns are
    // the same question — "can this be migrated now?" — and splitting them meant a
    // swallow on the first that produced `failed` later by accident, on a path no
    // test could reach deliberately.
    try {
      const blobs = await source(policy.id, newVersion);
      if (blobs === null) return 'deferred';

      const result = await this.reEncrypt(policy.id, blobs);
      event.reEncryptedCount = result.reEncrypted;
      return 'completed';
    } catch {
      return 'failed';
    }
  }

  // ── Internal: Due Check ──────────────────────────────────

  private _isDue(policy: KeyRotationPolicy, state: KeyRotationState, now: number): boolean {
    switch (policy.trigger.kind) {
      case 'time': {
        const lastRotated = state.lastRotatedAt ?? 0;
        return now - lastRotated >= policy.trigger.maxAgeMs;
      }
      case 'count':
        return state.encryptionsSinceRotation >= policy.trigger.maxEncryptions;
      case 'volume':
        return state.bytesSinceRotation >= policy.trigger.maxBytes;
      case 'schedule':
        // Simple: check if nextRotationDue has passed
        return state.nextRotationDue !== null && now >= state.nextRotationDue;
      case 'compromise':
        // Due until it has been rotated. "Always due" made the scheduler rotate
        // the key on every tick, for as long as the process lived: an emergency
        // rotation left behind a policy that rotated the cluster's key every five
        // minutes and filled the history with events nobody asked for. The
        // compromise is addressed by rotating once; `emergencyRotate` still rotates
        // on demand because it calls `rotate` directly.
        return state.lastRotatedAt === null;
      default:
        // `manual` and anything a caller invents land here: not automatically due,
        // because an explicit `rotate()` is the only thing that should spend a key.
        return false;
    }
  }

  // ── Internal ─────────────────────────────────────────────

  private async _schedulerTick(): Promise<void> {
    const due = await this.checkPolicies();
    for (const policy of due) {
      try {
        await this.rotate(policy.id);
      } catch {
        // Log and continue — other policies should still rotate
      }
    }
  }

  private _computeNextDue(policy: KeyRotationPolicy): number | null {
    if (policy.trigger.kind === 'time') {
      return Date.now() + policy.trigger.maxAgeMs;
    }
    if (policy.trigger.kind === 'schedule') {
      // Approximate next cron; for simplicity, return 1 hour from now
      return Date.now() + 3_600_000;
    }
    return null;
  }

  private _generateEventId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `rot-${ts}-${rand}`;
  }
}
