/**
 * D2 Rolling Upgrade interface.
 *
 * @module @agentix-e/db-operations-rollingupgrade/interfaces
 */

import type {
  RollingUpgradePlan,
  RollingUpgradeStats,
  RollingUpgradeEvent,
  UpgradePhase,
  UpgradeBatch,
  BatchHealth,
  NodeUpgradeState,
  CanaryConfig,
  DrainConfig,
} from "./types.js";

export type {
  RollingUpgradePlan,
  RollingUpgradeStats,
  RollingUpgradeEvent,
  UpgradePhase,
  UpgradeBatch,
  BatchHealth,
  NodeUpgradeState,
  CanaryConfig,
  DrainConfig,
};

/**
 * Rolling upgrade orchestrator contract.
 *
 * Implements zero-downtime rolling upgrades with canary deployment,
 * health gating, batch strategies, and automatic rollback.
 */
export interface IRollingUpgrade {
  /**
   * Validate and execute a rolling upgrade plan.
   * @returns Statistics describing the outcome.
   */
  execute(plan: RollingUpgradePlan): Promise<RollingUpgradeStats>;

  /** Current phase. */
  getPhase(): UpgradePhase;

  /** All batches with their node states. */
  getBatches(): UpgradeBatch[];

  /** Event history. */
  getEvents(): RollingUpgradeEvent[];

  /** Summary statistics. */
  getStats(): RollingUpgradeStats | null;

  /** Pause the upgrade at the next safe boundary. */
  pause(): Promise<void>;

  /** Resume a paused upgrade. */
  resume(): Promise<void>;

  /** Manually trigger a rollback of all upgraded batches. */
  rollback(): Promise<RollingUpgradeStats>;

  /** Register a health check executor by name. */
  registerHealthCheck(name: string, fn: (nodeId: string) => Promise<BatchHealth>): void;
}
