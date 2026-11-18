/**
 * Raft node worker process using @maboke123/raft-core.
 *
 * Launched via `tsx` as child_process. Each worker runs a real Raft node with:
 *   - BatchedRaftTransport (TCP + mTLS) or in-memory transport for tests
 *   - SqliteStorage / InMemoryNodeStorage
 *   - RaftAdapter (wrapping @maboke123/raft-core)
 *   - In-memory committed log tracking
 *
 * Communicates via IPC (process.send / process.on('message')).
 * Kill signal handling: SIGTERM → graceful shutdown → process.exit(0)
 *
 * Environment variables:
 *   RAFT_NODE_CONFIG  — JSON with node info + peers + certs + dataDir
 *   RAFT_CLUSTER_CONFIG — JSON with electionTick, heartbeatTick
 *   RAFT_USE_IN_MEMORY — if set, use InMemoryStorage (no SQLite)
 */

// Note: no loader registration here. The parent process spawns this worker
// with `node --import tsx`, which installs the TypeScript loader for this
// process. Calling register('tsx/esm') as well makes tsx believe it was loaded
// through the legacy `--loader` interface and the worker aborts with
// "tsx must be loaded with --import instead of --loader".

const NODE_CFG_RAW = process.env.RAFT_NODE_CONFIG;
const CLUSTER_CFG_RAW = process.env.RAFT_CLUSTER_CONFIG;
const USE_IN_MEMORY = process.env.RAFT_USE_IN_MEMORY === '1';

if (!NODE_CFG_RAW || !CLUSTER_CFG_RAW) {
  process.stderr.write('[raft-core-worker] Missing RAFT_NODE_CONFIG or RAFT_CLUSTER_CONFIG\n');
  process.exit(1);
}

interface PeerConfig {
  id: number;
  host: string;
  port: number;
}

interface NodeConfig {
  id: number;
  host: string;
  port: number;
  dataDir: string;
  peers: PeerConfig[];
  cert: { key: string; cert: string; ca: string };
}

interface ClusterConfig {
  electionTick: number;
  heartbeatTick: number;
}

const nodeConfig: NodeConfig = JSON.parse(NODE_CFG_RAW);
const clusterConfig: ClusterConfig = JSON.parse(CLUSTER_CFG_RAW);

async function main() {
  try {
    const { RaftAdapter } = await import('../../consensus/core/RaftAdapter');
    const { SqliteStorage } = await import('../../consensus/storage/SqliteStorage');
    const { join } = await import('node:path');
    const { existsSync, mkdirSync } = await import('node:fs');

    // ── State ──
    const committedLog: string[] = [];
    let currentLeader: number | null = null;
    let raftAdapter: InstanceType<typeof RaftAdapter>;

    // ── Build RaftAdapter ──
    if (USE_IN_MEMORY) {
      // In-memory mode (fastest, no TLS, no disk)
      raftAdapter = new RaftAdapter({
        id: nodeConfig.id,
        peers: nodeConfig.peers.map((p) => p.id),
        electionTick: clusterConfig.electionTick,
        heartbeatTick: clusterConfig.heartbeatTick,
        tickIntervalMs: 50,
        useInMemoryStorage: true,
        useInMemoryTransport: false, // @maboke123/raft-core uses its own; set up manual transport
        address: `node-${nodeConfig.id}:0`,
        snapshotInterval: 1000,
        preVote: true,
        checkQuorum: true,
        enableInstallSnapshot: false,
      });
    } else {
      // TCP + mTLS mode
      raftAdapter = new RaftAdapter({
        id: nodeConfig.id,
        peers: nodeConfig.peers.map((p) => p.id),
        electionTick: clusterConfig.electionTick,
        heartbeatTick: clusterConfig.heartbeatTick,
        tickIntervalMs: 50,
        storagePath: join(nodeConfig.dataDir, 'raft.db'),
        snapshotInterval: 1000,
        environment: 'development',
        preVote: true,
        checkQuorum: true,
        enableInstallSnapshot: false,
      });
    }

    // ── Initialize RaftAdapter ──
    const applyHandler = (data: string, _index?: number, _term?: number) => {
      committedLog.push(data);
    };

    if (USE_IN_MEMORY) {
      // For in-memory: we use the init without transport params
      // The adapter will use InMemoryNodeStorage
      await raftAdapter.init(applyHandler);
    } else {
      // TCP mode: pass tcpConfig
      await raftAdapter.init(
        applyHandler,
        {
          node: { id: nodeConfig.id, host: nodeConfig.host, port: nodeConfig.port },
          peers: nodeConfig.peers,
          tls: {
            cert: nodeConfig.cert.cert,
            key: nodeConfig.cert.key,
            ca: nodeConfig.cert.ca,
          },
          connectTimeoutMs: 5000,
          initialRetryMs: 100,
          maxRetryMs: 5000,
        },
        undefined,
      );
    }

    // Notify parent: ready
    process.send?.({
      type: 'ready',
      nodeId: nodeConfig.id,
      data: { port: nodeConfig.port },
      timestamp: Date.now(),
    });

    // ── IPC handlers ──
    process.on('message', async (msg: any) => {
      if (!msg || !msg.command) return;
      try {
        switch (msg.command) {
          case 'shutdown':
            raftAdapter.stop();
            process.send?.({ type: 'exited', nodeId: nodeConfig.id, timestamp: Date.now() });
            process.exit(0);
            return;

          case 'propose': {
            const result = await raftAdapter.propose(msg.data);
            process.send?.({
              type: 'log-committed',
              nodeId: nodeConfig.id,
              data: { index: result.index, data: msg.data },
              timestamp: Date.now(),
            });
            return;
          }

          case 'get-status': {
            const isLeader = await raftAdapter.isLeader();
            const leader = await raftAdapter.getLeader();
            const term = await raftAdapter.getTerm();
            const progress = await raftAdapter.getProgress();
            // The leader's per-peer view is the only place a follower that is not
            // being sent anything is visible: from the follower's own side it looks
            // like a healthy node waiting for entries.
            const peers = await raftAdapter.getPeerProgress();

            process.send?.({
              type: 'status',
              nodeId: nodeConfig.id,
              data: {
                isLeader,
                leader,
                term,
                commitIndex: progress.commit,
                applied: progress.applied,
                lastLog: progress.lastLog,
                committedLog: [...committedLog],
                logLength: committedLog.length,
                peers,
              },
              timestamp: Date.now(),
            });
            return;
          }

          default:
            process.stderr.write(`[node-${nodeConfig.id}] Unknown command: ${msg.command}\n`);
        }
      } catch (err: any) {
        const errorData: any = { error: err.message, command: msg.command };
        // If propose was rejected, include the current leader for auto-retry
        if (msg.command === 'propose') {
          try {
            const leaderId = await raftAdapter.getLeader();
            errorData.currentLeader = leaderId;
          } catch {
            // ignore
          }
        }
        process.send?.({
          type: 'error',
          nodeId: nodeConfig.id,
          data: errorData,
          timestamp: Date.now(),
        });
      }
    });

    // ── Leader polling ──
    setInterval(async () => {
      const leader = await raftAdapter.getLeader();
      if (leader !== undefined && leader !== null && leader !== currentLeader) {
        currentLeader = leader;
        process.send?.({
          type: 'leader-elected',
          nodeId: nodeConfig.id,
          data: { leader },
          timestamp: Date.now(),
        });
      }
    }, 300);

    // ── Graceful shutdown on SIGTERM ──
    process.on('SIGTERM', async () => {
      raftAdapter.stop();
      process.send?.({ type: 'exited', nodeId: nodeConfig.id, timestamp: Date.now() });
      process.exit(0);
    });
  } catch (err: any) {
    process.send?.({
      type: 'error',
      nodeId: nodeConfig.id,
      data: { error: err.message, stack: err.stack?.split('\n').slice(0, 10).join('\n') },
      timestamp: Date.now(),
    });
    process.exit(1);
  }
}

main();
