/**
 * Raft Throughput & Latency Benchmark
 *
 * Phase 2 — Empirical measurement of Raft proposal throughput and latency
 * under various loads, using a real 3-node in-process mTLS cluster.
 * Uses TestCluster (shared infrastructure) for cluster lifecycle.
 *
 * Scientific Method:
 *   - Real RaftAdapter on actual TCP/mTLS sockets (via TestCluster)
 *   - Each trial: N consecutive proposals, record commit latency per entry
 *   - Statistical reporting: mean, median, P50, P95, P99 latency
 *   - Throughput computed as entries/sec over the test window
 *
 * Acceptance Criteria:
 *   AC 29.6: 100 sequential proposals complete with >0 ops/sec throughput
 *   AC 29.7: Mean commit latency < 100ms for sequential proposals
 *   AC 29.8: 100 concurrent proposals all committed
 *   AC 29.9: Throughput with batching >= 50% of sequential throughput
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from '../integration/TestCluster';

const BENCH_TIMEOUT = 120_000;

describe('Raft Throughput & Latency Benchmark', () => {
  let cluster: TestCluster;

  beforeAll(() => {
    cluster = new TestCluster({
      nodeCount: 3,
      electionTick: 15,
      heartbeatTick: 3,
      tickIntervalMs: 50,
      leaderTimeoutMs: 30_000,
      pollIntervalMs: 200,
    });
  });

  afterAll(async () => {
    await cluster.stop();
  });

  //
  // AC 29.6: 100 sequential proposals → throughput > 0
  //
  it(
    'AC 29.6: 100 sequential proposals complete',
    async () => {
      await cluster.start();
      const leader = await cluster.findLeader();
      const latencies: number[] = [];

      for (let i = 0; i < 100; i++) {
        const start = Date.now();
        await leader.adapter.propose(`seq-${i}`);
        latencies.push(Date.now() - start);
      }

      const sorted = [...latencies].sort((a, b) => a - b);
      const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const median = sorted[50];
      const p95 = sorted[94];
      const p99 = sorted[98];
      const totalTime = sorted.reduce((a, b) => a + b, 0);
      const throughput = totalTime > 0 ? (100 / totalTime) * 1000 : 0;

      expect(throughput).toBeGreaterThan(0);
      expect(latencies.length).toBe(100);

      process.stdout.write(
        `\n  [Sequential 100] mean=${Math.round(mean)}ms ` +
          `median=${Math.round(median)}ms P95=${Math.round(p95)}ms ` +
          `P99=${Math.round(p99)}ms throughput=${throughput.toFixed(1)} ops/sec\n`,
      );
    },
    BENCH_TIMEOUT,
  );

  //
  // AC 29.7: Mean latency < 100ms for sequential proposals
  //
  it(
    'AC 29.7: mean commit latency < 100ms',
    async () => {
      await cluster.start();
      const leader = await cluster.findLeader();
      const latencies: number[] = [];

      // Warmup: skip first 10
      for (let i = 0; i < 10; i++) {
        await leader.adapter.propose(`warmup-${i}`);
      }
      for (let i = 0; i < 50; i++) {
        const start = Date.now();
        await leader.adapter.propose(`latency-${i}`);
        latencies.push(Date.now() - start);
      }

      const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      expect(mean).toBeLessThan(100);

      const sorted = [...latencies].sort((a, b) => a - b);
      process.stdout.write(
        `\n  [Latency 50] mean=${Math.round(mean)}ms ` +
          `median=${Math.round(sorted[24])}ms ` +
          `P99=${Math.round(sorted[48])}ms\n`,
      );
    },
    BENCH_TIMEOUT,
  );

  //
  // AC 29.8: 100 concurrent proposals all committed
  //
  it(
    'AC 29.8: 100 concurrent proposals all committed',
    async () => {
      await cluster.start();
      const leader = await cluster.findLeader();

      const proposals = Array.from({ length: 100 }, (_, i) => leader.adapter.propose(`concurrent-${i}`));

      await expect(Promise.all(proposals)).resolves.toHaveLength(100);
      process.stdout.write('\n  [Concurrent 100] all 100 proposals committed\n');
    },
    BENCH_TIMEOUT,
  );

  //
  // AC 29.9: Batched throughput >= 50% of sequential throughput
  //
  it(
    'AC 29.9: batched proposals throughput',
    async () => {
      await cluster.start();
      const leader = await cluster.findLeader();

      // Warmup
      for (let i = 0; i < 10; i++) {
        await leader.adapter.propose(`warmup-${i}`);
      }

      // Sequential baseline
      const seqStart = Date.now();
      for (let i = 0; i < 50; i++) {
        await leader.adapter.propose(`seq-${i}`);
      }
      const seqTime = Date.now() - seqStart;

      // Concurrent batch (simulated batching via parallel proposals)
      const batchStart = Date.now();
      const batch = Array.from({ length: 50 }, (_, i) => leader.adapter.propose(`batch-${i}`));
      await Promise.all(batch);
      const batchTime = Date.now() - batchStart;

      const seqThroughput = seqTime > 0 ? (50 / seqTime) * 1000 : 0;
      const batchThroughput = batchTime > 0 ? (50 / batchTime) * 1000 : 0;

      expect(batchThroughput).toBeGreaterThanOrEqual(seqThroughput * 0.5);

      process.stdout.write(
        `\n  [Throughput] seq=${seqThroughput.toFixed(1)} ops/sec ` +
          `batch=${batchThroughput.toFixed(1)} ops/sec ` +
          `(seq=${seqTime}ms batch=${batchTime}ms)\n`,
      );
    },
    BENCH_TIMEOUT,
  );
});
