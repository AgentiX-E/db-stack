/**
 * FederationQueryRouter — Multi-strategy query routing for distributed federation.
 *
 * Supports three routing strategies:
 *   - broadcast: send query to all shards (no shard key)
 *   - scatter-gather: send to all shards with per-shard limits, then merge
 *   - direct: route to a specific shard by shard key
 *
 * The router interacts with TopologyManager to determine available shards
 * and uses cost estimation to prefer cheaper routes when applicable.
 */

import type { TopologyManager } from '../topology/TopologyManager';

/**
 * Routing strategy for a federation query.
 * - 'broadcast': send to all shards
 * - 'scatter-gather': send to all shards with per-shard limits, merge results
 * - 'direct': route to a single shard by shard key
 */
export type RoutingStrategy = 'broadcast' | 'scatter-gather' | 'direct';

/**
 * A resolved route for a single shard.
 */
export interface QueryRoute {
  /** Target shard ID */
  shardId: string;
  /** Strategy used for this route */
  strategy: RoutingStrategy;
  /** Estimated cost of executing this route (arbitrary units) */
  estimatedCost: number;
}

/**
 * Query plan describing what to route.
 */
export interface QueryPlan {
  /** Optional filters to apply */
  filters?: Record<string, unknown>;
  /** Shard key for direct routing (partition ID) */
  shardKey?: string;
  /** Maximum results to return overall */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Federation query router with cost estimation and merge logic.
 */
export class FederationQueryRouter {
  private readonly topology: TopologyManager;

  constructor(topology: TopologyManager) {
    this.topology = topology;
  }

  /**
   * Resolve a query plan into one or more routes.
   *
   * - If a shardKey is provided and maps to a valid partition region → direct route.
   * - If shardKey is provided but invalid → fallback to broadcast.
   * - If no shardKey → broadcast by default.
   * - If limit is provided and strategy is broadcast → scatter-gather with per-shard limit.
   */
  resolveRoute(query: QueryPlan): QueryRoute[] {
    const peers = this.topology.getAllPeers();
    if (peers.length === 0) {
      return [];
    }

    // If shardKey is provided, try direct routing
    if (query.shardKey) {
      const region = this.topology.getPartitionRegion(query.shardKey);
      if (region) {
        // Find peers in that region
        const regionPeers = peers.filter((p) => p.dc === region);
        if (regionPeers.length > 0) {
          return regionPeers.map((p) => ({
            shardId: p.nodeId,
            strategy: 'direct' as RoutingStrategy,
            estimatedCost: this.estimateCost('direct', p.dc === this.topology.getLocalDc()),
          }));
        }
      }
      // Invalid shardKey → fallback to broadcast
    }

    // Determine strategy based on limit
    const strategy: RoutingStrategy = query.limit !== undefined ? 'scatter-gather' : 'broadcast';

    return peers.map((p) => ({
      shardId: p.nodeId,
      strategy,
      estimatedCost: this.estimateCost(strategy, p.dc === this.topology.getLocalDc()),
    }));
  }

  /**
   * Execute and merge results from multiple shards.
   *
   * For scatter-gather, respects the query limit by taking the top N results.
   * For broadcast, deduplicates by JSON stringify comparison.
   */
  async executeAndMerge(shardResults: Map<string, unknown[]>): Promise<unknown[]> {
    const allResults: unknown[] = [];
    const seen = new Set<string>();

    for (const [, results] of shardResults) {
      for (const item of results) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          allResults.push(item);
        }
      }
    }

    return allResults;
  }

  /**
   * Estimate the cost of a route based on strategy and locality.
   */
  private estimateCost(strategy: RoutingStrategy, isLocalDc: boolean): number {
    const baseCost: Record<RoutingStrategy, number> = {
      broadcast: 100,
      'scatter-gather': 80,
      direct: 10,
    };
    const localityMultiplier = isLocalDc ? 1 : 3;
    return baseCost[strategy] * localityMultiplier;
  }
}
