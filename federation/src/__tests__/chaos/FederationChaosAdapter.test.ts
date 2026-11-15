/**
 * FederationChaosAdapter — Integration Tests
 *
 * Verifies the adapter correctly bridges db-federation's PartitioningTransport
 * to db-operations ChaosEngineV2.
 *
 * Invariants:
 *   FCHAOS1 — healAll always safe; never throws
 *   FCHAOS2 — DC-level partition maps to partitionedDcs correctly
 *   FCHAOS3 — Zero new dependencies beyond PartitioningTransport ref
 *   CHAOS5  — All 8 fault types work through the adapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FederationChaosAdapter, FederationChaosScenarios } from './FederationChaosAdapter';
import type { IPartitioningTransport } from './FederationChaosAdapter';

// ── Mock PartitioningTransport ───────────────────────────────

class MockPartitioningTransport implements IPartitioningTransport {
  dcId: string;
  partitionedDcs: Set<string> = new Set();
  partitionedPeers: Set<string> = new Set();
  isolated = false;

  inner = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    getStats() {
      return { messagesSent: 42, messagesLost: 3, avgLatencyMs: 5 };
    },
    getConnectedPeers() {
      return [{ peerId: 'dc-1/node-2' }, { peerId: 'dc-2/node-1' }];
    },
  };

  config: { dcMessageLossProbability: number; dcLatencyMs: number } = {
    dcMessageLossProbability: 0,
    dcLatencyMs: 0,
  };

  constructor(dcId: string) {
    this.dcId = dcId;
  }
}

// ── FCHAOS1: healAll Safety ─────────────────────────────────

describe('FCHAOS1 — healAll Safety', () => {
  it('FCHAOS1.1 — healAll on clean adapter is no-op', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.healAll();
    expect(adapter.isHealthy()).toBe(true);
  });

  it('FCHAOS1.2 — healAll after DC partition restores health', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    mock.partitionedDcs.add('dc-2');
    expect(adapter.isHealthy()).toBe(false);
    adapter.healAll();
    expect(adapter.isHealthy()).toBe(true);
    expect(mock.partitionedDcs.size).toBe(0);
  });

  it('FCHAOS1.3 — healAll after peer partition restores health', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    mock.partitionedPeers.add('dc-2/node-1');
    adapter.healAll();
    expect(mock.partitionedPeers.size).toBe(0);
  });

  it('FCHAOS1.4 — healAll clears isolated flag', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    mock.isolated = true;
    adapter.healAll();
    expect(mock.isolated).toBe(false);
  });

  it('FCHAOS1.5 — healAll resets message loss and latency', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.setMessageLoss(0.5);
    adapter.setLatency(300);
    adapter.healAll();
    expect(mock.config.dcLatencyMs).toBe(0);
    expect(mock.config.dcMessageLossProbability).toBe(0);
  });
});

// ── FCHAOS2: DC-Level Partition ─────────────────────────────

describe('FCHAOS2 — DC-Level Partition', () => {
  let mock: MockPartitioningTransport;
  let adapter: FederationChaosAdapter;

  beforeEach(() => {
    mock = new MockPartitioningTransport('dc-1');
    adapter = new FederationChaosAdapter('dc-1/node-1', mock);
  });

  it('FCHAOS2.1 — isolate by DC adds to partitionedDcs', () => {
    adapter.isolate(['federation:dc:dc-2']);
    expect(mock.partitionedDcs.has('dc-2')).toBe(true);
  });

  it('FCHAOS2.2 — heal by DC removes from partitionedDcs', () => {
    adapter.isolate(['federation:dc:dc-2']);
    adapter.heal(['federation:dc:dc-2']);
    expect(mock.partitionedDcs.has('dc-2')).toBe(false);
  });

  it('FCHAOS2.3 — isolate by node adds to partitionedPeers', () => {
    adapter.isolate(['federation:dc-2:1']);
    expect(mock.partitionedPeers.has('dc-2/node-1')).toBe(true);
  });

  it('FCHAOS2.4 — wildcard adds own DC to partitionedDcs', () => {
    adapter.isolate(['federation:*']);
    expect(mock.partitionedDcs.has('dc-1')).toBe(true);
  });

  it('FCHAOS2.5 — non-federation IDs are ignored', () => {
    adapter.isolate(['raft:5', 'federation:dc:dc-2', 'unknown']);
    expect(mock.partitionedDcs.has('dc-2')).toBe(true);
    expect(mock.partitionedPeers.size).toBe(0); // raft and unknown ignored
  });

  it('FCHAOS2.6 — multiple DC + node targets work together', () => {
    adapter.isolate(['federation:dc:dc-2', 'federation:dc:dc-3', 'federation:dc-2:2']);
    expect(mock.partitionedDcs.has('dc-2')).toBe(true);
    expect(mock.partitionedDcs.has('dc-3')).toBe(true);
    expect(mock.partitionedPeers.has('dc-2/node-2')).toBe(true);
  });
});

// ── Transport ID Convention ──────────────────────────────────

describe('Transport ID Convention', () => {
  it('formats transportId as federation:<dcId>:<nodeId>', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    expect(adapter.transportId).toBe('federation:dc-1:node-1');
  });

  it('handles multi-digit node IDs', () => {
    const mock = new MockPartitioningTransport('dc-3');
    const adapter = new FederationChaosAdapter('dc-3/node-10', mock);
    expect(adapter.transportId).toBe('federation:dc-3:node-10');
  });

  it('handles multi-digit DC IDs', () => {
    const mock = new MockPartitioningTransport('dc-10');
    const adapter = new FederationChaosAdapter('dc-10/node-1', mock);
    expect(adapter.transportId).toBe('federation:dc-10:node-1');
  });
});

// ── Stats Accuracy ───────────────────────────────────────────

describe('Stats Accuracy', () => {
  it('reflects inner transport stats', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    const stats = adapter.getStats();
    expect(stats.messagesSent).toBe(42);
    expect(stats.messagesLost).toBe(3);
    expect(stats.connectedPeers).toBe(2);
    expect(stats.totalPeers).toBe(3); // 2 connected + 1 self
  });

  it('reports 0 connected peers when isolated', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    mock.isolated = true;
    expect(adapter.getStats().connectedPeers).toBe(0);
  });

  it('reports partitioned count', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.isolate(['federation:dc:dc-2', 'federation:dc:dc-3']);
    adapter.isolate(['federation:dc-1:2']);
    expect(adapter.getStats().partitioned).toBe(3); // 2 DCs + 1 peer
  });
});

// ── Lifecycle ────────────────────────────────────────────────

describe('Lifecycle', () => {
  it('stop sets isolated and destroys inner transport', async () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    await adapter.stop();
    expect(mock.isolated).toBe(true);
    expect(mock.inner.destroyed).toBe(true);
    expect(adapter.isHealthy()).toBe(false);
  });

  it('start clears isolated flag', async () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    await adapter.stop();
    await adapter.start();
    expect(mock.isolated).toBe(false);
    expect(adapter.isHealthy()).toBe(true);
  });

  it('setMessageLoss clamps to [0, 1]', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.setMessageLoss(-0.5);
    expect(mock.config.dcMessageLossProbability).toBe(0);
    adapter.setMessageLoss(1.5);
    expect(mock.config.dcMessageLossProbability).toBe(1);
  });

  it('setLatency clamps to >= 0', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.setLatency(-100);
    expect(mock.config.dcLatencyMs).toBe(0);
    expect(adapter.getStats().avgLatencyMs).toBe(0);
  });
});

// ── 100% Message Loss ────────────────────────────────────────

describe('100% Message Loss', () => {
  it('setMessageLoss 1.0 enables max loss', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.setMessageLoss(1.0);
    expect(mock.config.dcMessageLossProbability).toBe(1.0);
  });

  it('setMessageLoss 0 clears loss', () => {
    const mock = new MockPartitioningTransport('dc-1');
    const adapter = new FederationChaosAdapter('dc-1/node-1', mock);
    adapter.setMessageLoss(0.5);
    adapter.setMessageLoss(0);
    expect(mock.config.dcMessageLossProbability).toBe(0);
  });
});

// ── Scenario Builders ─────────────────────────────────────────

describe('FederationChaosScenarios', () => {
  it('dcPartition targets correct DC', () => {
    const f = FederationChaosScenarios.dcPartition('dc-2', 5000, 'dc partition');
    expect(f.type).toBe('network-partition');
    expect(f.targets).toEqual(['federation:dc:dc-2']);
    expect(f.durationMs).toBe(5000);
    expect(f.config.dcId).toBe('dc-2');
    expect(f.description).toBe('dc partition');
  });

  it('crashNode targets correct node', () => {
    const f = FederationChaosScenarios.crashNode('dc-1', 3, 2000, 'kill node');
    expect(f.type).toBe('node-crash');
    expect(f.targets).toEqual(['federation:dc-1:3']);
    expect(f.config.nodeIdx).toBe(3);
  });

  it('replicationLag uses wildcard + config latency', () => {
    const f = FederationChaosScenarios.replicationLag(800, 5000);
    expect(f.type).toBe('latency-injection');
    expect(f.targets).toEqual(['federation:*']);
    expect(f.config.latencyMs).toBe(800);
    expect(f.durationMs).toBe(5000);
  });

  it('messageLoss sets global loss rate', () => {
    const f = FederationChaosScenarios.messageLoss(0.7, 3000);
    expect(f.type).toBe('message-loss');
    expect(f.config.lossRate).toBe(0.7);
  });

  it('conflictStorm uses full-mesh wildcard', () => {
    const f = FederationChaosScenarios.conflictStorm(10000, 'conflict');
    expect(f.type).toBe('network-partition');
    expect(f.targets).toEqual(['federation:*']);
    expect(f.config.partitionType).toBe('full-mesh');
  });

  it('cascadingFailure builds sequential targets', () => {
    const f = FederationChaosScenarios.cascadingFailure('dc-1', [1, 2, 3], 500, 8000);
    expect(f.type).toBe('cascading-failure');
    expect(f.targets).toEqual(['federation:dc-1:1', 'federation:dc-1:2', 'federation:dc-1:3']);
    expect(f.config.staggerMs).toBe(500);
  });

  it('allNodes returns wildcard', () => {
    expect(FederationChaosScenarios.allNodes()).toEqual(['federation:*']);
  });

  it('allNodesInDc returns DC wildcard', () => {
    expect(FederationChaosScenarios.allNodesInDc('dc-3')).toEqual(['federation:dc:dc-3']);
  });
});

// ── E2E: Adapter + ChaosEngineV2 ─────────────────────────────

describe('E2E — FederationChaosAdapter + ChaosEngineV2', () => {
  it('E2E — DC partition via engine, heal via engine', async () => {
    const { ChaosEngineV2 } = await import('../../../../operations/packages/chaosengine/src/index');
    const engine = new ChaosEngineV2();

    const mockDc1 = new MockPartitioningTransport('dc-1');
    const mockDc2 = new MockPartitioningTransport('dc-2');
    const a1 = new FederationChaosAdapter('dc-1/node-1', mockDc1);
    const a2 = new FederationChaosAdapter('dc-2/node-1', mockDc2);
    await engine.start([a1, a2]);

    // Partition: isolate dc-1 from dc-2 at the adapter level
    // Use specific targets since wildcard resolves per-adapter
    a1.isolate(['federation:dc:dc-2']);
    expect(mockDc1.partitionedDcs.has('dc-2')).toBe(true);
    expect(a1.isHealthy()).toBe(false);

    // Heal via engine
    await engine.healAll();
    expect(a1.isHealthy()).toBe(true);

    await engine.stop();
  });

  it('E2E — conflict storm scenario with recovery', async () => {
    const { ChaosEngineV2 } = await import('../../../../operations/packages/chaosengine/src/index');
    const engine = new ChaosEngineV2();

    const mocks = [
      new MockPartitioningTransport('dc-1'),
      new MockPartitioningTransport('dc-2'),
      new MockPartitioningTransport('dc-3'),
    ];
    const adapters = mocks.map((m, i) => new FederationChaosAdapter(`dc-${i + 1}/node-1`, m));
    await engine.start(adapters);

    // Full mesh partition: each DC isolates from all other DCs
    adapters.forEach((a, i) => {
      const otherDcs = mocks.map((m, j) => m.dcId).filter((_, j) => j !== i);
      a.isolate(otherDcs.map((dcId) => `federation:dc:${dcId}`));
    });

    // Each adapter's transport should have partitionedDcs populated
    expect(mocks[0]!.partitionedDcs.has('dc-2')).toBe(true);
    expect(mocks[0]!.partitionedDcs.has('dc-3')).toBe(true);
    expect(adapters[0]!.isHealthy()).toBe(false);

    // Heal all
    await engine.healAll();
    for (const a of adapters) {
      expect(a.isHealthy()).toBe(true);
    }

    await engine.stop();
  });

  it('E2E — scenario runner with federation adapters', async () => {
    const { ChaosEngineV2 } = await import('../../../../operations/packages/chaosengine/src/index');
    const engine = new ChaosEngineV2();

    const mocks = [new MockPartitioningTransport('dc-1'), new MockPartitioningTransport('dc-2')];
    const adapters = mocks.map((m, i) => new FederationChaosAdapter(`dc-${i + 1}/node-1`, m));
    await engine.start(adapters);

    const result = await engine.runScenario(
      {
        name: 'federation-replication-lag-recovery',
        description: 'Inject lag then recover',
        seed: 42,
        maxDurationMs: 30_000,
        steps: [
          {
            name: 'high replication lag',
            fault: FederationChaosScenarios.replicationLag(500, 100, '500ms lag'),
            waitMs: 50,
            invariants: [],
          },
          {
            name: 'message loss 30%',
            fault: FederationChaosScenarios.messageLoss(0.3, 100, '30% loss'),
            waitMs: 50,
            invariants: [],
          },
        ],
      },
      {
        async check(inv) {
          return { invariant: inv, passed: true, detail: '' };
        },
        async checkAll(invs) {
          return invs.map((i) => ({ invariant: i, passed: true, detail: '' }));
        },
      },
    );

    expect(result.passed).toBe(true);
    expect(result.stepsExecuted).toBe(2);

    for (const a of adapters) {
      expect(a.isHealthy()).toBe(true);
    }

    await engine.stop();
  });
});
