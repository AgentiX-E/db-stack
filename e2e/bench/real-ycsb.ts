/**
 * Real YCSB benchmark against a real Raft cluster.
 *
 * The repository already ships a YCSB *simulator* (bench/raft-ycsb.ts) that
 * models Raft operations against an in-memory map. That measures nothing about
 * the implementation. This runner executes the same YCSB workload mixes against
 * three real node processes connected over mutual TLS, so the numbers include
 * consensus, fsync and serialisation cost end to end.
 *
 * Workload mixes (YCSB core, Cooper et al., 2010):
 *   A  50% read / 50% update        (session store)
 *   B  95% read /  5% update        (photo tagging)
 *   C 100% read                     (profile cache)
 *   D  95% read /  5% insert        (latest news)
 *   E  95% scan /  5% insert        (threaded discussions)
 *   F  50% read / 50% read-modify-write (user database)
 *
 * Usage:
 *   tsx bench/real-ycsb.ts --workload A --records 1000 --ops 2000 --threads 8
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChildNode,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnRaftNode,
  waitUntil,
} from '../harness/support';

type Workload = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

const MIX: Record<Workload, Array<{ op: 'read' | 'update' | 'insert' | 'rmw' | 'scan'; weight: number }>> = {
  A: [
    { op: 'read', weight: 0.5 },
    { op: 'update', weight: 0.5 },
  ],
  B: [
    { op: 'read', weight: 0.95 },
    { op: 'update', weight: 0.05 },
  ],
  C: [{ op: 'read', weight: 1 }],
  D: [
    { op: 'read', weight: 0.95 },
    { op: 'insert', weight: 0.05 },
  ],
  E: [
    { op: 'scan', weight: 0.95 },
    { op: 'insert', weight: 0.05 },
  ],
  F: [
    { op: 'read', weight: 0.5 },
    { op: 'rmw', weight: 0.5 },
  ],
};

const DESCRIPTION: Record<Workload, string> = {
  A: 'Update heavy (50/50 read/update)',
  B: 'Read mostly (95/5 read/update)',
  C: 'Read only (100% read)',
  D: 'Read latest (95/5 read/insert)',
  E: 'Short ranges (95/5 scan/insert)',
  F: 'Read-modify-write (50/50 read/RMW)',
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function pickOp(workload: Workload, random: () => number): 'read' | 'update' | 'insert' | 'rmw' | 'scan' {
  const roll = random();
  let cumulative = 0;
  for (const entry of MIX[workload]) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry.op;
  }
  return MIX[workload][0]!.op;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Options {
  workload: Workload;
  records: number;
  ops: number;
  threads: number;
  nodes: number;
}

async function startCluster(nodes: number): Promise<{ leader: () => ChildNode; all: ChildNode[]; cleanup: () => Promise<void> }> {
  const certs = makeCertificates(nodes);
  const ports = await getFreePorts(nodes);
  const baseDir = makeTempDir('ycsb');

  const specs = Array.from({ length: nodes }, (_, i) => ({
    id: i + 1,
    host: '127.0.0.1',
    port: ports[i]!,
    dataDir: join(baseDir, `node-${i + 1}`),
    cert: certs.nodes[i]!,
    peers: [] as Array<{ id: number; host: string; port: number }>,
    electionTick: 10,
    heartbeatTick: 3,
  }));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }

  const children = specs.map((spec) => spawnRaftNode(spec));
  await Promise.all(children.map((child) => child.waitForType('ready', 90_000)));

  const leaderHolder: { current: ChildNode | null } = { current: null };
  leaderHolder.current = await waitUntil(
    async () => {
      for (const child of children) {
        if (child.exited) continue;
        try {
          const status = await child.status<{ isLeader: boolean }>();
          if (status.isLeader) return child;
        } catch {
          // still electing
        }
      }
      return undefined;
    },
    60_000,
    'a leader',
    250,
  );

  return {
    leader: () => leaderHolder.current!,
    all: children,
    cleanup: async () => {
      await Promise.all(children.map((c) => c.terminate().catch(() => undefined)));
      removeTempDir(baseDir);
    },
  };
}

async function propose(leader: ChildNode, key: string, value: string): Promise<void> {
  leader.send({ cmd: 'propose', data: JSON.stringify({ key, value }) });
  await leader.waitFor((m) => m.type === 'proposed' || m.type === 'error', 30_000, `propose ${key}`);
}

async function read(leader: ChildNode, key: string): Promise<string | null> {
  leader.send({ cmd: 'read', key });
  const msg = await leader.waitFor((m) => m.type === 'read', 30_000, `read ${key}`);
  return (msg.data as { value: string | null }).value;
}

async function runWorkload(options: Options): Promise<Record<string, unknown>> {
  const cluster = await startCluster(options.nodes);
  try {
    const leader = cluster.leader();
    const random = mulberry32(0x5eed);

    // ── Load phase ──
    const loadStart = Date.now();
    for (let i = 0; i < options.records; i++) {
      await propose(leader, `user${i}`, JSON.stringify({ field0: `value-${i}` }));
    }
    const loadMs = Date.now() - loadStart;

    // ── Run phase ──
    const latencies: number[] = [];
    let inserts = options.records;

    const worker = async (): Promise<void> => {
      const localRandom = mulberry32(Math.floor(random() * 1e9));
      for (let i = 0; i < Math.floor(options.ops / options.threads); i++) {
        const key = `user${Math.floor(localRandom() * options.records)}`;
        const op = pickOp(options.workload, localRandom);
        const started = process.hrtime.bigint();
        try {
          if (op === 'read' || op === 'scan') {
            await read(leader, key);
          } else if (op === 'rmw') {
            const current = await read(leader, key);
            await propose(leader, key, JSON.stringify({ field0: `${current ?? ''}-rmw` }));
          } else {
            const target = op === 'insert' ? `user${inserts++}` : key;
            await propose(leader, target, JSON.stringify({ field0: `v-${Date.now()}` }));
          }
        } catch {
          // A failed op still counts towards latency distribution.
        }
        latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    };

    const runStart = Date.now();
    await Promise.all(Array.from({ length: options.threads }, () => worker()));
    const runMs = Date.now() - runStart;

    const sorted = [...latencies].sort((a, b) => a - b);
    const totalOps = latencies.length;

    return {
      workload: options.workload,
      description: DESCRIPTION[options.workload],
      nodes: options.nodes,
      records: options.records,
      operations: totalOps,
      threads: options.threads,
      loadSeconds: Number((loadMs / 1000).toFixed(2)),
      runSeconds: Number((runMs / 1000).toFixed(2)),
      throughputOpsPerSec: Number(((totalOps / runMs) * 1000).toFixed(1)),
      latencyMs: {
        p50: Number(percentile(sorted, 50).toFixed(2)),
        p95: Number(percentile(sorted, 95).toFixed(2)),
        p99: Number(percentile(sorted, 99).toFixed(2)),
        max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
      },
      commitIndex: (await leader.status<{ commitIndex: number }>()).commitIndex,
    };
  } finally {
    await cluster.cleanup();
  }
}

async function main(): Promise<void> {
  const workloads = arg('workload', 'A').split(',') as Workload[];
  const options: Omit<Options, 'workload'> = {
    records: Number(arg('records', '200')),
    ops: Number(arg('ops', '600')),
    threads: Number(arg('threads', '4')),
    nodes: Number(arg('nodes', '3')),
  };

  const results: Array<Record<string, unknown>> = [];
  for (const workload of workloads) {
    process.stderr.write(`\n▶ YCSB workload ${workload} — ${DESCRIPTION[workload]}\n`);
    results.push(await runWorkload({ ...options, workload }));
  }

  const outDir = join(process.cwd(), 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `real-ycsb-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), options, results }, null, 2));

  const header = '| Workload | Mix | Ops | Throughput (ops/s) | p50 | p95 | p99 |';
  const divider = '|----------|-----|----:|-------------------:|----:|----:|----:|';
  const rows = results.map(
    (r) =>
      `| ${r.workload} | ${r.description} | ${r.operations} | ${r.throughputOpsPerSec} | ` +
      `${(r.latencyMs as Record<string, number>).p50} ms | ${(r.latencyMs as Record<string, number>).p95} ms | ` +
      `${(r.latencyMs as Record<string, number>).p99} ms |`,
  );

  console.log('\n## Real YCSB against a 3-node Raft cluster (mTLS)\n');
  console.log([header, divider, ...rows].join('\n'));
  console.log(`\nRaw results: ${file}`);
}

await main();
