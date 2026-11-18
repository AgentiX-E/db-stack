/**
 * @agentix-e/db-cluster/testing — harnesses for exercising a real cluster.
 *
 * These are shipped (not test-only) because downstream packages — most
 * notably @agentix-e/db-federation — need to spin up an actual Raft cluster
 * to verify cross-cluster behaviour without vendoring cluster internals.
 */

export { TestCluster } from './TestCluster';
export type { TestClusterOptions, TestNode, LeaderAgreement, LeaderAgreementOptions } from './TestCluster';
export { pollUntil, awaitAgreement, ConvergenceTimeoutError, DEFAULT_POLL_INTERVAL_MS } from './convergence';
export type { AgreementOptions, ConvergenceFailure, ConvergeOptions, ConvergeResult } from './convergence';
export { PartitionTransport } from './partition';
export type { PartitionStats } from './partition';
export { generateClusterCerts } from './test-certs';
export type { CertBundle, TestClusterCerts } from './test-certs';
export { getFreePort, getFreePorts, createTempDir, cleanupTempDir } from './test-utils';
export { LinearizabilityChecker, OperationRecorder, fuzzyCheck } from './LinearizabilityChecker';
export type {
  CallEvent,
  ReturnEvent,
  Event,
  Operation,
  RegisterState,
  FuzzyCheckResult,
} from './LinearizabilityChecker';

export { runEngineConformance } from './engine-conformance';
export type { ConformanceFramework, EngineConformanceOptions, KeyValueConformanceCodec } from './engine-conformance';
