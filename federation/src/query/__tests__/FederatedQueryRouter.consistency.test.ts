/**
 * F-11 — consistency-aware routing for FederatedQueryRouter.
 *
 * The router used to carry `consistency`, `minLsn`, `appliedLsn` and `lagMs`
 * through its types and consult none of them: a `strong` read was served at
 * whatever freshness the round-robin replica happened to have. These cases pin
 * the engine-agnostic freshness gate. A provider is injected by the engine —
 * the router never learns what a database is — and the verdict names the node,
 * the LSN and the lag that decided a route.
 *
 * TDD: every assertion here is written before the gate exists.
 */

import { describe, it, expect } from 'vitest';
import { FederatedQueryRouter } from '../FederatedQueryRouter.js';
import type { FederatedNode, FederatedQuery, NodeExecutor, NodeFreshness, FreshnessProvider } from '../types.js';

function makeNode(overrides: Partial<FederatedNode> = {}): FederatedNode {
  return {
    id: `node-${Math.random().toString(36).slice(2, 6)}`,
    host: 'localhost',
    port: 5432,
    role: 'primary',
    health: 'healthy',
    shardIds: ['shard-0'],
    weight: 0.5,
    capabilities: ['read', 'write'],
    region: 'us-east-1',
    ...overrides,
  };
}

function makeQuery(overrides: Partial<FederatedQuery> = {}): FederatedQuery {
  return {
    id: `q-${Math.random().toString(36).slice(2, 8)}`,
    sql: 'SELECT v FROM t WHERE k = $1',
    intent: 'read',
    consistency: 'eventual',
    targetShards: [],
    timeoutMs: 5000,
    ...overrides,
  };
}

function freshness(appliedLsn: number, lagMs = 0): NodeFreshness {
  return { appliedLsn, lagMs };
}

function provider(map: Record<string, NodeFreshness | undefined>): FreshnessProvider {
  return (nodeId) => map[nodeId];
}

/** Returns the node the router actually executed on, and a value tied to it. */
function valueByNode(values: Record<string, number>): NodeExecutor {
  return async (node, query, shardIds) => ({
    nodeId: node.id,
    shardIds,
    rows: [{ v: values[node.id] ?? -1 }],
    rowCount: 1,
    durationMs: 1,
    success: true,
  });
}

describe('F-11 consistency-aware routing', () => {
  it('strong routes a read to the fresh primary and returns its value, not the stale replica', async () => {
    // The replica is registered first, so round-robin would pick it without a gate.
    const router = new FederatedQueryRouter(undefined, provider({ replica: freshness(50), primary: freshness(100) }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    const query = makeQuery({ consistency: 'strong', minLsn: 80 });

    const verdict = router.getConsistencyVerdict(query);
    expect(verdict.gateActive).toBe(true);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.eligibleNodeIds).toEqual(['primary']);
    expect(verdict.blockedNodeIds).toContain('replica');

    const result = await router.executeQuery(query, valueByNode({ replica: 1, primary: 2 }));
    expect(result.success).toBe(true);
    expect(result.nodeResults.map((r) => r.nodeId)).toEqual(['primary']);
    expect(result.rows[0]!.v).toBe(2);
  });

  it('strong refuses when every node is behind minLsn and names the gap', async () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: freshness(40), replica: freshness(30) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));
    const query = makeQuery({ consistency: 'strong', minLsn: 60 });

    const verdict = router.getConsistencyVerdict(query);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe('stale-replica');
    expect(verdict.detail).toContain('minLsn=60');
    expect(verdict.detail).toContain('appliedLsn=40');

    const result = await router.executeQuery(query, valueByNode({ primary: 1, replica: 1 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('stale-replica');
    expect(result.nodeResults).toHaveLength(0);
  });

  it('a node with no freshness signal is blocked, not served optimistically', () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: undefined, replica: freshness(100) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong', minLsn: 10 }));
    expect(verdict.blockedNodeIds).toContain('primary');
    expect(verdict.eligibleNodeIds).toEqual(['replica']);
    expect(verdict.detail).toContain('no-freshness-signal');
  });

  it('lagMs participates in the gate when a maximum lag is configured', () => {
    const router = new FederatedQueryRouter(
      undefined,
      provider({ primary: freshness(100, 500), replica: freshness(100, 5) }),
    );
    router.setRoutingPolicy({ maxLagMs: 100 });
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong', minLsn: 10 }));
    expect(verdict.blockedNodeIds).toContain('primary');
    expect(verdict.eligibleNodeIds).toEqual(['replica']);
    expect(verdict.detail).toContain('lagMs=500');
  });

  it('read_your_writes uses the session LSN (minLsn) and refuses a stale replica', () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: freshness(100), replica: freshness(20) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'read_your_writes', minLsn: 90 }));
    expect(verdict.level).toBe('read_your_writes');
    expect(verdict.requiredLsn).toBe(90);
    expect(verdict.eligibleNodeIds).toEqual(['primary']);
    expect(verdict.blockedNodeIds).toEqual(['replica']);
  });

  it('read_your_writes without a session LSN is refused by name', () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: freshness(100) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'read_your_writes' }));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe('missing-session-lsn');
  });

  it('eventual ignores the gate even when the provider reports stale nodes', () => {
    const router = new FederatedQueryRouter(undefined, provider({ replica: freshness(1) }));
    router.registerNode(makeNode({ id: 'replica', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'eventual', minLsn: 999 }));
    expect(verdict.gateActive).toBe(false);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.eligibleNodeIds).toEqual(['replica']);
  });

  it('without a provider, strong keeps the historical behaviour and marks the gate inactive', async () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    const query = makeQuery({ consistency: 'strong', minLsn: 80 });

    const verdict = router.getConsistencyVerdict(query);
    expect(verdict.gateActive).toBe(false);
    expect(verdict.satisfied).toBe(true);

    const result = await router.executeQuery(query, valueByNode({ primary: 7 }));
    expect(result.success).toBe(true);
    expect(result.rows[0]!.v).toBe(7);
  });

  it('a provider set after construction activates the gate', () => {
    const router = new FederatedQueryRouter();
    router.setFreshnessProvider(provider({ primary: freshness(5) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong', minLsn: 10 }));
    expect(verdict.gateActive).toBe(true);
    expect(verdict.satisfied).toBe(false);
  });

  it('exposes the verdict of the most recent plan for inspection', () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: freshness(100) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));
    expect(router.getLastConsistencyVerdict()).toBeUndefined();

    router.planQuery(makeQuery({ consistency: 'strong', minLsn: 50 }));
    expect(router.getLastConsistencyVerdict()?.satisfied).toBe(true);
    expect(router.getLastConsistencyVerdict()?.requiredLsn).toBe(50);
  });

  it('strong with no minLsn requires appliedLsn >= 0 and still needs a signal', () => {
    const router = new FederatedQueryRouter(undefined, provider({ primary: freshness(0) }));
    router.registerNode(makeNode({ id: 'primary', role: 'primary' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong' }));
    expect(verdict.requiredLsn).toBe(0);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.eligibleNodeIds).toEqual(['primary']);
  });

  it('a gated query with no registered nodes refuses with the no-eligible-node reason', async () => {
    const router = new FederatedQueryRouter(undefined, provider({}));
    const query = makeQuery({ consistency: 'strong', minLsn: 5 });

    const verdict = router.getConsistencyVerdict(query);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe('no-eligible-node');
    expect(verdict.detail).toContain('no nodes registered');

    const result = await router.executeQuery(query, valueByNode({}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no-eligible-node');
    expect(result.error).toContain('no nodes registered');
  });

  it('classifies an all-unsigned route as no-freshness-signal', () => {
    const router = new FederatedQueryRouter(undefined, provider({ a: undefined, b: undefined }));
    router.registerNode(makeNode({ id: 'a', role: 'primary' }));
    router.registerNode(makeNode({ id: 'b', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong', minLsn: 1 }));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe('no-freshness-signal');
    expect(verdict.blockedNodeIds).toEqual(['a', 'b']);
  });

  it('classifies an all-lagging route as lag-exceeded', () => {
    const router = new FederatedQueryRouter(undefined, provider({ a: freshness(100, 900), b: freshness(100, 800) }));
    router.setRoutingPolicy({ maxLagMs: 100 });
    router.registerNode(makeNode({ id: 'a', role: 'primary' }));
    router.registerNode(makeNode({ id: 'b', role: 'replica' }));

    const verdict = router.getConsistencyVerdict(makeQuery({ consistency: 'strong', minLsn: 1 }));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe('lag-exceeded');
  });
});
