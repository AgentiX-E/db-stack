/**
 * SchemaEvolutionCoordinator — Distributed schema change orchestration.
 *
 * Coordinates schema changes across multiple shards in a federation.
 * Supports:
 *   - proposeChange: apply a schema change to all target shards
 *   - rollback: revert a previously applied change using rollbackSql
 *   - getAppliedChanges: inspect the history of applied changes
 *
 * Schema changes are replicated via the multi-leader replication layer
 * to ensure all shards receive the change consistently.
 */

import type { IMultiLeaderReplication } from '../interfaces/replication/IMultiLeaderReplication';

/**
 * A schema change proposal.
 */
export interface SchemaChange {
  /** Unique identifier for this change */
  id: string;
  /** The SQL DDL statement to execute */
  sql: string;
  /** Schema version number (monotonically increasing) */
  version: number;
  /** Shards to apply this change to */
  shards: string[];
  /** Optional SQL to roll back this change */
  rollbackSql?: string;
}

/**
 * Result of a schema change proposal.
 */
export interface SchemaChangeResult {
  /** Whether the change was applied successfully on all shards */
  success: boolean;
  /** The change ID */
  changeId: string;
  /** Shards where the change was applied */
  appliedShards: string[];
  /** Shards where the change failed */
  failedShards: string[];
}

/**
 * Coordinated schema evolution across federation shards.
 */
export class SchemaEvolutionCoordinator {
  private readonly replication: IMultiLeaderReplication;
  private readonly appliedChanges: Map<string, SchemaChange> = new Map();

  constructor(replication: IMultiLeaderReplication) {
    this.replication = replication;
  }

  /**
   * Propose a schema change across the specified shards.
   *
   * Serializes the change and replicates it to all target shards.
   * Returns a result indicating which shards succeeded or failed.
   */
  async proposeChange(change: SchemaChange): Promise<SchemaChangeResult> {
    const appliedShards: string[] = [];
    const failedShards: string[] = [];

    for (const shardId of change.shards) {
      try {
        // Replicate the schema change as a special federation message
        const payload = JSON.stringify({
          __schemaChange: true,
          id: change.id,
          sql: change.sql,
          version: change.version,
          rollbackSql: change.rollbackSql,
        });
        await this.replication.replicate(0, payload, `schema:${change.id}`);
        appliedShards.push(shardId);
      } catch {
        failedShards.push(shardId);
      }
    }

    // Track the change if at least one shard succeeded
    if (appliedShards.length > 0) {
      this.appliedChanges.set(change.id, change);
    }

    return {
      success: failedShards.length === 0,
      changeId: change.id,
      appliedShards,
      failedShards,
    };
  }

  /**
   * Rollback a previously applied schema change.
   *
   * Looks up the change by ID and executes its rollbackSql
   * on all shards that had it applied.
   */
  async rollback(changeId: string): Promise<void> {
    const change = this.appliedChanges.get(changeId);
    if (!change) {
      throw new Error(`SchemaEvolutionCoordinator: change "${changeId}" not found`);
    }
    if (!change.rollbackSql) {
      throw new Error(`SchemaEvolutionCoordinator: change "${changeId}" has no rollback SQL`);
    }

    const payload = JSON.stringify({
      __schemaChange: true,
      __rollback: true,
      id: change.id,
      sql: change.rollbackSql,
      version: change.version,
    });

    // Replicate rollback to all shards that had the change
    for (const shardId of change.shards) {
      await this.replication.replicate(0, payload, `schema-rollback:${change.id}`);
    }

    this.appliedChanges.delete(changeId);
  }

  /**
   * Get all applied schema changes.
   */
  getAppliedChanges(): SchemaChange[] {
    return Array.from(this.appliedChanges.values());
  }
}
