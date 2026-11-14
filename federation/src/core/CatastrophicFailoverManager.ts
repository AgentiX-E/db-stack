/**
 * CatastrophicFailoverManager — DC-level failure detection and recovery.
 *
 * Monitors datacenter health by tracking last-seen timestamps.
 * When a DC hasn't been heard from for longer than the timeout threshold,
 * it's marked as unhealthy and recovery procedures can be triggered.
 *
 * Features:
 *   - Timeout-based DC failure detection
 *   - Health status tracking per DC
 *   - Pending event tracking during DC outage
 *   - Recovery orchestration on DC reconnection
 */

import type { TopologyManager } from "../topology/TopologyManager";

/** Default timeout (ms) before considering a DC failed */
const DEFAULT_DC_TIMEOUT_MS = 30_000;

/**
 * Health status of a single datacenter.
 */
export interface DCHealthStatus {
  /** Datacenter identifier */
  dcId: string;
  /** Whether the DC is currently considered healthy */
  healthy: boolean;
  /** Epoch timestamp (ms) when this DC was last observed */
  lastSeen: number;
  /** Number of events pending while this DC was down */
  pendingEvents: number;
}

/**
 * Manages DC-level failure detection and recovery.
 */
export class CatastrophicFailoverManager {
  private readonly topology: TopologyManager;
  private readonly dcTimeoutMs: number;
  private readonly dcStatus: Map<string, DCHealthStatus> = new Map();

  constructor(topology: TopologyManager, dcTimeoutMs?: number) {
    this.topology = topology;
    this.dcTimeoutMs = dcTimeoutMs ?? DEFAULT_DC_TIMEOUT_MS;

    // Initialize health status for all known DCs
    this.initializeDCHealth();
  }

  /**
   * Initialize health tracking for each DC in the topology.
   */
  private initializeDCHealth(): void {
    const peers = this.topology.getAllPeers();
    const dcSet = new Set<string>();
    dcSet.add(this.topology.getLocalDc());
    for (const peer of peers) {
      dcSet.add(peer.dc);
    }
    for (const dc of dcSet) {
      this.dcStatus.set(dc, {
        dcId: dc,
        healthy: true,
        lastSeen: Date.now(),
        pendingEvents: 0,
      });
    }
  }

  /**
   * Detect whether a DC has failed based on the last-seen timestamp.
   *
   * A DC is considered failed if it hasn't been heard from within
   * the configured timeout window.
   */
  detectDCFailure(dcId: string): boolean {
    const status = this.dcStatus.get(dcId);
    if (!status) {
      return false;
    }
    if (!status.healthy) {
      return true;
    }
    const elapsed = Date.now() - status.lastSeen;
    if (elapsed >= this.dcTimeoutMs) {
      status.healthy = false;
      return true;
    }
    return false;
  }

  /**
   * Recover a failed DC.
   *
   * Resets the health status, clears pending events, and marks
   * the DC as healthy again.
   */
  async recoverDC(dcId: string): Promise<void> {
    const status = this.dcStatus.get(dcId);
    if (!status) {
      throw new Error(`CatastrophicFailoverManager: DC "${dcId}" not found`);
    }

    // Simulate recovery delay
    await new Promise((resolve) => setTimeout(resolve, 0));

    status.healthy = true;
    status.lastSeen = Date.now();
    status.pendingEvents = 0;
  }

  /**
   * Get the health status of all tracked DCs.
   */
  getDCHealth(): Map<string, DCHealthStatus> {
    const result = new Map<string, DCHealthStatus>();
    for (const [dcId, status] of this.dcStatus) {
      result.set(dcId, { ...status });
    }
    return result;
  }

  /**
   * Record heartbeats from a DC to update its last-seen timestamp.
   * This should be called whenever communication with a DC succeeds.
   */
  recordHeartbeat(dcId: string): void {
    const status = this.dcStatus.get(dcId);
    if (!status) {
      this.dcStatus.set(dcId, {
        dcId,
        healthy: true,
        lastSeen: Date.now(),
        pendingEvents: 0,
      });
      return;
    }
    status.lastSeen = Date.now();
    if (!status.healthy) {
      status.healthy = true;
    }
  }
}
