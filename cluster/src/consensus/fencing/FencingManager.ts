/**
 * FencingManager — Raft leader STONITH / write-fencing protection
 *
 * Prevents split-brain writes by fencing a partitioned Raft leader.
 * Works on a lease-based model:
 *   - The Raft leader sends periodic heartbeats via receiveHeartbeat()
 *   - If no heartbeat arrives within leaderLeaseMs, the node is "fenced"
 *   - A fenced node rejects write operations with SQLSTATE 55P03
 *   - A new heartbeat (from a different term) recovers the node
 *
 * This is NOT a STONITH (Shoot The Other Node In The Head) implementation
 * in the traditional sense — we don't physically kill the other node.
 * Instead, we fence OURSELVES (this node) to prevent serving writes when
 * we suspect we've been partitioned away from the Raft majority.
 *
 * Integration points:
 *   - RaftGroup's leader monitor calls receiveHeartbeat() for each shard
 *   - QueryRouter checks checkWriteAllowed() before any write operation
 *   - GracefulShutdown calls stop() to cleanly terminate the fencing timer
 */

import pino from 'pino';
import { getErrorMessage } from '../helpers/errorUtils';
import { resolveLogLevel } from '../../observability/logLevel';
import {
  FencingTokenGuard,
  formatFencingToken,
  mintFencingToken,
  type FencingToken,
  type WriteAdmission,
} from './FencingToken';
const logger = pino({ level: resolveLogLevel() });

// ── Types ────────────────────────────────────────────────────────

export interface FencingConfig {
  enabled: boolean;
  /** Max time without leader heartbeat before fencing triggers (ms, default 5000) */
  leaderLeaseMs: number;
  /** Check interval (ms, default 1000) */
  checkIntervalMs: number;
  /** Action on fencing breach */
  action: 'block_writes' | 'block_all' | 'panic';
  /**
   * Require every write to carry a fencing token (default false).
   *
   * The lease alone cannot stop a leader that still hears one peer; a token can,
   * because the resource compares it against durable state. Turning this on makes
   * `checkWriteAllowed()` refuse untokened writes — fail-closed — which is only
   * correct once the engine's write path actually carries a token.
   */
  requireToken?: boolean;
}

export type FenceState = 'fenced' | 'unfenced' | 'unknown';

export interface FencingShardStatus {
  shardId: number;
  state: FenceState;
  lastHeartbeatMs: number;
  currentTerm: number;
  leaderId: string | null;
  timeSinceHeartbeatMs: number;
}

export interface FencingStatus {
  enabled: boolean;
  config: FencingConfig;
  globalState: FenceState;
  shards: FencingShardStatus[];
  fenceCount: number;
  startedAt: number;
  /** Writes refused because their fencing token was missing or already beaten. */
  tokenRefusals: number;
  /** The highest token this node has accepted or observed, if any. */
  highestToken: FencingToken | null;
}

interface ShardFence {
  shardId: number;
  state: FenceState;
  lastHeartbeatTs: number;
  currentTerm: number;
  leaderId: string | null;
}

// ── Defaults ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: FencingConfig = {
  enabled: true,
  leaderLeaseMs: 5000,
  checkIntervalMs: 1000,
  action: 'block_writes',
};

// ── FencingManager ───────────────────────────────────────────────

export class FencingManager {
  private config: FencingConfig;
  private shards: Map<number, ShardFence> = new Map();
  private fenceCallbacks: Array<(reason: string) => void> = [];
  /** M-30: Panic callback for graceful shutdown instead of process.exit() */
  private panicCallbacks: Array<(reason: string) => void> = [];
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private _fenceCount: number = 0;
  private _startedAt: number = 0;
  /**
   * The resource-layer memory of how far the right to write has advanced.
   *
   * The lease below says whether *this* node should stop; the guard says whether
   * the *resource* may still accept it. Both must agree, and the guard is the one
   * the old primary cannot talk out of its answer.
   */
  private readonly _tokens: FencingTokenGuard;

  constructor(config?: Partial<FencingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._tokens = new FencingTokenGuard({ requireToken: this.config.requireToken ?? false });
  }

  // ── Core lifecycle ─────────────────────────────────────────────

  /**
   * Start the fencing timer. Periodically checks all shard leases.
   * Does nothing if fencing is disabled.
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('[FencingManager] Fencing is disabled — not starting timer');
      return;
    }

    if (this.checkTimer) {
      logger.warn('[FencingManager] Already started — ignoring duplicate start');
      return;
    }

    this._startedAt = Date.now();

    this.checkTimer = setInterval(() => {
      this.checkAllLeases();
    }, this.config.checkIntervalMs);

    // Don't prevent process exit
    if (typeof this.checkTimer === 'object' && 'unref' in this.checkTimer) {
      this.checkTimer.unref();
    }

    logger.info(
      {
        leaderLeaseMs: this.config.leaderLeaseMs,
        checkIntervalMs: this.config.checkIntervalMs,
        action: this.config.action,
      },
      '[FencingManager] Started fencing timer',
    );
  }

  /**
   * Stop the fencing timer. Safe to call when already stopped.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      logger.info('[FencingManager] Stopped');
    }
  }

  /**
   * Get the current global fencing state.
   * Returns 'fenced' if ANY shard is fenced, 'unknown' if no shards tracked, else 'unfenced'.
   */
  getState(): FenceState {
    if (this.shards.size === 0) return 'unknown';
    for (const shard of this.shards.values()) {
      if (shard.state === 'fenced') return 'fenced';
    }
    return 'unfenced';
  }

  /**
   * Get state for a specific shard.
   * Returns 'unknown' if the shard is not tracked.
   */
  getShardState(shardId: number): FenceState {
    return this.shards.get(shardId)?.state ?? 'unknown';
  }

  // ── Health heartbeat from Raft leader ─────────────────────────

  /**
   * Receive a heartbeat from a Raft leader for a given shard.
   * Resets the lease timer for that shard.
   *
   * A heartbeat with a NEW term (higher than previously recorded)
   * RECOVERS a fenced shard — the new term indicates a new leader
   * has been elected, meaning the old leader's partition is resolved.
   *
   * @param shardId - The shard ID
   * @param term - The current Raft term
   * @param leaderId - The leader's node ID
   */
  receiveHeartbeat(shardId: number, term: number, leaderId: string): void {
    const now = Date.now();
    const existing = this.shards.get(shardId);

    if (existing) {
      // Check if this is a term advancement — if so, recover from fenced state
      if (term > existing.currentTerm) {
        const wasFenced = existing.state === 'fenced';
        existing.state = 'unfenced';
        existing.currentTerm = term;
        existing.leaderId = leaderId;
        existing.lastHeartbeatTs = now;

        // A heartbeat from a higher term is the resource's own evidence that the
        // right to write has moved on. Recording it here is what makes a token
        // from the previous term stale even before the new leader writes anything.
        this._observeTerm(term);

        if (wasFenced) {
          logger.info({ shardId, term, leaderId }, '[FencingManager] Shard recovered — new term from leader heartbeat');
        }
        return;
      }

      // Same term: refresh the heartbeat timestamp
      // Don't recover from fenced on same-term heartbeat — the old leader shouldn't be trusted
      if (existing.state === 'unfenced' || existing.state === 'unknown') {
        existing.lastHeartbeatTs = now;
        existing.currentTerm = term;
        existing.leaderId = leaderId;
      } else {
        // fenced with same term — this is an old leader trying to serve
        // Ignore it. The shard stays fenced.
        logger.warn({ shardId, term, leaderId }, '[FencingManager] Ignored heartbeat from fenced shard (same term)');
      }
    } else {
      // New shard: start tracking
      this.shards.set(shardId, {
        shardId,
        state: 'unfenced',
        lastHeartbeatTs: now,
        currentTerm: term,
        leaderId,
      });
      this._observeTerm(term);
    }
  }

  // ── Write access control ───────────────────────────────────────

  /**
   * Check if a write operation is allowed for the given shard.
   *
   * Two independent questions, both of which must answer yes:
   *
   *   1. the lease — has this node heard from a leader recently? (a belief)
   *   2. the token — has the resource already accepted a later position? (a fact)
   *
   * The lease is asked first so that a fenced node reports the lease as the
   * reason; its token, if it has one, is not allowed to become evidence.
   *
   * @param shardId - The shard to check (default: 0 for single-shard ops)
   * @param token - The fencing token the writer carries, if its engine has one
   * @returns Object with `allowed` boolean and optional `reason` if blocked
   */
  checkWriteAllowed(shardId: string | number, token?: FencingToken | null): { allowed: boolean; reason?: string } {
    const sid = typeof shardId === 'string' ? parseInt(shardId, 10) : shardId;

    if (this.config.enabled) {
      const shard = this.shards.get(sid);

      if (shard && shard.state === 'fenced') {
        return {
          allowed: false,
          reason: `Node is fenced for shard ${sid}: no leader heartbeat for ${Date.now() - shard.lastHeartbeatTs}ms`,
        };
      }

      // 'block_all' forbids every write on this node, even when the shard is
      // still unfenced (e.g., during a decommissioning/shutdown transition).
      // It is intentionally stricter than the default 'block_writes' action,
      // which only rejects writes on shards that have actually been fenced.
      if (shard && this.config.action === 'block_all') {
        return {
          allowed: false,
          reason: `Writes are blocked by 'block_all' fencing action for shard ${sid}`,
        };
      }
    }

    const admission = this._tokens.admit(token, `shard ${sid}`);
    if (!admission.admitted) {
      const label = admission.reason === 'missing-token' ? 'missing token' : 'stale token';
      return { allowed: false, reason: `${label}: ${admission.detail}` };
    }

    return { allowed: true };
  }

  /**
   * Decide a fencing token on its own, for engines that keep their own lease
   * bookkeeping and only want the resource-layer verdict.
   *
   * @param token - The token the writer carries
   */
  admitToken(token: FencingToken): WriteAdmission {
    return this._tokens.admit(token);
  }

  /** The highest token this node has accepted or observed. */
  getHighestToken(): FencingToken | null {
    return this._tokens.getHighest();
  }

  /**
   * Render the highest token for logs and status endpoints.
   *
   * A string is what an operator compares across nodes; the object is what the
   * code compares.
   */
  getFormattedHighestToken(): string | null {
    const highest = this._tokens.getHighest();
    return highest ? formatFencingToken(highest) : null;
  }

  private _observeTerm(term: number): void {
    // A term that is not a non-negative safe integer cannot be ordered, and the
    // heartbeat path must not throw over it: skip the observation, keep the lease.
    if (!Number.isSafeInteger(term) || term < 0) {
      logger.warn({ term }, '[FencingManager] Ignoring a fencing term that is not a non-negative integer');
      return;
    }
    this._tokens.observe(mintFencingToken(term, 0));
  }

  // ── Event subscriptions ────────────────────────────────────────

  /**
   * Register a callback that fires when a shard becomes fenced.
   * @param callback - Receives a human-readable reason string
   */
  onFenceTriggered(callback: (reason: string) => void): void {
    this.fenceCallbacks.push(callback);
  }

  /**
   * M-30: Register a callback that fires when a panic action is triggered.
   * Replaces process.exit(1) with a controlled shutdown sequence.
   * @param callback - Receives a human-readable reason string
   */
  onPanic(callback: (reason: string) => void): void {
    this.panicCallbacks.push(callback);
  }

  // ── Status ─────────────────────────────────────────────────────

  /**
   * Get the full fencing status across all shards.
   */
  getStatus(): FencingStatus {
    const now = Date.now();
    const shardStatuses: FencingShardStatus[] = [];

    for (const [, shard] of this.shards) {
      shardStatuses.push({
        shardId: shard.shardId,
        state: shard.state,
        lastHeartbeatMs: shard.lastHeartbeatTs,
        currentTerm: shard.currentTerm,
        leaderId: shard.leaderId,
        timeSinceHeartbeatMs: now - shard.lastHeartbeatTs,
      });
    }

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      globalState: this.getState(),
      shards: shardStatuses,
      fenceCount: this._fenceCount,
      startedAt: this._startedAt,
      tokenRefusals: this._tokens.getRefusalCount(),
      highestToken: this._tokens.getHighest(),
    };
  }

  /**
   * Remove a shard from tracking (e.g., when a shard is decommissioned).
   */
  removeShard(shardId: number): void {
    this.shards.delete(shardId);
  }

  /**
   * Explicitly fence all shards associated with a given node.
   * Forces the fencing state to 'fenced' for any shard whose leaderId matches.
   * Used by HAFailoverCoordinator after confirming a node has failed,
   * to ensure the failed node can't accept writes before a new leader is elected.
   */
  fenceNode(nodeId: string): void {
    let fenced = 0;
    for (const [, shard] of this.shards) {
      if (shard.leaderId === nodeId && shard.state !== 'fenced') {
        shard.state = 'fenced';
        this._fenceCount++;
        fenced++;
      }
    }
    if (fenced > 0) {
      logger.warn(
        { nodeId, fencedShards: fenced },
        `[FencingManager] Forced fence for ${fenced} shard(s) belonging to node ${nodeId}`,
      );
    }
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Check all shard leases. For any shard whose lease has expired,
   * transit to 'fenced' state and fire callbacks.
   */
  private checkAllLeases(): void {
    const now = Date.now();

    for (const [, shard] of this.shards) {
      if (shard.state === 'fenced') continue; // Already fenced

      const elapsed = now - shard.lastHeartbeatTs;

      if (elapsed > this.config.leaderLeaseMs) {
        const wasUnfenced = shard.state === 'unfenced';
        shard.state = 'fenced';
        this._fenceCount++;

        if (wasUnfenced) {
          const reason = `Shard ${shard.shardId}: missed leader heartbeat for ${elapsed}ms (lease: ${this.config.leaderLeaseMs}ms)`;
          logger.error(
            {
              shardId: shard.shardId,
              elapsedMs: elapsed,
              leaseMs: this.config.leaderLeaseMs,
              action: this.config.action,
              term: shard.currentTerm,
              leaderId: shard.leaderId,
            },
            `[FencingManager] FENCE TRIGGERED: ${reason}`,
          );

          // Fire callbacks
          for (const cb of this.fenceCallbacks) {
            try {
              cb(reason);
            } catch (err: unknown) {
              logger.error({ err: getErrorMessage(err) }, '[FencingManager] Fence callback error');
            }
          }

          // If action is 'panic', trigger shutdown sequence instead of process.exit()
          if (this.config.action === 'panic') {
            logger.fatal(
              { shardId: shard.shardId, reason },
              '[FencingManager] Panic action triggered — invoking panic callbacks for shutdown',
            );
            // M-30: Invoke panic callbacks for controlled shutdown instead of process.exit(1)
            for (const cb of this.panicCallbacks) {
              try {
                cb(reason);
              } catch (err: unknown) {
                logger.error({ err: getErrorMessage(err) }, '[FencingManager] Panic callback error');
              }
            }
            // If no panic callbacks registered, emit a fatal error to trigger default handling
            if (this.panicCallbacks.length === 0) {
              logger.error(
                { shardId: shard.shardId, reason },
                '[FencingManager] No panic callbacks registered — fence state set to fenced. ' +
                  'Call onPanic() to register a controlled shutdown handler.',
              );
            }
          }
        }
      }
    }
  }
}
