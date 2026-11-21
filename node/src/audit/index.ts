/**
 * Public surface of `@agentix-e/db-node/audit`.
 *
 * The store's internals — segment naming, archive/twin reconciliation, the
 * per-file durability helpers — are deliberately absent from this file. Nineteen
 * of them were exported for two years, and the only code outside the package that
 * ever imported one was a test in a *different* package: an internal made public
 * so that its own assertions could reach it. Those tests now import
 * `impl/FileAuditStore.js` directly, which is where a test of an internal belongs.
 *
 * What is public is what a deployment can decide about:
 *
 *   - the two stores and the exporter,
 *   - the ports a store is configured with (`FileAuditStoreConfig`), because
 *     putting the trail on a different medium is a deployment decision,
 *   - `DurableFileSystem` and its default implementation, because the three
 *     filesystem steps that make a line survive are the only part of
 *     "crash-safe" that a caller can supply, replace or observe.
 */

export type {
  IAuditStore,
  IAuditExporter,
  WriteAuditEntryOptions,
  AuditQueryFilter,
  ExportOptions,
  AuditChainFailure,
  AuditChainFailureReason,
  AuditTrailVerification,
} from './interfaces/index.js';

export {
  CHAIN_DOMAIN,
  GENESIS_DIGEST,
  canonicalJson,
  chainDigest,
  chainPreimage,
  describeVerification,
  recomputeDigest,
  sealEntry,
  verifyTrail,
} from './impl/auditChain.js';
export type { VerifyTrailOptions } from './impl/auditChain.js';

export { InMemoryAuditStore } from './impl/InMemoryAuditStore.js';
export { JsonAuditExporter } from './impl/JsonAuditExporter.js';

// `nodeFileCalls` is published so that a deployment replacing one syscall does
// not have to reimplement the other five; `isDirectorySyncUnsupported` is
// published so that a custom implementation can classify the same errno the
// default one tolerates, instead of guessing at the difference between "not
// here" and "your data is at risk".
export {
  createNodeDurableFileSystem,
  isDirectorySyncUnsupported,
  nodeDurableFileSystem,
  nodeFileCalls,
} from './impl/DurableFileSystem.js';
export type { DurableFileSystem, NodeFileCalls } from './impl/DurableFileSystem.js';

export { FileAuditStore } from './impl/FileAuditStore.js';
export type { FileAuditStoreConfig } from './impl/FileAuditStore.js';
