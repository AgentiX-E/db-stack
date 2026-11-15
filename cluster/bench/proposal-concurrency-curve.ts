/**
 * Proposal concurrency curve — throughput versus in-flight proposals.
 *
 * Why this exists
 * ---------------
 * `raft-throughput-bench.test.ts` asserts "batched (concurrent) proposals reach at
 * least 50 % of sequential throughput" and, measured on a real cluster, they reach
 * about 35 %: 50 in flight ran at 378 ops/s against 1 086 ops/s one at a time. That
 * criterion is either a wrong expectation or a real serialisation defect, and the
 * only way to tell them apart is to see the whole curve — including where it turns.
 *
 * Run: pnpm --filter @agentix-e/db-cluster run bench:concurrency
 */

import { TestCluster } from '../src/testing/TestCluster.js';
import { measureLatency, ms } from '../src/testing/latency.js';

const CONCURRENCY = [1, 2, 4, 8, 16, 32, 50];
const BATCH = 50;

async function main(): Promise<void> {
  const cluster = new TestCluster({
    nodeCount: 3,
    electionTick: 15,
    heartbeatTick: 3,
    tickIntervalMs: 50,
    leaderTimeoutMs: 30_000,
    pollIntervalMs: 25,
  });

  const rows: { concurrency: number; opsPerSec: number; p50: number; p99: number }[] = [];

  try {
    await cluster.start();
    const leader = await cluster.findLeader();

    // Warmup outside the measurement: connection setup, JIT, first applies.
    for (let i = 0; i < 30; i++) {
      await leader.adapter.proposeAndWait(`warmup-${i}`);
    }

    for (const concurrency of CONCURRENCY) {
      const result = await measureLatency({
        warmup: 0,
        samples: BATCH,
        run: async (i) => {
          // Each "sample" fires one wave: `concurrency` proposals in flight, awaited
          // together. The wave's cost is divided by its width below.
          await Promise.all(
            Array.from({ length: concurrency }, (_, k) => leader.adapter.propose(`c${concurrency}-${i}-${k}`)),
          );
        },
      });

      const totalNs = result.elapsed.reduce((sum, value) => sum + value, 0);
      const opsPerSec = totalNs > 0 ? (BATCH * concurrency) / totalNs * 1e9 : 0;
      rows.push({
        concurrency,
        opsPerSec: Math.round(opsPerSec),
        p50: ms(result.summary.p50),
        p99: ms(result.summary.p99),
      });
    }
  } finally {
    await cluster.stop();
  }

  const header = ['in flight', 'ops/sec', 'wave p50 ms', 'wave p99 ms'];
  process.stdout.write(`\n| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|\n`);
  for (const row of rows) {
    process.stdout.write(`| ${row.concurrency} | ${row.opsPerSec} | ${row.p50} | ${row.p99} |\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
