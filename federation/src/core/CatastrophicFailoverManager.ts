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

import type { TopologyManager } from '../topology/TopologyManager';

/** Default timeout (ms) before considering a DC failed */
const DEFAULT_DC_TIMEOUT_MS = 30_000;

/**
 * Engine-agnostic hooks for the recovery of a failed datacenter.
 *
 * The manager owns the health bookkeeping; the resource that actually has to
 * be reconfigured is owned by the caller (a cluster transport, a storage
 * engine, an orchestrator). `recover` is that boundary: the DC is not declared
 * healthy until it resolves, and a rejection leaves it failed. Omitting the
 * hooks keeps the historical state-only behaviour for engines that manage
 * recovery themselves.
 */
export interface CatastrophicFailoverHooks {
  /**
   * Perform the real recovery of a DC. Called with the pending-event count
   * accumulated while it was down, so the resource can replay rather than
   * discard queued work. A rejection aborts recovery.
   */
  recover?: (dcId: string, pendingEvents: number) => Promise<void>;
  /** Sink for a failed recovery; a non-Error rejection is normalised first. */
  onError?: (error: Error) => void;
}

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
  private readonly hooks: CatastrophicFailoverHooks;
  private readonly dcStatus: Map<string, DCHealthStatus> = new Map();

  constructor(topology: TopologyManager, dcTimeoutMs?: number, hooks: CatastrophicFailoverHooks = {}) {
    this.topology = topology;
    this.dcTimeoutMs = dcTimeoutMs ?? DEFAULT_DC_TIMEOUT_MS;
    this.hooks = hooks;

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
   * Record work that arrived for a DC while it was down.
   *
   * `pendingEvents` used to be a counter nothing incremented, so recovery had
   * nothing to hand back to the resource. Callers that queue writes for a
   * failed DC call this; `recoverDC()` passes the total to the injected
   * `recover` hook so the queued work can be replayed instead of dropped.
   * Unknown DCs are ignored — a phantom status entry must not be created.
   */
  recordPendingEvent(dcId: string, count = 1): void {
    const status = this.dcStatus.get(dcId);
    if (!status) return;
    status.pendingEvents += count;
  }

  /**
   * Recover a failed DC.
   *
   * When a `recover` hook is injected, the DC is declared healthy only after
   * it resolves, and it receives the pending-event count so queued work can be
   * replayed. A rejection leaves the DC failed with its pending work intact and
   * is routed through `onError`. Without a hook the historical state-only flip
   * still applies, for engines that perform recovery outside this manager.
   */
  async recoverDC(dcId: string): Promise<void> {
    const status = this.dcStatus.get(dcId);
    if (!status) {
      throw new Error(`CatastrophicFailoverManager: DC "${dcId}" not found`);
    }

    const { recover, onError } = this.hooks;
    if (recover) {
      try {
        await recover(dcId, status.pendingEvents);
      } catch (err) {
        if (onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
        // Recovery failed: the DC stays unhealthy and its pending work is
        // preserved so a later attempt can still replay it.
        return;
      }
    }

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
