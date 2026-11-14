/**
 * I17 — Chaos Engine v2.0
 *
 * Architecture Decision:
 *   db-operations/chaosengine owns the IChaosEngine contract and scenario
 *   definition. db-cluster and db-federation provide adapters that translate
 *   abstract faults into concrete transport/consensus injections.
 *
 * Design invariants:
 *   CHAOS1 — Fault inject/health/recover atomic; no partial state leaks
 *   CHAOS2 — All faults deterministic-reproducible via seed
 *   CHAOS3 — Zero production code paths in chaosengine (pure test harness)
 *   CHAOS4 — Scenario runner supports DAG of fault sequences
 *   CHAOS5 — Transport-level injection (not RPC mock) for realism
 *   CHAOS6 — After recovery, all replicas eventually consistent
 */

// ── Fault Primitives ─────────────────────────────────────────

/**
 * Compared to v0.1 (only `FaultType: 'latency'|'error'|'crash'|'partition'|'resource_exhaustion'`),
 * v2.0 adds targets-aware fault injection with temporal bounds and cascade options.
 */
export type FaultTypeV2 =
  | 'network-partition'   // Isolate targets from each other or from a group
  | 'node-crash'          // Kill/stop target(s), optionally restart after durationMs
  | 'message-loss'        // Drop a percentage of messages between targets
  | 'latency-injection'   // Add fixed or jittery delay to messages
  | 'clock-skew'          // Skew HLC/wall-clock on target(s)
  | 'resource-pressure'   // CPU/memory/disk saturation
  | 'leadership-flap'     // Force leader step-down (Raft-specific)
  | 'cascading-failure';  // Chain of dependent faults across targets

export interface ChaosFaultV2 {
  /** Unique fault ID (auto-generated if omitted) */
  faultId?: string;
  /** Fault type */
  type: FaultTypeV2;
  /** Target identifiers — transport node ids, DC ids, or shard ids */
  targets: string[];
  /** Duration after which fault auto-resolves (0 = manual resolve only) */
  durationMs: number;
  /** Fault-specific configuration */
  config: Record<string, unknown>;
  /** Human-readable description for scenario log */
  description?: string;
}

export interface ChaosScenarioStep {
  /** Step name */
  name: string;
  /** Fault to inject in this step */
  fault: ChaosFaultV2;
  /** Wait ms before next step (after injection) */
  waitMs: number;
  /** Invariants to verify during this step's duration */
  invariants?: ChaoticInvariant[];
}

export interface ChaosScenario {
  /** Scenario name */
  name: string;
  /** Description of what this scenario validates */
  description: string;
  /** Ordered steps */
  steps: ChaosScenarioStep[];
  /** Seed for deterministic reproducibility */
  seed: number;
  /** Maximum total duration (ms) */
  maxDurationMs: number;
}

// ── Invariants ───────────────────────────────────────────────

export type ChaoticInvariant =
  | 'eventual-consistency'
  | 'no-data-loss'
  | 'no-split-brain'
  | 'hlc-monotonic'
  | 'cdc-idempotent'
  | 'leader-exists'
  | 'quorum-committed'
  | 'outbox-no-duplicates'
  | 'conflict-resolution-deterministic'
  | 'custom';

export interface InvariantCheckResult {
  invariant: ChaoticInvariant;
  passed: boolean;
  detail: string;
  /** Optional quantitative measurement */
  measurement?: Record<string, number>;
}

export interface ScenarioRunResult {
  scenarioName: string;
  passed: boolean;
  stepsExecuted: number;
  totalSteps: number;
  durationMs: number;
  invariantResults: InvariantCheckResult[];
  faultHistory: ChaosFaultV2[];
  errors: string[];
}

// ── Transport Adapter Interface ──────────────────────────────

/**
 * IChaosTransport — the seam between chaosengine and the
 * actual network layer (Raft transport, federation transport).
 *
 * Each repository implements this to expose their transport
 * to the chaos engine for fault injection.
 */
export interface IChaosTransport {
  /** Globally unique transport identifier */
  transportId: string;
  /** Isolate this transport from specific peer transports */
  isolate(peerTransportIds: string[]): void;
  /** Restore connectivity to specific peers */
  heal(peerTransportIds: string[]): void;
  /** Heal all partitions */
  healAll(): void;
  /** Set message loss rate (0-1) */
  setMessageLoss(rate: number): void;
  /** Set latency (ms) */
  setLatency(ms: number): void;
  /** Completely stop this transport (simulate crash) */
  stop(): Promise<void>;
  /** Restart after crash */
  start(): Promise<void>;
  /** Get current transport stats */
  getStats(): ChaosTransportStats;
  /** Check if transport is healthy */
  isHealthy(): boolean;
}

export interface ChaosTransportStats {
  messagesSent: number;
  messagesLost: number;
  messagesDelayed: number;
  partitioned: number;
  avgLatencyMs: number;
  connectedPeers: number;
  totalPeers: number;
}

// ── Invariant Checker Interface ──────────────────────────────

/**
 * IChaoticInvariantChecker — each repository provides its own
 * invariant verification logic.
 */
export interface IChaoticInvariantChecker {
  check(invariant: ChaoticInvariant): Promise<InvariantCheckResult>;
  checkAll(invariants: ChaoticInvariant[]): Promise<InvariantCheckResult[]>;
}

// ── True Random Number Generator Interface ────────────────────

export interface IChaosRNG {
  /** Returns [0, 1) */
  next(): number;
  /** Pick a random element from array */
  pick<T>(arr: T[]): T;
  /** Pick n random elements from array */
  pickN<T>(arr: T[], n: number): T[];
  /** Shuffle array in place */
  /** Shuffle array in place, returns the same array */
  shuffle<T>(arr: T[]): T[];
}

// ── Main Engine Interface ────────────────────────────────────

export interface IChaosEngineV2 {
  // ── Lifecycle ──────────────────────────────────────────

  /** Start the engine with a set of registered transports */
  start(transports: IChaosTransport[]): Promise<void>;

  /** Stop the engine, heal all faults, clean up */
  stop(): Promise<void>;

  // ── Fault Injection ─────────────────────────────────────

  /** Inject a single fault */
  inject(fault: ChaosFaultV2): Promise<string>; // returns faultId

  /** Inject multiple faults simultaneously */
  injectMany(faults: ChaosFaultV2[]): Promise<string[]>;

  /** Resolve a specific fault */
  resolve(faultId: string): Promise<void>;

  /** Heal all active faults */
  healAll(): Promise<void>;

  // ── Query ───────────────────────────────────────────────

  /** Get currently active faults */
  getActiveFaults(): ChaosFaultV2[];

  /** Get fault injection history */
  getHistory(): ChaosFaultV2[];

  /** Get transport stats for all registered transports */
  getAllTransportStats(): Map<string, ChaosTransportStats>;

  // ── Scenario Runner ─────────────────────────────────────

  /** Run a complete chaos scenario */
  runScenario(scenario: ChaosScenario, checker: IChaoticInvariantChecker): Promise<ScenarioRunResult>;

  // ── Events ──────────────────────────────────────────────

  /** Fires when a fault is injected */
  onFaultInjected(callback: (fault: ChaosFaultV2) => void): () => void;

  /** Fires when a fault is resolved */
  onFaultResolved(callback: (faultId: string) => void): () => void;

  /** Fires when a scenario step completes */
  onStepCompleted(callback: (step: number, total: number) => void): () => void;

  /** Fires when a scenario completes */
  onScenarioCompleted(callback: (result: ScenarioRunResult) => void): () => void;
}
