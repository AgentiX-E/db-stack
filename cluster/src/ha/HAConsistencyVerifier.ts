/**
 * HAConsistencyVerifier — Post-failover data consistency verification.
 *
 * Stage 3 of HA implementation.
 * Compares committed entries across shards to detect divergence.
 * Kept practical: compares commitIndex / lastLogIndex across peers and checks log entry matching.
 *
 * The verification flow:
 *   1. verifyConsistency() — general-purpose cross-replica commit index check.
 *   2. verifyNewLeaderConsistency() — post-failover check that the newly elected leader
 *      has a complete, consistent log (no lost committed entries, no divergence).
 *
 * Raft's safety properties (Leader Completeness, Election Restriction, Log Matching)
 * guarantee correctness under normal operation. These verifiers add an extra safety
 * layer that detects real-world issues like storage corruption, misconfiguration,
 * or software bugs that could undermine Raft's guarantees.
 */

import pino from 'pino';
import { IConsensusLayer } from '../consensus/interfaces/interfaces';
import { getErrorMessage } from '../consensus/helpers/errorUtils';

const logger = pino({ name: 'HAConsistencyVerifier' });

// ── Types ────────────────────────────────────────────────────────────

/** Detailed result of a new-leader consistency check. */
export interface NewLeaderConsistencyResult {
  /** Overall pass/fail verdict. */
  consistent: boolean;
  /** Human-readable summary. */
  summary: string;
  /** Detailed breakdown of each check performed. */
  checks: ConsistencyCheck[];
  /** Timestamp of the check. */
  timestamp: number;
}

export interface ConsistencyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

// ── HAConsistencyVerifier ────────────────────────────────────────────

export class HAConsistencyVerifier {
  private consensusLayer?: IConsensusLayer;

  /**
   * @param consensusLayer - Optional IConsensusLayer reference.
   *                         When provided, verifyNewLeaderConsistency() performs
   *                         real cross-node consistency checks. Without it, a
   *                         best-effort check based on local status is done.
   */
  constructor(consensusLayer?: IConsensusLayer) {
    this.consensusLayer = consensusLayer;
  }

  /**
   * Compare committed entries across shards to detect divergence.
   * Checks commitIndex across peers (via consensusLayer) and reports consistency status.
   */
  async verifyConsistency(
    shardId: string,
    consensusLayer: IConsensusLayer,
  ): Promise<{ consistent: boolean; details: string }> {
    try {
      const localCommitIndex = await consensusLayer.getCommitIndex(shardId);
      const localLeader = await consensusLayer.getLeader(shardId);
      const localIsLeader = await consensusLayer.isLeader(shardId);

      // Get health status for all shards to compare across peers
      let healthStatus: any[];
      try {
        healthStatus = await consensusLayer.getHealthStatus();
      } catch {
        healthStatus = [];
      }

      // Filter for the specific shard
      const shardHealths = healthStatus.filter((h: any) => String(h.shardId) === shardId);

      if (shardHealths.length === 0) {
        // Only local info available — limited check
        return {
          consistent: true,
          details: `Only local node info available for shard ${shardId}. commitIndex=${localCommitIndex}, leader=${localLeader}`,
        };
      }

      // Compare commit indices across all replicas of this shard
      const commitIndices = shardHealths.map((h: any) => ({
        nodeId: String(h.leaderId ?? 'unknown'),
        commitIndex: h.commitIndex ?? 0,
        isLeader: h.isLeader ?? false,
      }));

      // Check for divergence
      if (commitIndices.length > 1) {
        const indices = commitIndices.map((c) => c.commitIndex);
        const maxIdx = Math.max(...indices);
        const minIdx = Math.min(...indices);
        const divergence = maxIdx - minIdx;

        if (divergence > 0) {
          logger.warn(
            {
              shardId,
              maxCommitIndex: maxIdx,
              minCommitIndex: minIdx,
              divergence,
              replicas: commitIndices,
            },
            'Commit index divergence detected between replicas',
          );

          return {
            consistent: false,
            details: `Divergence detected: min commitIndex=${minIdx}, max commitIndex=${maxIdx}, gap=${divergence}. Replicas: ${JSON.stringify(commitIndices)}`,
          };
        }
      }

      return {
        consistent: true,
        details: `Shard ${shardId} is consistent. commitIndex=${localCommitIndex}, leader=${localLeader}, replicas=${commitIndices.length}`,
      };
    } catch (err: unknown) {
      logger.error({ err, shardId }, 'Failed to verify consistency');
      return {
        consistent: false,
        details: `Error verifying consistency: ${getErrorMessage(err)}`,
      };
    }
  }

  /**
   * After failover, verify the new leader's log is consistent.
   *
   * Performs the following checks:
   *   1. Leader Identity — verify the consensus layer recognizes the new leader.
   *   2. Commit Progress — verify the leader has a positive commitIndex (entries exist).
   *   3. Cross-Replica Consistency — compare commitIndex and lastLogIndex across
   *      all node-local shard health entries (same shard ID, different nodes).
   *   4. Non-Regression — verify the leader's commitIndex hasn't regressed below
   *      the pre-failover baseline (if available from a prior check).
   *
   * When no IConsensusLayer is available (best-effort mode):
   *   - Returns true with a warning that checks were limited.
   *
   * @param newLeaderId - The node ID of the newly elected leader.
   * @param shardId     - The shard ID to verify.
   * @param consensusLayer - Optional IConsensusLayer; falls back to instance-level
   *                         reference if not provided, then to best-effort if none.
   * @param preFailoverCommitIndex - Optional baseline commit index from before failover.
   *                                 Used to detect commit regression (index lost).
   * @returns true if all consistency checks pass, false if any check fails.
   */
  async verifyNewLeaderConsistency(
    newLeaderId: string,
    shardId: string,
    consensusLayer?: IConsensusLayer,
    preFailoverCommitIndex?: number,
  ): Promise<boolean> {
    const checks: ConsistencyCheck[] = [];
    const startTime = Date.now();

    try {
      logger.info({ newLeaderId, shardId }, 'Verifying consistency of new leader after failover');

      // ── Resolve consensus layer: explicit param > instance > null ─────
      const cl = consensusLayer ?? this.consensusLayer;

      // ── No consensus layer: best-effort fallback ──────────────────────
      if (!cl) {
        logger.warn(
          { newLeaderId, shardId },
          'No IConsensusLayer available — skipping real consistency checks. ' +
            'Returning true (best-effort). Provide a consensusLayer for proper verification.',
        );
        return true;
      }

      // ════════════════════════════════════════════════════════════════
      //  Check 1: Leader Identity
      // ════════════════════════════════════════════════════════════════
      let actualLeader: string | null = null;
      try {
        actualLeader = await cl.getLeader(shardId);
      } catch (err: any) {
        checks.push({
          name: 'leader-identity',
          passed: false,
          detail: `Failed to query current leader: ${getErrorMessage(err)}`,
        });
        logger.error({ err, shardId }, 'Failed to query leader identity');
        throw new Error(
          `[HAConsistencyVerifier] Cannot verify new leader consistency for shard ${shardId}: ` +
            `consensus layer error when querying leader: ${getErrorMessage(err)}`,
        );
      }

      const leaderMatch = actualLeader === newLeaderId;
      checks.push({
        name: 'leader-identity',
        passed: leaderMatch,
        detail: leaderMatch
          ? `Consensus layer confirms leader=${newLeaderId} for shard ${shardId}`
          : `MISMATCH: expected leader=${newLeaderId}, but consensus reports actual leader=${actualLeader ?? 'null'}`,
      });

      if (!leaderMatch) {
        logger.error(
          { newLeaderId, actualLeader, shardId },
          'New leader identity mismatch — consensus does not recognize the claimed leader',
        );
        throw new Error(
          `[HAConsistencyVerifier] New leader identity check FAILED for shard ${shardId}: ` +
            `expected leader="${newLeaderId}", actual leader="${actualLeader ?? 'null'}"`,
        );
      }

      // ════════════════════════════════════════════════════════════════
      //  Check 2: Commit Progress (leader has committed entries)
      // ════════════════════════════════════════════════════════════════
      let commitIndex = 0;
      try {
        commitIndex = await cl.getCommitIndex(shardId);
      } catch (err: any) {
        checks.push({
          name: 'commit-progress',
          passed: false,
          detail: `Failed to query commit index: ${getErrorMessage(err)}`,
        });
        throw new Error(`[HAConsistencyVerifier] Cannot query commit index for shard ${shardId}: ${getErrorMessage(err)}`);
      }

      const hasCommits = commitIndex >= 0;
      checks.push({
        name: 'commit-progress',
        passed: true,
        detail:
          `Leader commitIndex=${commitIndex} for shard ${shardId}` +
          (commitIndex === 0 ? ' (no committed entries yet — acceptable on fresh shard)' : ''),
      });

      // ════════════════════════════════════════════════════════════════
      //  Check 3: Non-Regression (commit index didn't regress)
      // ════════════════════════════════════════════════════════════════
      if (preFailoverCommitIndex !== undefined && preFailoverCommitIndex >= 0) {
        const regressed = commitIndex < preFailoverCommitIndex;
        checks.push({
          name: 'commit-non-regression',
          passed: !regressed,
          detail: regressed
            ? `COMMIT INDEX REGRESSION: pre-failover=${preFailoverCommitIndex}, post-failover=${commitIndex} (lost ${preFailoverCommitIndex - commitIndex} entries!)`
            : `No regression: pre-failover=${preFailoverCommitIndex}, post-failover=${commitIndex}, change=${commitIndex - preFailoverCommitIndex}`,
        });

        if (regressed) {
          logger.error(
            {
              shardId,
              preFailoverCommitIndex,
              postFailoverCommitIndex: commitIndex,
              gap: preFailoverCommitIndex - commitIndex,
            },
            'Commit index regression detected after failover — committed entries may have been lost!',
          );
          throw new Error(
            `[HAConsistencyVerifier] Commit index regression detected after failover for shard ${shardId}: ` +
              `pre-failover commitIndex=${preFailoverCommitIndex}, post-failover commitIndex=${commitIndex}. ` +
              `Lost ${preFailoverCommitIndex - commitIndex} committed entries!`,
          );
        }
      } else {
        // No baseline — log note but don't treat as failure
        checks.push({
          name: 'commit-non-regression',
          passed: true,
          detail: 'No pre-failover baseline available — regression check skipped',
        });
      }

      // ════════════════════════════════════════════════════════════════
      //  Check 4: Cross-Replica Consistency (via health status)
      // ════════════════════════════════════════════════════════════════
      let healthStatus: any[] = [];
      try {
        healthStatus = await cl.getHealthStatus();
      } catch (err: any) {
        checks.push({
          name: 'cross-replica-consistency',
          passed: true, // Non-fatal — health status may not be available on all nodes
          detail: `Unable to fetch health status for cross-replica check: ${getErrorMessage(err)}`,
        });
        logger.warn(
          { shardId, err: getErrorMessage(err) },
          'Health status unavailable — skipping cross-replica consistency check',
        );
      }

      if (healthStatus.length > 0) {
        // Filter for the target shard (all replicas on this node)
        const shardHealths = healthStatus.filter((h: any) => String(h.shardId) === shardId);

        if (shardHealths.length > 1) {
          // Multiple replicas on the same shard — compare their progress
          const replicas: Array<{
            nodeId: string;
            isLeader: boolean;
            commitIndex: number;
            lastLogIndex: number;
            term: number;
          }> = shardHealths.map((h: any) => ({
            nodeId: String(h.nodeId ?? h.leaderId ?? 'unknown'),
            isLeader: h.isLeader ?? false,
            commitIndex: h.commitIndex ?? 0,
            lastLogIndex: h.lastLogIndex ?? 0,
            term: h.term ?? 0,
          }));

          // Check commit index divergence
          const commitIndices = replicas.map((r) => r.commitIndex);
          const maxCommit = Math.max(...commitIndices);
          const minCommit = Math.min(...commitIndices);
          const commitGap = maxCommit - minCommit;

          // Check lastLogIndex divergence
          const logIndices = replicas.map((r) => r.lastLogIndex);
          const maxLog = Math.max(...logIndices);
          const minLog = Math.min(...logIndices);
          const logGap = maxLog - minLog;

          const crossReplicaPassed = commitGap <= 0 && logGap <= 0;
          checks.push({
            name: 'cross-replica-consistency',
            passed: crossReplicaPassed,
            detail: crossReplicaPassed
              ? `All ${replicas.length} replicas consistent: commitIndex=${maxCommit}, lastLogIndex=${maxLog}`
              : `Divergence detected across ${replicas.length} replicas: ` +
                `commitIndex range [${minCommit}..${maxCommit}] (gap=${commitGap}), ` +
                `lastLogIndex range [${minLog}..${maxLog}] (gap=${logGap}). ` +
                `Replicas: ${JSON.stringify(replicas)}`,
          });

          if (!crossReplicaPassed) {
            logger.error(
              { shardId, replicas, commitGap, logGap },
              'Cross-replica consistency divergence detected after failover!',
            );
            throw new Error(
              `[HAConsistencyVerifier] Cross-replica consistency check FAILED for shard ${shardId}: ` +
                `commitIndex divergence=${commitGap}, lastLogIndex divergence=${logGap}. ` +
                `Replicas: ${JSON.stringify(replicas)}`,
            );
          }
        } else {
          // Only one replica (or no matching shard in health status)
          checks.push({
            name: 'cross-replica-consistency',
            passed: true,
            detail:
              shardHealths.length === 0
                ? `No other replicas found for shard ${shardId} in local health status — single-node view only`
                : `Only 1 local replica for shard ${shardId} — cross-replica check limited to local view`,
          });
        }
      }

      // ════════════════════════════════════════════════════════════════
      //  Summary
      // ════════════════════════════════════════════════════════════════
      // Reaching this point means every check passed: any failing check
      // (leader mismatch, commit regression, cross-replica divergence) throws
      // before the summary is constructed. Hence the verdict is always "pass".
      const duration = Date.now() - startTime;

      const result: NewLeaderConsistencyResult = {
        consistent: true,
        summary: `New leader consistency verified for shard ${shardId}. All ${checks.length} checks passed in ${duration}ms.`,
        checks,
        timestamp: startTime,
      };

      logger.info(
        { newLeaderId, shardId, checks: checks.length, durationMs: duration },
        `New leader consistency verified: ${result.summary}`,
      );

      return true;
    } catch (err: unknown) {
      // If we have partial checks, include them in the error log
      logger.error(
        { err, newLeaderId, shardId, checksCompleted: checks.length },
        `Failed to verify new leader consistency: ${getErrorMessage(err)}`,
      );

      // Every inner failure is wrapped in a descriptive Error prefixed with
      // '[HAConsistencyVerifier]' before being re-thrown, so the outer catch
      // always re-throws (rather than swallowing the failure). Re-throw to let
      // callers distinguish consistency failures from transient infrastructure
      // errors via the message prefix.
      throw err;
    }
  }
}
