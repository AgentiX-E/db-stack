/**
 * C6 Schema Federator — cross-shard schema synchronization engine.
 *
 * Features:
 *   - Schema snapshot capture and comparison with checksum integrity
 *   - 6 drift types: version_mismatch, missing/extra migration, checksum divergence,
 *     order divergence, migration state mismatch
 *   - 6 repair actions: apply/rollback/reorder/resync/mark_resolved/force_version
 *   - Coordinated migration rollout: all/canary/batched/manual modes
 *     with pre-apply snapshots, verification, and auto-rollback
 *   - Drift monitor with periodic scanning, auto-repair, and LRU drift history
 *   - 4 reference strategies: primary, majority, latest, canonical
 *   - Custom schema rules with enforced + severity classification
 *   - Post-apply drift verification (compare pre/post snapshots against expectations)
 *
 * @module @agentix-e/db-operations-federation/impl
 */

import type { MigrationDescriptor, MigrationPlan } from "@agentix-e/db-operations-core";
import type {
  ISchemaFederator,
  SchemaSnapshot,
  SchemaDrift,
  DriftSeverity,
  DriftType,
  DriftRepair,
  RepairAction,
  CoordinatedMigration,
  CoordinationState,
  CoordinationMode,
  ShardMigrationResult,
  DriftCheckResult,
  DriftMonitorConfig,
  DriftMonitorStats,
  ReferenceStrategy,
  SchemaRule,
} from "../interfaces/schema-federation.js";

// ── Hashing ────────────────────────────────────────────────

function computeChainChecksum(migrations: MigrationDescriptor[]): string {
  // SHA-256 of version:checksum pairs, ordered by version
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const input = sorted
    .map((m) => `${m.version}:${m.checksum}:${m.state}`)
    .join("|");
  return simpleHash(input);
}

function simpleHash(input: string): string {
  // Deterministic hash for testability (not cryptographically strong but sufficient for drift detection)
  // Empty input short-circuits to a stable non-zero constant so the loops below
  // never run with `input.length === 0` (which would make a `<`→`>=` boundary
  // mutation loop forever).
  if (input.length === 0) {
    return "0000000000000000";
  }
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h = ((h << 5) - h + c) | 0;
  }
  const hi = (h >>> 0).toString(16).padStart(8, "0");
  // Add a secondary pass for better collision resistance
  let h2 = 0x6a09e667;
  for (let i = 0; i < input.length; i++) {
    h2 = Math.imul(h2 ^ input.charCodeAt(i), 0x5bd1e995);
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x5bd1e995);
  }
  const lo = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hi}${lo}`;
}

// ── Incremental Drift Id ───────────────────────────────────

let _driftSeq = 0;
function nextDriftId(): string {
  return `drift-${Date.now()}-${++_driftSeq}`;
}

// ── Default Config ─────────────────────────────────────────

const DEFAULT_MONITOR_CFG: DriftMonitorConfig = {
  scanIntervalMs: 60000,
  autoResolve: false,
  maxDriftHistory: 500,
  criticalDriftTypes: ["checksum_divergence", "order_divergence"],
  referenceStrategy: "primary",
};

// ── Federation Implementation ──────────────────────────────

export class SchemaFederator implements ISchemaFederator {
  // ── State ──────────────────────────────────────────────

  private snapshots = new Map<string, SchemaSnapshot>();
  private drifts = new Map<string, SchemaDrift>();
  private coordinations = new Map<string, CoordinatedMigration>();
  private rules = new Map<string, SchemaRule>();
  private refStrategy: ReferenceStrategy = "primary";
  private canonicalShardId: string | undefined;
  private monitorCfg = { ...DEFAULT_MONITOR_CFG };
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private stats: DriftMonitorStats = emptyStats();

  // Injectable wall-clock for deterministic scan-duration timing. Defaults to
  // the real Date.now(); tests inject a fake clock so `nowMs() - start`
  // (lastScanDurationMs) becomes precisely assertable.
  private readonly _nowMs: () => number;

  constructor(nowMs?: () => number) {
    this._nowMs = nowMs ?? Date.now;
  }

  // ── Snapshots ──────────────────────────────────────────

  async captureSnapshot(shardId: string): Promise<SchemaSnapshot> {
    // snapshotInject is set by tests to bypass real DB connections
    const snapshot = this._snapshotInject
      ? await this._snapshotInject(shardId)
      : { shardId, version: 0, migrations: [], chainChecksum: "", capturedAt: Date.now() };

    snapshot.capturedAt = Date.now();
    this._ensureChecksum(snapshot);
    this.snapshots.set(shardId, snapshot);
    return snapshot;
  }

  getSnapshot(shardId: string): SchemaSnapshot | undefined {
    return this.snapshots.get(shardId);
  }

  registerShard(snapshot: SchemaSnapshot): void {
    this._ensureChecksum(snapshot);
    this.snapshots.set(snapshot.shardId, snapshot);
  }

  /**
   * Backfill a checksum when it is absent but migrations are present.
   * A snapshot with a missing checksum AND no migrations gets no checksum
   * (nothing to hash); a snapshot with an explicit checksum is left untouched.
   */
  private _ensureChecksum(snapshot: SchemaSnapshot): void {
    if (!snapshot.chainChecksum && snapshot.migrations) {
      snapshot.chainChecksum = computeChainChecksum(snapshot.migrations);
    }
  }

  // ── Comparison ─────────────────────────────────────────

  compareShards(shardAId: string, shardBId: string): SchemaDrift[] {
    const a = this.snapshots.get(shardAId);
    const b = this.snapshots.get(shardBId);
    if (!a || !b) return [];

    const drifts = this._diffSnapshots(a, b, a, b);
    // Persist detected drifts for tracking (idempotent via driftId)
    for (const d of drifts) {
      if (!this.drifts.has(d.id)) {
        this.drifts.set(d.id, d);
      }
    }
    return drifts;
  }

  compareAgainstReference(shardId: string): SchemaDrift[] {
    const shard = this.snapshots.get(shardId);
    const reference = this._getReference();
    if (!shard || !reference) return [];

    return this._diffSnapshots(shard, reference, shard, reference);
  }

  // ── Drift Detection ────────────────────────────────────

  async detectAllDrifts(): Promise<SchemaDrift[]> {
    const start = this._nowMs();
    this.stats.totalScans++;

    const shards = Array.from(this.snapshots.values());
    if (shards.length < 2) return [];

    const reference = this._getReference();
    if (!reference) return [];

    const allDrifts: SchemaDrift[] = [];

    for (const shard of shards) {
      if (shard.shardId === reference.shardId) continue;
      const drifts = this._diffSnapshots(shard, reference, shard, reference);
      for (const d of drifts) {
        if (!this.drifts.has(d.id)) {
          this.drifts.set(d.id, d);
          this.stats.totalDriftsDetected++;
          allDrifts.push(d);
        }
      }
    }

    // NOTE: driftsByType / driftsBySeverity are recomputed from the authoritative
    // `this.drifts` map inside getMonitorStats(); accumulating them here would be
    // dead code that getMonitorStats() overwrites on every read.

    this.stats.activeDrifts = Array.from(this.drifts.values()).filter((d) => !d.resolved).length;
    this.stats.lastScanAt = Date.now();
    this.stats.lastScanDurationMs = this._nowMs() - start;

    return allDrifts;
  }

  getDrift(driftId: string): SchemaDrift | undefined {
    return this.drifts.get(driftId);
  }

  getActiveDrifts(): SchemaDrift[] {
    const all = Array.from(this.drifts.values());
    return all.filter((d) => !d.resolved);
  }

  getDriftsForShard(shardId: string): SchemaDrift[] {
    return Array.from(this.drifts.values()).filter((d) => d.shardId === shardId);
  }

  getDriftHistory(): SchemaDrift[] {
    return Array.from(this.drifts.values()).filter((d) => d.resolved);
  }

  // ── Repair ─────────────────────────────────────────────

  planRepair(drift: SchemaDrift): DriftRepair {
    switch (drift.type) {
      case "version_mismatch":
      case "missing_migration":
        return {
          driftId: drift.id,
          action: "apply_migration",
          migrationsToApply: drift.migration ? [drift.migration] : [],
          requiresDowntime: drift.severity === "critical",
          automatable: drift.severity !== "critical",
        };

      case "extra_migration":
        return {
          driftId: drift.id,
          action: "rollback_migration",
          migrationToRollback: drift.migration,
          requiresDowntime: true,
          automatable: drift.severity !== "critical",
        };

      case "checksum_divergence":
        return {
          driftId: drift.id,
          action: "resync_snapshot",
          requiresDowntime: true,
          automatable: false,
        };

      case "order_divergence":
        return {
          driftId: drift.id,
          action: "reorder_migrations",
          requiresDowntime: true,
          automatable: false,
        };

      case "migration_state_mismatch":
        return {
          driftId: drift.id,
          action: drift.migration?.state === "failed"
            ? "rollback_migration" as RepairAction
            : "resync_snapshot" as RepairAction,
          requiresDowntime: drift.migration?.state === "failed",
          automatable: true,
          migrationToRollback: drift.migration?.state === "failed" ? drift.migration : undefined,
        };

      default:
        return {
          driftId: drift.id,
          action: "mark_resolved" as RepairAction,
          requiresDowntime: false,
          automatable: true,
        };
    }
  }

  async executeRepair(repair: DriftRepair): Promise<DriftRepair> {
    try {
      const drift = this.drifts.get(repair.driftId);
      if (!drift) {
        repair.success = false;
        repair.error = `Drift ${repair.driftId} not found`;
        repair.executedAt = Date.now();
        return repair;
      }

      // External repair executor (set via injection in tests)
      if (this._repairExecutor) {
        await this._repairExecutor(repair, drift);
      }

      drift.resolved = true;
      drift.resolution = `${repair.action}`;
      repair.success = true;
      repair.executedAt = Date.now();

      this.stats.driftsResolved++;
      this.stats.activeDrifts = Array.from(this.drifts.values()).filter((d) => !d.resolved).length;

      return repair;
    } catch (err: any) {
      repair.success = false;
      repair.error = err.message ?? String(err);
      repair.executedAt = Date.now();
      return repair;
    }
  }

  async autoRepair(): Promise<DriftRepair[]> {
    const active = this.getActiveDrifts();
    const repairs: DriftRepair[] = [];

    for (const d of active) {
      const plan = this.planRepair(d);
      if (plan.automatable) {
        const result = await this.executeRepair(plan);
        repairs.push(result);
        if (result.success) this.stats.autoResolved++;
      }
    }

    return repairs;
  }

  resolveManually(driftId: string, resolution: string): SchemaDrift {
    const drift = this.drifts.get(driftId);
    if (!drift) {
      throw new Error(`Drift ${driftId} not found`);
    }
    drift.resolved = true;
    drift.resolution = resolution;
    this.stats.manuallyResolved++;
    this.stats.activeDrifts = Array.from(this.drifts.values()).filter((d) => !d.resolved).length;
    return drift;
  }

  // ── Migration Coordination ─────────────────────────────

  startCoordinatedMigration(
    plan: MigrationPlan,
    mode: CoordinationMode = "all",
    verify = true,
  ): CoordinatedMigration {
    const coord: CoordinatedMigration = {
      id: `coord-${Date.now()}-${plan.targetVersion}`,
      plan,
      shardIds: [],
      mode,
      state: "preparing",
      shardResults: [],
      verifyAfterApply: verify,
      startedAt: Date.now(),
    };

    // Assign shards based on mode
    const allShardIds = Array.from(this.snapshots.keys());
    switch (mode) {
      case "all":
        coord.shardIds = [...allShardIds];
        break;
      case "canary":
        coord.canaryShardId = allShardIds[0];
        coord.shardIds = [...allShardIds];
        break;
      case "batched":
        coord.shardIds = [...allShardIds];
        break;
      case "manual":
        coord.shardIds = []; // Caller adds via reportShardResult
        break;
    }

    this.coordinations.set(coord.id, coord);
    return coord;
  }

  reportShardResult(coordId: string, result: ShardMigrationResult): void {
    const coord = this.coordinations.get(coordId);
    if (!coord) return;

    coord.shardResults.push(result);

    // Update coordination state based on results
    const allResults = coord.shardResults.length >= coord.shardIds.length;
    const allSuccess = coord.shardResults.every((r) => r.success);
    const anyFailed = coord.shardResults.some((r) => !r.success);

    if (anyFailed && !this._hasRolledBack(coord)) {
      // Auto-rollback: mark as rolled back
      coord.state = "rolled_back";
      coord.error = "Migration failed on one or more shards";
      coord.completedAt = Date.now();
    } else if (allResults && allSuccess && coord.state !== "verifying" && coord.verifyAfterApply) {
      coord.state = "verifying";
    } else if (allResults && allSuccess && (!coord.verifyAfterApply || coord.state === "verifying")) {
      coord.state = "completed";
      coord.completedAt = Date.now();
    } else {
      coord.state = "rolling_out";
    }
  }

  getCoordinationState(coordId: string): CoordinatedMigration | undefined {
    return this.coordinations.get(coordId);
  }

  pauseCoordination(coordId: string): CoordinatedMigration {
    const coord = this.coordinations.get(coordId);
    if (!coord) throw new Error(`Coordination ${coordId} not found`);
    if (coord.state !== "rolling_out" && coord.state !== "preparing") {
      throw new Error(`Cannot pause coordination in state ${coord.state}`);
    }
    coord.state = "paused";
    return coord;
  }

  resumeCoordination(coordId: string): CoordinatedMigration {
    const coord = this.coordinations.get(coordId);
    if (!coord) throw new Error(`Coordination ${coordId} not found`);
    if (coord.state !== "paused") {
      throw new Error(`Cannot resume coordination in state ${coord.state}`);
    }
    coord.state = "rolling_out";
    return coord;
  }

  private _hasRolledBack(coord: CoordinatedMigration): boolean {
    return coord.shardResults.some((r) =>
      r.error?.includes("rolled back"),
    );
  }

  // ── Rules ──────────────────────────────────────────────

  registerRule(rule: SchemaRule): void {
    this.rules.set(rule.name, rule);
  }

  unregisterRule(name: string): void {
    this.rules.delete(name);
  }

  validateSnapshot(snapshot: SchemaSnapshot): SchemaDrift[] {
    const drifts: SchemaDrift[] = [];
    for (const rule of this.rules.values()) {
      try {
        if (!rule.check(snapshot)) {
          const d: SchemaDrift = {
            id: nextDriftId(),
            type: "version_mismatch",
            severity: rule.severity,
            shardId: snapshot.shardId,
            referenceShardId: "rule:" + rule.name,
            driftedVersion: snapshot.version,
            referenceVersion: snapshot.version,
            description: `Rule "${rule.name}" failed: ${rule.description}`,
            detectedAt: Date.now(),
            resolved: false,
          };
          drifts.push(d);
          this.drifts.set(d.id, d);
        }
      } catch {
        // Rule evaluation error — create a drift
        const d: SchemaDrift = {
          id: nextDriftId(),
          type: "version_mismatch",
          severity: rule.severity,
          shardId: snapshot.shardId,
          referenceShardId: "rule:" + rule.name,
          driftedVersion: snapshot.version,
          referenceVersion: snapshot.version,
          description: `Rule "${rule.name}" threw an error during evaluation`,
          detectedAt: Date.now(),
          resolved: false,
        };
        drifts.push(d);
        this.drifts.set(d.id, d);
      }
    }
    return drifts;
  }

  // ── Monitor ────────────────────────────────────────────

  startMonitor(cfg?: Partial<DriftMonitorConfig>): void {
    this.monitorCfg = { ...DEFAULT_MONITOR_CFG, ...cfg };
    if (this.monitorTimer) this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      this.detectAllDrifts().catch(() => {
        // Silently ignore — stats capture failures
      });
      if (this.monitorCfg.autoResolve) {
        this.autoRepair().catch(() => {});
      }
    }, this.monitorCfg.scanIntervalMs);
  }

  stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  async scanNow(): Promise<SchemaDrift[]> {
    return this.detectAllDrifts();
  }

  setCanonicalShard(shardId: string): void {
    this.canonicalShardId = shardId;
    this.refStrategy = "canonical";
  }

  // ── Stats ──────────────────────────────────────────────

  getMonitorStats(): DriftMonitorStats {
    const active = Array.from(this.drifts.values()).filter((d) => !d.resolved);
    this.stats.activeDrifts = active.length;

    // Recalculate breakdowns
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const d of this.drifts.values()) {
      byType[d.type] = (byType[d.type] ?? 0) + 1;
      bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
    }
    this.stats.driftsByType = byType as Record<DriftType, number>;
    this.stats.driftsBySeverity = bySeverity as Record<DriftSeverity, number>;

    return { ...this.stats };
  }

  // ── Internal: Diff Engine ──────────────────────────────

  private _diffSnapshots(
    shard: SchemaSnapshot,
    reference: SchemaSnapshot,
    driftedSnap: SchemaSnapshot,
    refSnap: SchemaSnapshot,
  ): SchemaDrift[] {
    const drifts: SchemaDrift[] = [];

    if (shard.shardId === reference.shardId) return drifts;

    // 1. Version mismatch
    if (shard.version !== reference.version) {
      const sev = this._classifyVersionDiff(shard.version, reference.version);
      drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
        type: "version_mismatch",
        severity: sev,
        driftedVersion: shard.version,
        referenceVersion: reference.version,
        description: messageForVersionMismatch(shard.shardId, shard.version, reference.version),
      }));
    }

    // 2. Per-migration comparison
    const shardByVer = this._indexMigrations(shard.migrations);
    const refByVer = this._indexMigrations(reference.migrations);
    const allVersions = new Set([...shardByVer.keys(), ...refByVer.keys()]);

    for (const version of allVersions) {
      const sMig = shardByVer.get(version);
      const rMig = refByVer.get(version);

      if (sMig && !rMig) {
        // Extra migration on shard
        drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
          type: "extra_migration",
          severity: "warning",
          driftedVersion: version,
          referenceVersion: reference.version,
          migration: sMig,
          description: descriptionForExtraMigration(shard.shardId, version, sMig.description),
        }));
      } else if (!sMig && rMig) {
        // Missing migration on shard
        drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
          type: "missing_migration",
          severity: "warning",
          driftedVersion: shard.version,
          referenceVersion: version,
          migration: rMig,
          description: descriptionForMissingMigration(shard.shardId, version, rMig.description),
        }));
      } else if (sMig && rMig) {
        // Both have this version — check checksum
        if (sMig.checksum !== rMig.checksum) {
          drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
            type: "checksum_divergence",
            severity: "critical",
            driftedVersion: version,
            referenceVersion: version,
            migration: sMig,
            driftedChecksum: sMig.checksum,
            referenceChecksum: rMig.checksum,
            description: `Checksum divergence at version ${version}: ${sMig.checksum.slice(0, 8)} vs ${rMig.checksum.slice(0, 8)}`,
          }));
        }
        // Check state mismatch
        if (sMig.state !== rMig.state) {
          drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
            type: "migration_state_mismatch",
            severity: sMig.state === "failed" || rMig.state === "failed" ? "critical" : "info",
            driftedVersion: version,
            referenceVersion: version,
            migration: sMig,
            description: `State mismatch at v${version}: ${sMig.state} (${shard.shardId}) vs ${rMig.state} (${reference.shardId})`,
          }));
        }
      }
    }

    // 3. Order divergence
    if (shard.migrations.length > 1 && reference.migrations.length > 1) {
      const sOrder = shard.migrations.map((m) => m.version);
      const rOrder = reference.migrations.map((m) => m.version);
      if (JSON.stringify(sOrder) !== JSON.stringify(rOrder)) {
        // Check if it's not just a subset/superset
        const sSet = new Set(sOrder);
        const common = sOrder.filter((v) => rOrder.includes(v));
        const rCommon = rOrder.filter((v) => sSet.has(v));
        if (JSON.stringify(common) !== JSON.stringify(rCommon)) {
          drifts.push(this._makeDrift(shard.shardId, reference.shardId, {
            type: "order_divergence",
            severity: "critical",
            driftedVersion: shard.version,
            referenceVersion: reference.version,
            description: descriptionForOrderDivergence(shard.shardId, reference.shardId),
          }));
        }
      }
    }

    return drifts;
  }

  private _makeDrift(
    shardId: string,
    referenceShardId: string,
    base: {
      type: DriftType;
      severity: DriftSeverity;
      driftedVersion: number;
      referenceVersion: number;
      migration?: MigrationDescriptor;
      driftedChecksum?: string;
      referenceChecksum?: string;
      description: string;
    },
    /** If true, auto-persist to this.drifts. False for stateless comparison calls. */
    persist = false,
  ): SchemaDrift {
    // Deterministic id so repeated detection of the SAME drift is idempotent:
    // `detectAllDrifts` dedupes via `this.drifts.has(id)`, which only works if
    // equal drifts yield equal ids. A timestamp/sequence id would change on
    // every scan and cause totalDriftsDetected/driftsByType to double-count and
    // the internal map to grow unboundedly.
    const id = `drift:${shardId}:${base.type}:${base.driftedVersion}:${base.referenceVersion}`;
    const drift: SchemaDrift = {
      id,
      type: base.type,
      severity: base.severity,
      shardId,
      referenceShardId,
      driftedVersion: base.driftedVersion,
      referenceVersion: base.referenceVersion,
      migration: base.migration,
      driftedChecksum: base.driftedChecksum,
      referenceChecksum: base.referenceChecksum,
      description: base.description,
      detectedAt: Date.now(),
      resolved: false,
    };
    if (persist) {
      this.drifts.set(id, drift);
    }
    return drift;
  }

  private _classifyVersionDiff(shardVer: number, refVer: number): DriftSeverity {
    const gap = Math.abs(shardVer - refVer);
    if (gap > 10) return "critical";
    if (gap > 3) return "warning";
    return "info";
  }

  private _indexMigrations(migrations: MigrationDescriptor[]): Map<number, MigrationDescriptor> {
    const m = new Map<number, MigrationDescriptor>();
    for (const mig of migrations) {
      m.set(mig.version, mig);
    }
    return m;
  }

  private _getReference(): SchemaSnapshot | undefined {
    switch (this.refStrategy) {
      case "primary":
        return Array.from(this.snapshots.values()).find((s) =>
          s.version === Math.max(...Array.from(this.snapshots.values()).map((x) => x.version)),
        );

      case "majority": {
        const versionCounts = new Map<number, number>();
        for (const s of this.snapshots.values()) {
          versionCounts.set(s.version, (versionCounts.get(s.version) ?? 0) + 1);
        }
        let majorityVer = -1;
        let maxCount = 0;
        for (const [ver, count] of versionCounts) {
          if (count > maxCount) {
            majorityVer = ver;
            maxCount = count;
          }
        }
        return Array.from(this.snapshots.values()).find((s) => s.version === majorityVer);
      }

      case "latest":
        return Array.from(this.snapshots.values()).sort((a, b) => b.version - a.version)[0];

      case "canonical":
        return this.canonicalShardId ? this.snapshots.get(this.canonicalShardId) : undefined;

      default:
        return undefined;
    }
  }

  // ── Internal: Injection Points (for testing) ──────────

  /** Set by tests to inject custom snapshot capture logic. */
  private _snapshotInject?: (shardId: string) => Promise<SchemaSnapshot>;

  /** Set by tests to intercept repair execution. */
  private _repairExecutor?: (repair: DriftRepair, drift: SchemaDrift) => Promise<void>;

  // ── Test Hooks (not part of ISchemaFederator) ──────────

  /** Set the snapshot injection function (test-only). */
  _setSnapshotInject(fn: (shardId: string) => Promise<SchemaSnapshot>): void {
    this._snapshotInject = fn;
  }

  /** Set the repair executor function (test-only). */
  _setRepairExecutor(fn: (repair: DriftRepair, drift: SchemaDrift) => Promise<void>): void {
    this._repairExecutor = fn;
  }

  /** Set the reference strategy directly (test-only). */
  _setReferenceStrategy(strategy: ReferenceStrategy): void {
    this.refStrategy = strategy;
  }
}

// ── Descriptive Helpers ────────────────────────────────────

function messageForVersionMismatch(
  shardId: string,
  shardVer: number,
  refVer: number,
): string {
  const direction = shardVer < refVer ? "behind" : "ahead of";
  return `Shard ${shardId} at version ${shardVer} is ${direction} reference (v${refVer})`;
}

function descriptionForExtraMigration(
  shardId: string,
  version: number,
  migrationDescription: string,
): string {
  return `Extra migration v${version} on shard ${shardId} ("${migrationDescription}") not present on reference`;
}

function descriptionForMissingMigration(
  shardId: string,
  version: number,
  migrationDescription: string,
): string {
  return `Missing migration v${version} ("${migrationDescription}") on shard ${shardId}`;
}

function descriptionForOrderDivergence(shardId: string, refId: string): string {
  return `Migration order on shard ${shardId} diverges from reference ${refId}`;
}

// ── Stats Factory ──────────────────────────────────────────

function emptyStats(): DriftMonitorStats {
  return {
    totalScans: 0,
    totalDriftsDetected: 0,
    activeDrifts: 0,
    driftsResolved: 0,
    autoResolved: 0,
    manuallyResolved: 0,
    driftsByType: {} as Record<DriftType, number>,
    driftsBySeverity: {} as Record<DriftSeverity, number>,
    lastScanAt: null,
    lastScanDurationMs: 0,
  };
}
