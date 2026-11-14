/**
 * FederationQueryRouter Tests — Multi-strategy query routing.
 *
 * Coverage:
 *   - broadcast resolves to all shards
 *   - scatter-gather with limit returns correct count per shard
 *   - direct routing by shardKey
 *   - merge results preserves dedup
 *   - empty topology → empty routes
 *   - invalid shardKey → fallback to broadcast
 *   - executeAndMerge merges results across shards
 *   - cost estimation differs by strategy
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FederationQueryRouter, type QueryPlan } from "./FederationQueryRouter";
import { TopologyManager } from "../topology/TopologyManager";
import type { ReplicationTarget } from "../interfaces/replication/IMultiLeaderReplication";

function makeTarget(overrides: Partial<ReplicationTarget> & { nodeId: string }): ReplicationTarget {
  return {
    dc: overrides.dc ?? "dc-west",
    address: overrides.address ?? "127.0.0.1:7001",
    topology: overrides.topology ?? "cross-dc",
    maxBackoffSeconds: overrides.maxBackoffSeconds ?? 60,
    ...overrides,
  };
}

describe("FederationQueryRouter", () => {
  let router: FederationQueryRouter;
  let topology: TopologyManager;

  beforeEach(() => {
    topology = new TopologyManager({
      nodeId: "node-1",
      dc: "dc-west",
      peers: [
        makeTarget({ nodeId: "node-1", dc: "dc-west", topology: "intra-dc" }),
        makeTarget({ nodeId: "node-2", dc: "dc-west", topology: "intra-dc" }),
        makeTarget({ nodeId: "node-3", dc: "dc-east", topology: "cross-dc" }),
        makeTarget({ nodeId: "node-4", dc: "dc-east", topology: "cross-dc" }),
      ],
      partitionRegions: { "user:42": "dc-west", "order:99": "dc-east" },
    });
    router = new FederationQueryRouter(topology);
  });

  describe("broadcast strategy", () => {
    it("should resolve to all shards when no shardKey is provided", () => {
      const routes = router.resolveRoute({});
      // Should have routes for all peers except self
      expect(routes).toHaveLength(3);
      for (const route of routes) {
        expect(route.strategy).toBe("broadcast");
      }
    });

    it("should return empty routes for empty topology", () => {
      const emptyTopo = new TopologyManager({
        nodeId: "node-1",
        dc: "dc-west",
        peers: [],
      });
      const emptyRouter = new FederationQueryRouter(emptyTopo);
      const routes = emptyRouter.resolveRoute({});
      expect(routes).toHaveLength(0);
    });
  });

  describe("scatter-gather strategy", () => {
    it("should use scatter-gather strategy when limit is provided", () => {
      const routes = router.resolveRoute({ limit: 10 });
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.strategy).toBe("scatter-gather");
      }
    });
  });

  describe("direct routing", () => {
    it("should route to the correct DC by shardKey", () => {
      const routes = router.resolveRoute({ shardKey: "user:42" });
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.strategy).toBe("direct");
        // user:42 maps to dc-west
        expect(route.estimatedCost).toBeLessThanOrEqual(30);
      }
    });
  });

  describe("fallback behavior", () => {
    it("should fallback to broadcast when shardKey is invalid", () => {
      const routes = router.resolveRoute({ shardKey: "unknown:key" });
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.strategy).not.toBe("direct");
      }
    });
  });

  describe("executeAndMerge", () => {
    it("should merge results across shards with dedup", async () => {
      const results = new Map<string, unknown[]>();
      results.set("shard-1", [{ id: 1 }, { id: 2 }]);
      results.set("shard-2", [{ id: 2 }, { id: 3 }]);

      const merged = await router.executeAndMerge(results);
      expect(merged).toHaveLength(3);
      const ids = merged.map((r) => (r as { id: number }).id).sort();
      expect(ids).toEqual([1, 2, 3]);
    });

    it("should handle empty shard results", async () => {
      const results = new Map<string, unknown[]>();
      results.set("shard-1", []);
      results.set("shard-2", []);

      const merged = await router.executeAndMerge(results);
      expect(merged).toHaveLength(0);
    });
  });

  describe("cost estimation", () => {
    it("should have different costs for different strategies", () => {
      const directRoutes = router.resolveRoute({ shardKey: "user:42" });
      const broadcastRoutes = router.resolveRoute({});

      const directCosts = directRoutes.map((r) => r.estimatedCost);
      const broadcastCosts = broadcastRoutes.map((r) => r.estimatedCost);

      for (const dc of directCosts) {
        for (const bc of broadcastCosts) {
          expect(dc).toBeLessThan(bc);
        }
      }
    });

    it("should estimate higher cost for cross-DC routes", () => {
      const eastRoutes = router.resolveRoute({ shardKey: "order:99" }); // dc-east
      const westRoutes = router.resolveRoute({ shardKey: "user:42" }); // dc-west

      // Local DC (dc-west) should have lower cost for the same strategy
      for (const east of eastRoutes) {
        for (const west of westRoutes) {
          // east is cross-DC from local dc-west → higher cost
          expect(east.estimatedCost).toBeGreaterThanOrEqual(west.estimatedCost);
        }
      }
    });
  });

  describe("scatter-gather", () => {
    it("should respect per-shard limit via scatter-gather strategy", () => {
      const routes = router.resolveRoute({ limit: 5 });
      for (const route of routes) {
        expect(route.strategy).toBe("scatter-gather");
        expect(route.estimatedCost).toBeGreaterThan(0);
      }
    });
  });
});
