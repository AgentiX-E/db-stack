/**
 * P3-86 — a decision query on the router names the level, the replica and the
 * age of the data a read would see.
 *
 * The defect this pins: a caller could plan or execute a query, but had no way
 * to ask "which side did the router choose, at what level, and how stale is the
 * data it would read" without re-deriving the freshness comparison itself. The
 * decision is inspection-only: it must not advance routing counters or mutate
 * node health, so an operator can ask it as often as needed.
 *
 * TDD: every assertion here is written before the method exists.
 */

import { describe, it, expect } from 'vitest';
import { FederatedQueryRouter } from '../FederatedQueryRouter.js';
import type { FederatedNode, FederatedQuery, FreshnessProvider, NodeFreshness } from '../types.js';

function makeNode(overrides: Partial<FederatedNode> = {}): FederatedNode {
  return {
    id: 'node-1',
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
    id: 'q-1',
    sql: 'SELECT v FROM t WHERE k = $1',
    intent: 'read',
    consistency: 'eventual',
    targetShards: [],
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('explainDecision — level, replica, age', () => {
  it('names the requested level and the chosen replica for an eventual read', () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ id: 'q-ev', consistency: 'eventual' }));
    expect(decision.level).toBe('eventual');
    expect(decision.selectedReplica).toBe('node-1');
    expect(decision.satisfied).toBe(true);
    expect(decision.strategy).toBe('round_robin');
  });

  it('reports age from the freshness provider for the chosen replica', () => {
    const provider: FreshnessProvider = (id) => (id === 'node-1' ? { appliedLsn: 12, lagMs: 340 } : undefined);
    const router = new FederatedQueryRouter({}, provider);
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'strong', minLsn: 10 }));
    expect(decision.selectedReplica).toBe('node-1');
    expect(decision.replicaAgeMs).toBe(340);
    expect(decision.appliedLsn).toBe(12);
  });

  it('reports a null age when no provider is configured', () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'eventual' }));
    expect(decision.replicaAgeMs).toBeNull();
    expect(decision.appliedLsn).toBeNull();
  });

  it('reports a null age when the chosen replica has no freshness signal', () => {
    const provider: FreshnessProvider = () => undefined;
    const router = new FederatedQueryRouter({}, provider);
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'eventual' }));
    expect(decision.selectedReplica).toBe('node-1');
    expect(decision.replicaAgeMs).toBeNull();
  });

  it('names the refusal when a strong read cannot be satisfied', () => {
    const fresh: NodeFreshness = { appliedLsn: 3, lagMs: 10 };
    const provider: FreshnessProvider = () => fresh;
    const router = new FederatedQueryRouter({}, provider);
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'strong', minLsn: 100 }));
    expect(decision.satisfied).toBe(false);
    expect(decision.selectedReplica).toBeNull();
    expect(decision.replicaAgeMs).toBeNull();
    expect(decision.reason).toBe('stale-replica');
    expect(decision.level).toBe('strong');
  });

  it('names the missing-session-lsn refusal for read_your_writes without minLsn', () => {
    const provider: FreshnessProvider = () => ({ appliedLsn: 3, lagMs: 10 });
    const router = new FederatedQueryRouter({}, provider);
    router.registerNode(makeNode({ id: 'node-1' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'read_your_writes' }));
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toBe('missing-session-lsn');
  });

  it('selects only an eligible replica among several for a gated read', () => {
    const provider: FreshnessProvider = (id) =>
      id === 'fresh' ? { appliedLsn: 50, lagMs: 5 } : { appliedLsn: 5, lagMs: 900 };
    const router = new FederatedQueryRouter({}, provider);
    router.registerNode(makeNode({ id: 'stale' }));
    router.registerNode(makeNode({ id: 'fresh' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'strong', minLsn: 20 }));
    expect(decision.satisfied).toBe(true);
    expect(decision.selectedReplica).toBe('fresh');
    expect(decision.replicaAgeMs).toBe(5);
  });

  it('is inspection-only: it does not advance the round-robin counter', () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: 'node-1' }));
    router.registerNode(makeNode({ id: 'node-2' }));
    const decision = router.explainDecision(makeQuery({ consistency: 'eventual' }));
    expect(decision.selectedReplica).toBe('node-1');
    const plan = router.planQuery(makeQuery({ id: 'q-next', consistency: 'eventual' }));
    expect(plan.assignments[0]?.nodeId).toBe('node-1');
  });

  it('returns no replica when no nodes are registered', () => {
    const router = new FederatedQueryRouter();
    const decision = router.explainDecision(makeQuery({ consistency: 'eventual' }));
    expect(decision.satisfied).toBe(false);
    expect(decision.selectedReplica).toBeNull();
    expect(decision.reason).toBe('no-eligible-node');
  });

  it('names the strategy that would be used', () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: 'least_connections' });
    router.registerNode(
      makeNode({
        id: 'node-1',
        load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 1, pendingQueries: 1, avgLatencyMs: 1 },
      }),
    );
    const decision = router.explainDecision(makeQuery({ consistency: 'eventual' }));
    expect(decision.strategy).toBe('least_connections');
  });
});
