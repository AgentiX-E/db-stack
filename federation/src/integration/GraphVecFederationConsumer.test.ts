/**
 * GraphVecFederationConsumer Tests — AC 46.6
 *
 * AC 46.6 — GraphVecFederationConsumer integrates with graphvec-db
 *     — Proposes replicated entries via ConsensusProvider
 *     — HLC observation on proposal
 *     — Conflict payload format
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphVecFederationConsumer, type IGraphVecConsensusProvider } from './GraphVecFederationConsumer';
import { HLC } from '../hlc/HLC';

function mockProvider() {
  return {
    propose: vi.fn<(shardId: string, value: string) => Promise<number>>().mockResolvedValue(42),
    isLeader: vi.fn<(shardId: string) => boolean>().mockReturnValue(true),
  };
}

describe('GraphVecFederationConsumer — AC 46.6', () => {
  it('should propose replicated entries to graphvec-db consensus', async () => {
    const provider = mockProvider();
    const hlc = new HLC('graph-node');

    const consumer = new GraphVecFederationConsumer({
      consensusProvider: provider,
      hlc,
      dc: 'dc-west',
      nodeId: 'graph-node',
    });

    await consumer.proposeReplicated({
      key: 'edge:1',
      data: 'graph-data',
      type: 'edge-insert',
      sourceDc: 'dc-east',
      sourceNodeId: 'graph-remote',
      hlcTimestamp: hlc.now(),
    });

    expect(provider.propose).toHaveBeenCalledTimes(1);
    expect(provider.propose).toHaveBeenCalledWith('federation', expect.stringContaining('graph-data'));
  });

  it('should include federation metadata for graphvec-db', async () => {
    const provider = mockProvider();
    const hlc = new HLC('g1');

    const consumer = new GraphVecFederationConsumer({
      consensusProvider: provider,
      hlc,
      dc: 'dc-west',
      nodeId: 'g1',
    });

    const remoteStamp = new HLC('g2', 200n, 1);
    await consumer.proposeReplicated({
      key: 'vertex:1',
      data: 'vertex-data',
      type: 'vertex-insert',
      sourceDc: 'dc-east',
      sourceNodeId: 'g2',
      hlcTimestamp: remoteStamp,
    });

    const payload = JSON.parse(provider.propose.mock.calls[0]![1]);
    expect(payload.__federation).toBe(true);
    expect(payload.sourceDc).toBe('dc-east');
    expect(payload.sourceNodeId).toBe('g2');
    expect(payload.data).toBe('vertex-data');
  });

  it('should observe remote HLC for causal ordering', async () => {
    const provider = mockProvider();
    const hlc = new HLC('graph-local');

    const consumer = new GraphVecFederationConsumer({
      consensusProvider: provider,
      hlc,
      dc: 'dc-west',
      nodeId: 'graph-local',
    });

    const remoteHlc = new HLC('graph-remote', 9999n, 5);

    await consumer.proposeReplicated({
      key: 'vertex:2',
      data: 'causal-test',
      type: 'test',
      sourceDc: 'dc-east',
      sourceNodeId: 'graph-remote',
      hlcTimestamp: remoteHlc,
    });

    const post = hlc.now();
    expect(post.wallTime).toBeGreaterThanOrEqual(remoteHlc.wallTime);
  });

  it('should handle conflict notification', async () => {
    const provider = mockProvider();
    const hlc = new HLC('graph');

    const consumer = new GraphVecFederationConsumer({
      consensusProvider: provider,
      hlc,
      dc: 'dc-west',
      nodeId: 'graph',
    });

    await consumer.onConflict({
      key: 'edge:123',
      localValue: 'weight:5',
      remoteValue: 'weight:10',
      localHlc: new HLC('graph', 100n, 1),
      remoteHlc: new HLC('remote', 200n, 1),
      sourceDc: 'dc-east',
    });

    expect(provider.propose).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(provider.propose.mock.calls[0]![1]);
    expect(payload.__federation).toBe(true);
    expect(payload.__conflict).toBe(true);
    expect(payload.key).toBe('edge:123');
  });

  it('should provide HLC access', () => {
    const hlc = new HLC('graph-node');
    const consumer = new GraphVecFederationConsumer({
      consensusProvider: mockProvider(),
      hlc,
      dc: 'dc-west',
      nodeId: 'graph-node',
    });

    expect(consumer.getHLC()).toBe(hlc);
  });
});
