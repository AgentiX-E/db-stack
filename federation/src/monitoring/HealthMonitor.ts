/**
 * HealthMonitor — DC-level health metrics and replication lag tracking.
 *
 * Monitors:
 *   1. Per-target replication lag (time since last successful delivery)
 *   2. Per-target pending queue depth
 *   3. Connection status to all targets
 *   4. Aggregation: DC-level health score from individual targets
 *
 * Emits onHighLag events when lag exceeds configurable thresholds.
 */

import type { IMultiLeaderReplication } from '../interfaces/replication/IMultiLeaderReplication';
import type { ReplicationStatus } from '../interfaces/replication/IMultiLeaderReplication';

export interface HealthMonitorConfig {
  /** Interval between health checks (ms) — default 5000 */
  checkIntervalMs?: number;
  /** High lag threshold (ms) — default 60000 (1 minute) */
  highLagThresholdMs?: number;
  /** Critical lag threshold (ms) — default 300000 (5 minutes) */
  criticalLagThresholdMs?: number;
}

export interface TargetHealth {
  targetNodeId: string;
  connected: boolean;
  lagMs: number;
  pendingCount: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
}

export interface FederationHealth {
  dc: string;
  nodeId: string;
  uptimeMs: number;
  startedAt: number;
  totalTargets: number;
  healthyTargets: number;
  warningTargets: number;
  criticalTargets: number;
  targets: TargetHealth[];
}

export class HealthMonitor {
  private readonly replication: IMultiLeaderReplication;
  private readonly config: Required<HealthMonitorConfig>;
  private readonly startedAt: number;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Callbacks for high-lag events */
  private readonly highLagCallbacks: Array<(targetNodeId: string, lagMs: number) => void> = [];
  /** Callbacks for health change events */
  private readonly healthChangeCallbacks: Array<(health: FederationHealth) => void> = [];

  constructor(replication: IMultiLeaderReplication, config?: HealthMonitorConfig) {
    this.replication = replication;
    this.config = {
      checkIntervalMs: config?.checkIntervalMs ?? 5000,
      highLagThresholdMs: config?.highLagThresholdMs ?? 60_000,
      criticalLagThresholdMs: config?.criticalLagThresholdMs ?? 300_000,
    };
    this.startedAt = Date.now();
  }

  /**
   * Start periodic health checks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Immediate first check
    this.check().catch(() => {});

    // Periodic checks
    this.checkTimer = setInterval(() => {
      this.check().catch(() => {});
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Run a single health check.
   */
  async check(): Promise<FederationHealth> {
    let status: ReplicationStatus;
    try {
      status = await this.replication.getStatus();
    } catch {
      // Replication not started or unavailable
      status = { nodeId: 'unknown', dc: 'unknown', targets: [] };
    }

    const targets: TargetHealth[] = status.targets.map((t) => {
      const targetStatus = this.classifyHealth(t.lagMs, t.connected);
      return {
        targetNodeId: t.targetNodeId,
        connected: t.connected,
        lagMs: t.lagMs,
        pendingCount: t.pendingCount,
        lastSuccessAt: t.lastSuccessAt,
        lastErrorAt: t.lastErrorAt,
        lastErrorMessage: t.lastErrorMessage,
        status: targetStatus,
      };
    });

    const health: FederationHealth = {
      dc: status.dc,
      nodeId: status.nodeId,
      uptimeMs: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      totalTargets: targets.length,
      healthyTargets: targets.filter((t) => t.status === 'healthy').length,
      warningTargets: targets.filter((t) => t.status === 'warning').length,
      criticalTargets: targets.filter((t) => t.status === 'critical').length,
      targets,
    };

    // Fire high-lag callbacks.
    //
    // `pendingCount > 0` is part of the condition, not a detail: a target with
    // nothing owed is not lagging, and a consumer that treats it as lagging
    // forwards every read away from a healthy replica forever. The lag figure
    // itself now comes from the queue, so this is belt and braces against a
    // monitor fed by an implementation that still reports clock arithmetic.
    for (const t of targets) {
      if (t.pendingCount > 0 && t.status !== 'healthy' && t.lagMs > 0) {
        for (const cb of this.highLagCallbacks) {
          cb(t.targetNodeId, t.lagMs);
        }
      }
    }

    // Fire health change callbacks
    for (const cb of this.healthChangeCallbacks) {
      cb(health);
    }

    return health;
  }

  /**
   * Register a callback for when a target experiences high lag.
   */
  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void {
    this.highLagCallbacks.push(callback);
    return () => {
      const idx = this.highLagCallbacks.indexOf(callback);
      if (idx >= 0) this.highLagCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for health state changes.
   */
  onHealthChange(callback: (health: FederationHealth) => void): () => void {
    this.healthChangeCallbacks.push(callback);
    return () => {
      const idx = this.healthChangeCallbacks.indexOf(callback);
      if (idx >= 0) this.healthChangeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Classify target health based on lag and connection status.
   */
  private classifyHealth(lagMs: number, connected: boolean): TargetHealth['status'] {
    if (!connected) return 'unknown';
    if (lagMs === 0) return 'healthy';
    if (lagMs < this.config.highLagThresholdMs) return 'healthy';
    if (lagMs < this.config.criticalLagThresholdMs) return 'warning';
    return 'critical';
  }
}
