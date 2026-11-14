/**
 * C6 Schema Federation — cross-shard schema version sync, drift detection,
 * coordinated migration orchestration, and schema repair.
 *
 * Builds on MigrationsDescriptor/MigrationPlan from @agentix-e/db-operations-core.
 *
 * @module @agentix-e/db-operations-federation/interfaces
 */

import type { MigrationDescriptor, MigrationPlan } from "@agentix-e/db-operations-core";

// Re-export for convenience
export type { MigrationDescriptor, MigrationPlan };

// ── Schema Snapshot ─────────────────────────────────────────

/** Canonical snapshot of a shard's schema state. */
export interface SchemaSnapshot {
  /** Shard identifier. */
  shardId: string;
  /** Current schema version on this shard. */
  version: number;
  /** Ordered list of all applied migrations and their states. */
  migrations: MigrationDescriptor[];
  /** Full checksum of the applied migration chain (SHA-256). */
  chainChecksum: string;
  /** When this snapshot was taken (epoch ms). */
  capturedAt: number;
}

// ── Schema Drift ────────────────────────────────────────────

/** Severity of a schema drift. */
export type DriftSeverity = "info" | "warning" | "critical";

/** Type of schema drift detected. */
export type DriftType =
  | "version_mismatch"      // shard at wrong version
  | "missing_migration"     // migration applied on peer but not here
  | "extra_migration"       // migration applied here but not on peer
  | "checksum_divergence"   // same version, different checksum
  | "order_divergence"      // migrations applied in different order
  | "migration_state_mismatch"; // pending/running/failed on one, different on peer

/** A single drift entry between a shard and its reference/peer. */
export interface SchemaDrift {
  /** Unique drift ID. */
  id: string;
  /** Drift type. */
  type: DriftType;
  /** Severity. */
  severity: DriftSeverity;
  /** Shard that has drifted. */
  shardId: string;
  /** Reference shard (baseline for comparison). */
  referenceShardId: string;
  /** Version on the drifted shard. */
  driftedVersion: number;
  /** Version on the reference shard. */
  referenceVersion: number;
  /** The migration descriptor that triggered the drift (if applicable). */
  migration?: MigrationDescriptor;
  /** Migration checksum on drifted shard (for checksum_divergence). */
  driftedChecksum?: string;
  /** Migration checksum on reference shard. */
  referenceChecksum?: string;
  /** Human-readable description. */
  description: string;
  /** When the drift was detected (epoch ms). */
  detectedAt: number;
  /** Whether this drift has been resolved. */
  resolved: boolean;
  /** If resolved, which repair action was applied. */
  resolution?: string;
}

// ── Repair Action ───────────────────────────────────────────

/** Action to repair a schema drift. */
export type RepairAction =
  | "apply_migration"       // apply missing migration(s)
  | "rollback_migration"    // rollback extra migration(s)
  | "reorder_migrations"    // fix order by rolling back and reapplying
  | "resync_snapshot"       // full resync from reference
  | "mark_resolved"         // manual resolution (no-op)
  | "force_version";        // force-set version without running migrations

/** A single repair plan targeting one drift. */
export interface DriftRepair {
  /** Drift being repaired. */
  driftId: string;
  /** Action to take. */
  action: RepairAction;
  /** Migrations to apply (if apply_migration). */
  migrationsToApply?: MigrationDescriptor[];
  /** Migration to rollback (if rollback_migration). */
  migrationToRollback?: MigrationDescriptor;
  /** Whether this repair requires downtime. */
  requiresDowntime: boolean;
  /** Whether this repair can be automated. */
  automatable: boolean;
  /** Whether the repair was successful. */
  success?: boolean;
  /** Error if repair failed. */
  error?: string;
  /** When the repair was executed (epoch ms). */
  executedAt?: number;
}

// ── Migration Coordination ──────────────────────────────────

/** State of a coordinated migration across shards. */
export type CoordinationState =
  | "preparing"    // validating preconditions, checking shards
  | "rolling_out"  // actively applying to shards
  | "verifying"    // post-apply drift check
  | "completed"    // all shards confirmed
  | "rolled_back"  // failure, rolled back all applied shards
  | "paused";      // paused mid-rollout (manual intervention needed)

/** Target shard selection mode for a coordinated migration. */
export type CoordinationMode =
  | "all"          // apply to all shards
  | "canary"       // apply to a canary shard first, then all
  | "batched"      // apply in rolling batches (1 shard per batch)
  | "manual";      // user picks which shards

/** A coordinated migration across multiple shards. */
export interface CoordinatedMigration {
  /** Unique migration ID. */
  id: string;
  /** Migration plan being executed. */
  plan: MigrationPlan;
  /** Shards involved. */
  shardIds: string[];
  /** Coordination mode. */
  mode: CoordinationMode;
  /** Canary shard (if canary mode). */
  canaryShardId?: string;
  /** Current coordination state. */
  state: CoordinationState;
  /** Ordered results per shard. */
  shardResults: ShardMigrationResult[];
  /** Whether to verify after apply (drift check). */
  verifyAfterApply: boolean;
  /** When coordination started (epoch ms). */
  startedAt: number;
  /** When coordination completed (epoch ms). */
  completedAt?: number;
  /** Error message if coordination failed. */
  error?: string;
}

/** Migration result for a single shard. */
export interface ShardMigrationResult {
  /** Shard ID. */
  shardId: string;
  /** Migration version applied. */
  version: number;
  /** Whether the migration succeeded on this shard. */
  success: boolean;
  /** Time taken on this shard (ms). */
  durationMs: number;
  /** Error message if failed. */
  error?: string;
  /** Post-migration drift check (if verifyAfterApply). */
  driftCheck?: DriftCheckResult;
}

/** Result of a post-migration drift verification. */
export interface DriftCheckResult {
  /** Whether the shard matches the expected schema after migration. */
  matches: boolean;
  /** Detected drifts (empty if matches). */
  drifts: SchemaDrift[];
}

// ── Drift Monitor ───────────────────────────────────────────

/** Configuration for the drift monitor. */
export interface DriftMonitorConfig {
  /** How often to scan for drift (ms). Poll-based. */
  scanIntervalMs: number;
  /** Auto-resolve non-critical drifts? */
  autoResolve: boolean;
  /** Max drifts to store in history. */
  maxDriftHistory: number;
  /** Drift types to treat as critical (triggers alert). */
  criticalDriftTypes: DriftType[];
  /** Reference shard strategy. */
  referenceStrategy: ReferenceStrategy;
}

/** How to select the reference shard for drift comparison. */
export type ReferenceStrategy =
  | "primary"       // primary/coordinator shard is the baseline
  | "majority"      // the version most shards agree on
  | "latest"        // the highest-version shard
  | "canonical";    // a manually nominated canonical shard ID

/** Monitoring statistics. */
export interface DriftMonitorStats {
  /** Total drift scans performed. */
  totalScans: number;
  /** Total drifts detected over all scans. */
  totalDriftsDetected: number;
  /** Currently active (unresolved) drifts. */
  activeDrifts: number;
  /** Total drifts resolved. */
  driftsResolved: number;
  /** Auto-resolved drifts. */
  autoResolved: number;
  /** Manually resolved drifts. */
  manuallyResolved: number;
  /** Drifts broken down by type. */
  driftsByType: Record<DriftType, number>;
  /** Drifts broken down by severity. */
  driftsBySeverity: Record<DriftSeverity, number>;
  /** Last scan timestamp (epoch ms). */
  lastScanAt: number | null;
  /** Last scan duration (ms). */
  lastScanDurationMs: number;
}

// ── Schema Validator ────────────────────────────────────────

/** A rule for schema validation. */
export interface SchemaRule {
  /** Rule name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Whether this rule is enforced. */
  enforced: boolean;
  /** Check function — returns true if schema passes the rule. */
  check: (snapshot: SchemaSnapshot) => boolean;
  /** Severity if rule fails. */
  severity: DriftSeverity;
}

// ── Federation Interface ────────────────────────────────────

/**
 * Schema federator — manages cross-shard schema coherence.
 *
 * Responsibilities:
 *  1. Capture and compare schema snapshots across shards
 *  2. Detect schema drift (version, checksum, order divergence)
 *  3. Generate repair plans for detected drifts
 *  4. Coordinate migration rollout across shards
 *  5. Continuous drift monitoring with periodic scans
 */
export interface ISchemaFederator {
  // ── Snapshots ──────────────────────────────────────────

  /** Capture the current schema state of a shard. */
  captureSnapshot(shardId: string): Promise<SchemaSnapshot>;

  /** Get the latest captured snapshot for a shard. */
  getSnapshot(shardId: string): SchemaSnapshot | undefined;

  /** Compare two shards and return all drifts between them. */
  compareShards(shardAId: string, shardBId: string): SchemaDrift[];

  /** Compare a shard against the canonical reference. */
  compareAgainstReference(shardId: string): SchemaDrift[];

  // ── Drift Management ───────────────────────────────────

  /** Scan all known shards and report all drifts. */
  detectAllDrifts(): Promise<SchemaDrift[]>;

  /** Get a specific drift by ID. */
  getDrift(driftId: string): SchemaDrift | undefined;

  /** Get all active (unresolved) drifts. */
  getActiveDrifts(): SchemaDrift[];

  /** Get all drifts for a specific shard. */
  getDriftsForShard(shardId: string): SchemaDrift[];

  /** Get drift history (all resolved). */
  getDriftHistory(): SchemaDrift[];

  // ── Repair ─────────────────────────────────────────────

  /** Generate a repair plan for a given drift. */
  planRepair(drift: SchemaDrift): DriftRepair;

  /** Execute a repair plan. */
  executeRepair(repair: DriftRepair): Promise<DriftRepair>;

  /** Auto-repair all non-critical drifts. */
  autoRepair(): Promise<DriftRepair[]>;

  /** Resolve a drift manually (mark as resolved without action). */
  resolveManually(driftId: string, resolution: string): SchemaDrift;

  // ── Migration Coordination ─────────────────────────────

  /** Start a coordinated migration rollout across shards. */
  startCoordinatedMigration(
    plan: MigrationPlan,
    mode: CoordinationMode,
    verify?: boolean,
  ): CoordinatedMigration;

  /** Report migration result for a single shard (called by execution layer). */
  reportShardResult(
    coordId: string,
    result: ShardMigrationResult,
  ): void;

  /** Get the state of a coordinated migration. */
  getCoordinationState(coordId: string): CoordinatedMigration | undefined;

  /** Pause an in-progress coordination. */
  pauseCoordination(coordId: string): CoordinatedMigration;

  /** Resume a paused coordination. */
  resumeCoordination(coordId: string): CoordinatedMigration;

  // ── Rules ──────────────────────────────────────────────

  /** Register a custom schema validation rule. */
  registerRule(rule: SchemaRule): void;

  /** Unregister a rule. */
  unregisterRule(name: string): void;

  /** Validate a snapshot against all registered rules. */
  validateSnapshot(snapshot: SchemaSnapshot): SchemaDrift[];

  // ── Monitor ────────────────────────────────────────────

  /** Start periodic drift monitoring. */
  startMonitor(cfg?: Partial<DriftMonitorConfig>): void;

  /** Stop periodic drift monitoring. */
  stopMonitor(): void;

  /** Force a scan now. */
  scanNow(): Promise<SchemaDrift[]>;

  /** Set the canonical reference shard. */
  setCanonicalShard(shardId: string): void;

  // ── Stats ──────────────────────────────────────────────

  /** Get monitoring statistics. */
  getMonitorStats(): DriftMonitorStats;

  /** Register a shard with its initial schema snapshot. */
  registerShard(snapshot: SchemaSnapshot): void;
}
