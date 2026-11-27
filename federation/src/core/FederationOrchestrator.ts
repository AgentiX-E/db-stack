/**
 * FederationOrchestrator — the missing point between detection and recovery.
 *
 * The federation layer had all the pieces: a detector that emits
 * `heartbeat-expired`, a failover manager that can mark a DC failed and recover
 * it with a real resource hook, and a health monitor. Nothing in production
 * connected them — the expiry's only subscriber counted events, and the failover
 * manager had no caller. A silent datacenter therefore stayed healthy in the
 * bookkeeping that recovery reads.
 *
 * This class is that connection, and deliberately knows nothing about sockets,
 * clusters or storage engines. The three collaborators are narrow interfaces a
 * caller supplies: a source of failure signals, a source of recovery signals,
 * and the failover actions to drive. An arbitrary engine plugs into those seams;
 * the orchestrator only applies one policy — silence fails a DC, a peer coming
 * back recovers it, a failed recovery keeps it failed, and two recoveries for
 * one DC at once collapse into one.
 *
 * All callbacks are optional boundary hooks (`onReconfigure`, `onError`) so an
 * engine that manages its own reconfiguration pays nothing for this component.
 */

/** The shape of a heartbeat-expiry signal, shared with DCSplitBrainDetector. */
export interface HeartbeatExpiredEvent {
  dcId: string;
  lastSeen: number;
  silenceMs: number;
}

/**
 * A source of DC-failure signals. `DCSplitBrainDetector` satisfies this
 * directly: a heartbeat that stops arriving is the fact a failure is built on.
 */
export interface FailureSignalSource {
  onHeartbeatExpired(callback: (event: HeartbeatExpiredEvent) => void): () => void;
}

/**
 * A source of recovery signals. `FederationManager.onTargetRecovered` satisfies
 * this: a peer delivering again is the only evidence that a DC is back.
 */
export interface RecoverySignalSource {
  onTargetRecovered(callback: (targetNodeId: string) => void): () => void;
}

/**
 * The failover actions to drive. `CatastrophicFailoverManager` satisfies this
 * directly, so the orchestrator never imports a concrete engine.
 */
export interface FailoverActions {
  /** Feed the detector's real silence duration before asking for a verdict. */
  observeSilence?(dcId: string, silenceMs: number): void;
  detectDCFailure(dcId: string): boolean;
  recoverDC(dcId: string): Promise<void>;
  recordPendingEvent(dcId: string, count?: number): void;
}

export interface FederationOrchestratorConfig {
  failureSource: FailureSignalSource;
  recoverySource: RecoverySignalSource;
  failover: FailoverActions;
  /** Map a recovered target node to the DC whose recovery it signals. */
  resolveDc: (nodeId: string) => string | undefined;
  /** Engine-agnostic reconfiguration once a DC is healthy again. */
  onReconfigure?: (dcId: string, healthy: boolean) => Promise<void> | void;
  /** Sink for a failed recovery or reconfiguration. */
  onError?: (error: Error) => void;
}

/** Observable state of the orchestration, for a status page or a test. */
export interface OrchestrationStatus {
  started: boolean;
  failedDcs: string[];
  recoveries: number;
  recoveryFailures: number;
  ignoredRecoveries: number;
  coalescedRecoveries: number;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class FederationOrchestrator {
  private readonly config: FederationOrchestratorConfig;
  private readonly failed = new Set<string>();
  private readonly inFlight = new Set<string>();
  private unsubFailure: (() => void) | null = null;
  private unsubRecovery: (() => void) | null = null;
  private started = false;
  private recoveries = 0;
  private recoveryFailures = 0;
  private ignoredRecoveries = 0;
  private coalescedRecoveries = 0;

  constructor(config: FederationOrchestratorConfig) {
    this.config = config;
  }

  /** Subscribe to both signal sources. Idempotent. */
  start(): void {
    if (this.started) return;
    this.unsubFailure = this.config.failureSource.onHeartbeatExpired((event) => {
      // Feed the observed silence before asking for a verdict: the failover
      // manager's clock starts at construction, which is not when the peer
      // last spoke. Without this the detector's real observation is judged
      // against a clock that never saw it.
      this.config.failover.observeSilence?.(event.dcId, event.silenceMs);
      if (this.config.failover.detectDCFailure(event.dcId)) {
        this.failed.add(event.dcId);
      }
    });
    this.unsubRecovery = this.config.recoverySource.onTargetRecovered((nodeId) => {
      void this.recover(nodeId);
    });
    this.started = true;
  }

  /** Unsubscribe both sources. Timers owned by the sources are not touched. */
  stop(): void {
    this.unsubFailure?.();
    this.unsubRecovery?.();
    this.unsubFailure = null;
    this.unsubRecovery = null;
    this.started = false;
  }

  /**
   * Record work that arrived for a DC while it was down. Delegated straight to
   * the failover actions so the pending count handed to `recover` is the one
   * the resource will actually replay — there is no second counter here.
   */
  recordPending(dcId: string, count = 1): void {
    this.config.failover.recordPendingEvent(dcId, count);
  }

  private async recover(nodeId: string): Promise<void> {
    const dcId = this.config.resolveDc(nodeId);
    if (dcId === undefined) {
      this.ignoredRecoveries += 1;
      return;
    }
    // Two peers of one DC recovering at once are one recovery of that DC. The
    // second signal is still observed (counted), not silently discarded.
    if (this.inFlight.has(dcId)) {
      this.coalescedRecoveries += 1;
      return;
    }
    this.inFlight.add(dcId);
    try {
      await this.config.failover.recoverDC(dcId);
      this.failed.delete(dcId);
      this.recoveries += 1;
      // Reconfiguration is a boundary hook, so its failure is reported but
      // does not undo a recovery that the resource already performed.
      try {
        await this.config.onReconfigure?.(dcId, true);
      } catch (err) {
        this.config.onError?.(asError(err));
      }
    } catch (err) {
      this.recoveryFailures += 1;
      this.config.onError?.(asError(err));
    } finally {
      this.inFlight.delete(dcId);
    }
  }

  getStatus(): OrchestrationStatus {
    return {
      started: this.started,
      failedDcs: [...this.failed].sort(),
      recoveries: this.recoveries,
      recoveryFailures: this.recoveryFailures,
      ignoredRecoveries: this.ignoredRecoveries,
      coalescedRecoveries: this.coalescedRecoveries,
    };
  }
}
