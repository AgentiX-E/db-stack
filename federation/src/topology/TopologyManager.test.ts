/**
 * TopologyManager Tests
 *
 * Coverage:
 *   - Basic accessors (peers, DC groupings)
 *   - Backoff calculation by topology type
 *   - Partition-to-region assignments
 *   - replaceAll with add/remove/change detection
 *   - Event emission on topology changes
 *   - Edge cases (empty topology, self-exclusion)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TopologyManager, type TopologyConfig } from './TopologyManager';
import type { ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';

function makePeer(
  nodeId: string,
  dc: string,
  topology: ReplicationTarget['topology'] = 'cross-dc',
  backoffSeconds = 60,
): ReplicationTarget {
  return {
    nodeId,
    dc,
    address: `tcp://${nodeId}:7000`,
    topology,
    maxBackoffSeconds: backoffSeconds,
  };
}

function defaultConfig(): TopologyConfig {
  return {
    nodeId: 'node-a',
    dc: 'dc-east',
    peers: [
      makePeer('node-a', 'dc-east', 'intra-dc', 3), // self
      makePeer('node-b', 'dc-east', 'intra-dc', 3),
      makePeer('node-c', 'dc-west', 'cross-dc', 60),
      makePeer('node-d', 'dc-west', 'cross-dc', 60),
      makePeer('node-e', 'edge-site', 'edge', 300),
    ],
  };
}

describe('TopologyManager — Accessors', () => {
  it('should identify local node and DC', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getLocalNodeId()).toBe('node-a');
    expect(tm.getLocalDc()).toBe('dc-east');
  });

  it('should return all non-self peers', () => {
    const tm = new TopologyManager(defaultConfig());
    const peers = tm.getAllPeers();
    expect(peers).toHaveLength(4);
    for (const p of peers) {
      expect(p.nodeId).not.toBe('node-a');
    }
  });

  it('should get a specific peer by nodeId', () => {
    const tm = new TopologyManager(defaultConfig());
    const peer = tm.getPeer('node-c');
    expect(peer).toBeDefined();
    expect(peer!.dc).toBe('dc-west');
  });

  it('should return undefined for unknown peer', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getPeer('unknown')).toBeUndefined();
  });
});

describe('TopologyManager — DC Grouping', () => {
  it('should return intra-DC peers (excluding self)', () => {
    const tm = new TopologyManager(defaultConfig());
    const intra = tm.getIntraDcPeers();
    expect(intra).toHaveLength(1); // only node-b is in dc-east besides self
    expect(intra[0].nodeId).toBe('node-b');
  });

  it('should return cross-DC peers', () => {
    const tm = new TopologyManager(defaultConfig());
    const cross = tm.getCrossDcPeers();
    expect(cross).toHaveLength(3); // node-c, node-d (dc-west), node-e (edge-site) — all not in dc-east
    expect(cross.map((p) => p.nodeId).sort()).toEqual(['node-c', 'node-d', 'node-e']);
  });

  it('should return edge peers', () => {
    const tm = new TopologyManager(defaultConfig());
    const edge = tm.getEdgePeers();
    expect(edge).toHaveLength(1);
    expect(edge[0].nodeId).toBe('node-e');
  });

  it('should get peers in a specific DC', () => {
    const tm = new TopologyManager(defaultConfig());
    const west = tm.getPeersInDc('dc-west');
    expect(west).toHaveLength(2);
    expect(west.map((p) => p.nodeId).sort()).toEqual(['node-c', 'node-d']);
  });

  it('should return empty for unknown DC', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getPeersInDc('nonexistent')).toHaveLength(0);
  });
});

describe('TopologyManager — Backoff Calculation', () => {
  it('should return intra-DC backoff (3s)', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getBackoffMs('node-b')).toBe(3000);
  });

  it('should return cross-DC backoff (60s)', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getBackoffMs('node-c')).toBe(60000);
  });

  it('should return edge backoff (300s)', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getBackoffMs('node-e')).toBe(300000);
  });

  it('should return default 60s for unknown peer', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getBackoffMs('unknown')).toBe(60000); // default
  });

  it('should detect intra-DC vs cross-DC', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.isIntraDc('node-b')).toBe(true);
    expect(tm.isIntraDc('node-c')).toBe(false);
    expect(tm.isIntraDc('node-e')).toBe(false);
  });
});

describe('TopologyManager — Partition Regions', () => {
  it('should return partition region assignment', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east')],
      partitionRegions: {
        'shard-0': 'dc-east',
        'shard-1': 'dc-west',
      },
    });
    expect(tm.getPartitionRegion('shard-0')).toBe('dc-east');
    expect(tm.getPartitionRegion('shard-1')).toBe('dc-west');
  });

  it('should return undefined for unassigned partitions', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east')],
    });
    expect(tm.getPartitionRegion('shard-unknown')).toBeUndefined();
  });
});

describe('TopologyManager — replaceAll Mutation', () => {
  it('should emit peer-added for new peers', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east')],
    });

    const events: string[] = [];
    tm.on('change', (evt) => events.push(`${evt.type}:${evt.peer.nodeId}`));

    tm.replaceAll([
      makePeer('node-a', 'dc-east', 'intra-dc', 3),
      makePeer('node-b', 'dc-east', 'intra-dc', 3),
      makePeer('node-c', 'dc-west', 'cross-dc', 60),
    ]);

    expect(events).toContain('peer-added:node-c');
  });

  it('should emit peer-removed for removed peers', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east'), makePeer('node-c', 'dc-west')],
    });

    const events: string[] = [];
    tm.on('change', (evt) => events.push(`${evt.type}:${evt.peer.nodeId}`));

    tm.replaceAll([makePeer('node-a', 'dc-east', 'intra-dc', 3), makePeer('node-b', 'dc-east', 'intra-dc', 3)]);

    expect(events).toContain('peer-removed:node-c');
  });

  it('should emit peer-changed when peer metadata changes', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east', 'intra-dc', 3)],
    });

    const events: string[] = [];
    tm.on('change', (evt) => events.push(`${evt.type}:${evt.peer.nodeId}`));

    tm.replaceAll([
      makePeer('node-a', 'dc-east', 'intra-dc', 3),
      {
        ...makePeer('node-b', 'dc-east', 'intra-dc', 3),
        address: 'tcp://new-addr:7000',
      },
    ]);

    expect(events).toContain('peer-changed:node-b');
  });

  it('should not emit events for unchanged peers', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east', 'intra-dc', 3)],
    });

    let eventCount = 0;
    tm.on('change', () => eventCount++);

    // Same peers, no changes
    tm.replaceAll([makePeer('node-a', 'dc-east', 'intra-dc', 3), makePeer('node-b', 'dc-east', 'intra-dc', 3)]);
    expect(eventCount).toBe(0);
  });

  it('should update peer list atomically', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east')],
    });

    // Replace with completely new set
    tm.replaceAll([
      makePeer('node-a', 'dc-east', 'intra-dc', 3),
      makePeer('node-x', 'dc-west', 'cross-dc', 60),
      makePeer('node-y', 'dc-west', 'cross-dc', 60),
    ]);

    const peers = tm.getAllPeers();
    expect(peers).toHaveLength(2);
    expect(peers.find((p) => p.nodeId === 'node-b')).toBeUndefined();
  });
});

describe('TopologyManager — Event Unsubscription', () => {
  it('should not call unsubscribed listener', () => {
    const tm = new TopologyManager({
      nodeId: 'node-a',
      dc: 'dc-east',
      peers: [makePeer('node-b', 'dc-east')],
    });

    let callCount = 0;
    const unsub = tm.on('change', () => callCount++);
    unsub();

    tm.replaceAll([makePeer('node-a', 'dc-east', 'intra-dc', 3), makePeer('node-c', 'dc-west')]);
    expect(callCount).toBe(0);
  });
});

describe('TopologyManager — Edge Cases', () => {
  it('should handle empty peer list', () => {
    const tm = new TopologyManager({
      nodeId: 'solo',
      dc: 'dc-east',
      peers: [],
    });
    expect(tm.getAllPeers()).toHaveLength(0);
    expect(tm.getIntraDcPeers()).toHaveLength(0);
    expect(tm.getCrossDcPeers()).toHaveLength(0);
  });

  it('should handle only self in peer list', () => {
    const tm = new TopologyManager({
      nodeId: 'alone',
      dc: 'dc-east',
      peers: [
        {
          nodeId: 'alone',
          dc: 'dc-east',
          address: '',
          topology: 'intra-dc',
          maxBackoffSeconds: 3,
        },
      ],
    });
    expect(tm.getAllPeers()).toHaveLength(0);
  });

  it('should correctly identify self vs peer', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.isSelf('node-a')).toBe(true);
    expect(tm.isSelf('node-b')).toBe(false);
  });

  it('should return topology type for a peer', () => {
    const tm = new TopologyManager(defaultConfig());
    expect(tm.getTopologyType('node-b')).toBe('intra-dc');
    expect(tm.getTopologyType('node-c')).toBe('cross-dc');
    expect(tm.getTopologyType('node-e')).toBe('edge');
    expect(tm.getTopologyType('unknown')).toBeUndefined();
  });
});
