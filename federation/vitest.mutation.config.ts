import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the mutation suite.
 *
 * The transport's tests are the ones that can judge a mutant in it: the unit
 * file, the lifecycle file and the TLS fault-injection suite, which is what
 * catches a change that breaks the refusal path rather than the happy path.
 * The delivery file is the fourth: it asserts the wire frame field by field and
 * drives the configuration refusals, which is where the transport's decisions
 * are made rather than reported.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    // The last file is the acknowledged-delivery suite: the confirmation frame is
    // the other half of "did it arrive", so its cases judge the transport's mutant
    // neighbours as well as their own.
    include: [
      'src/transport/TcpSecureTransport.test.ts',
      'src/transport/TcpSecureTransport.lifecycle.test.ts',
      'src/transport/TcpSecureTransport.delivery.test.ts',
      'src/__tests__/chaos/tls-fault-injection.test.ts',
      'src/replication/ExactlyOnceCDCPipeline.ack.test.ts',
      // Two suites for the epoch ledger: the unit file judges the comparisons and
      // the watermark, and the manager file judges what a refusal does to a frame,
      // an apply and a dedup id. Without them every mutant in the ledger is reported
      // with no coverage at all — a decision file scored zero because nothing was
      // asked to judge it, which is the opposite of what a mutation gate is for.
      'src/replication/epoch.test.ts',
      'src/core/FederationManager.epoch.test.ts',
      // The control plane (IT-90). Its decisions are invisible when they are
      // wrong: a heartbeat sequence compared with `>=` reports every interval as a
      // duplicate so the detector never sees a silence, a chunk index compared
      // with `!==` accepts a gap, and a Merkle bucket named from the entries
      // rather than from the key hashes to a tree that agrees with itself. These
      // files are the only ones that can judge those mutants; without them every
      // one of them is reported with no coverage at all.
      'src/replication/AntiEntropy.test.ts',
      'src/replication/AntiEntropy.branches.test.ts',
      'src/replication/antientropyFrames.test.ts',
      'src/replication/bootstrapFrames.test.ts',
      'src/core/heartbeatFrame.test.ts',
      'src/core/AntiEntropyProtocol.test.ts',
      'src/core/HeartbeatProtocol.test.ts',
      'src/core/SnapshotBootstrap.test.ts',
      'src/core/DCSplitBrainDetector.branches.test.ts',
      'src/core/FederationManager.protocols.test.ts',
      // Judges the IT-103 composition-root guard.
      'src/composition/createCDCPipeline.test.ts',
    ],
    exclude: [],
    // Derived from this suite's own measurement (2026-11-18): 90 cases in four
    // files, the slowest a single 2 479 ms (`chaos/tls-fault-injection`, which
    // injects a delay on purpose), the next 5 ms. Four times the worst case is
    // 9 916 ms, rounded up to 10 s and kept below the 30 s runner cap. The base
    // config's 180 s never applied here: Stryker abandons a mutant long before a
    // test timeout that large can fire, so the timeout column would report the
    // runner giving up rather than a test objecting.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
