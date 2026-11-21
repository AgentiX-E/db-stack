/**
 * Public surface of `@agentix-e/db-node/backup`.
 *
 * What a deployment decides about is here: the engine port a database supplies
 * (`IBackupSource`), the bucket (`IStorageBackend`), the retention rules
 * (`IBackupRetentionPolicy`), and the one manager that moves bytes between them. The
 * artefact format and the chain rules are internals — a caller that had to understand
 * them to take a backup would be reimplementing the manager.
 *
 * `InMemoryBackupManager` and `InMemoryPITRManager` used to be published here. Neither
 * moved a byte: the first recorded `sizeBytes: 1024` after a timer and answered a
 * restore before touching anything, the second returned a recovery point it invented.
 * They are gone rather than deprecated, because a package that ships a simulator under
 * the name "backup" is a package whose documents are about its interfaces.
 */

export type {
  IBackupManager,
  IPITRManager,
  IStorageBackend,
  IBackupSource,
  IBackupRetentionPolicy,
  CreateBackupOptions,
  ListBackupsOptions,
  RestoreOptions,
  SnapshotCapture,
} from './interfaces/index.js';

export { BackupManager, compareLsn, expandDeletions, reason, removeQuietly } from './impl/BackupManager.js';
export type { BackupManagerOptions } from './impl/BackupManager.js';
export { DirectoryBackupSource, DIRECTORY_SOURCE_NAME } from './impl/DirectoryBackupSource.js';
export {
  ARTIFACT_MAGIC,
  ARTIFACT_VERSION,
  MAX_MANIFEST_BYTES,
  assertUnchanged,
  hashFile,
  readDirectoryArtifact,
  safeJoin,
  writeDirectoryArtifact,
} from './impl/backupArtifact.js';
export type { ArtifactEntry, ArtifactManifest, CaptureOutcome, RestoreOutcome } from './impl/backupArtifact.js';
export { InMemoryStorageBackend } from './impl/InMemoryStorageBackend.js';
export { S3StorageBackend } from './impl/S3StorageBackend.js';
export type { S3StorageBackendConfig } from './impl/S3StorageBackend.js';
export { RetentionPolicyEvaluator, parseDurationToMs } from './impl/RetentionPolicyEvaluator.js';
export type { RetentionOutcome } from './impl/RetentionPolicyEvaluator.js';
export { dependentsOf, newestCompletedSnapshot, unrestorableReason } from './impl/backupChain.js';
export { BackupVerifier } from './impl/BackupVerifier.js';
export type { VerifyOptions, VerifyResult } from './impl/BackupVerifier.js';
