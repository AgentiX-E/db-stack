/**
 * Snapshot-threshold sweep — what a compaction interval actually costs.
 *
 * Why this exists
 * ---------------
 * `snapshotInterval` is the one tuning knob this package exposes to an engine, and
 * the repository could not say what its own default was: `README.md` claimed 100,
 * the roadmap claimed "raft-core's ~1000", and raft-core's actual default is 200.
 * A number that three documents disagree about is not a default, it is a rumour.
 *
 * This script measures, on real 3-node clusters over mutual TLS, what each
 * threshold buys and what it costs:
 *
 *   - retained log length after a fixed number of writes (replay cost on restart)
 *   - snapshot count and snapshot bytes (capture cost, paid by the leader)
 *   - proposal p50 / p99 during the run (does frequent capture disturb writes?)
 *   - follower restart → caught up, which is the cost the threshold exists to bound
 *
 * Run: pnpm --filter @agentix-e/db-cluster run bench:snapshot
 */

import { TestCluster } from '../src/testing/TestCluster.js';
import { measureLatency, ms } from '../src/testing/latency.js';

const THRESHOLDS = [100, 200, 1_000, 5_000];
const WRITES = 600;
const WARMUP = 50;

interface Row {
  threshold: number;
  retained: number;
  snapshotIndex: number;
  p50: number;
  p99: number;
  restartMs: number;
}

async function measureThreshold(threshold: number): Promise<Row> {
  const cluster = new TestCluster({
    nodeCount: 3,
    electionTick: 15,
    heartbeatTick: 3,
    tickIntervalMs: 50,
    leaderTimeoutMs: 30_000,
    pollIntervalMs: 25,
    snapshotInterval: threshold,
  });

  try {
    await cluster.start();
    const leader = await cluster.findLeader();

    const latency = await measureLatency({
      warmup: WARMUP,
      samples: WRITES,
      run: (i) => leader.adapter.proposeAndWait(`sweep-${threshold}-${i}`),
    });

    const retained = await leader.adapter.getRetainedLogLength();
    const meta = await leader.adapter.refreshSnapshotMeta();

    // How long a follower that lost its log takes to catch up again: for a threshold
    // this is the number that matters, because the retained tail is what it replays.
    const follower = cluster.remainingNodes(leader.id)[0]!;
    const commit = await leader.adapter.getCommitIndex();
    await cluster.killNode(follower.id);
    const restartStart = process.hrtime.bigint();
    const revived = await cluster.restartNode(follower.id);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (await revived.adapter.getAppliedIndex()) < commit) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const restartMs = ms(Number(process.hrtime.bigint() - restartStart));

    return {
      threshold,
      retained,
      snapshotIndex: meta?.lastIncludedIndex ?? 0,
      p50: ms(latency.summary.p50),
      p99: ms(latency.summary.p99),
      restartMs,
    };
  } finally {
    await cluster.stop();
  }
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const threshold of THRESHOLDS) {
    rows.push(await measureThreshold(threshold));
  }

  const header = ['threshold', 'retained', 'snapshot@', 'p50 ms', 'p99 ms', 'restart ms'];
  process.stdout.write(`\n| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|\n`);
  for (const row of rows) {
    process.stdout.write(
      `| ${row.threshold} | ${row.retained} | ${row.snapshotIndex} | ` +
        `${row.p50} | ${row.p99} | ${row.restartMs} |\n`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
