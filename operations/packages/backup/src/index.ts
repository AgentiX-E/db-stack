export type {
  IBackupManager,
  IPITRManager,
  IStorageBackend,
  IBackupRetentionPolicy,
  CreateBackupOptions,
  ListBackupsOptions,
  RestoreOptions,
} from './interfaces/index.js';

export { InMemoryBackupManager } from './impl/InMemoryBackupManager.js';
export { InMemoryPITRManager } from './impl/InMemoryPITRManager.js';
export { InMemoryStorageBackend } from './impl/InMemoryStorageBackend.js';
export { S3StorageBackend } from './impl/S3StorageBackend.js';
export type { S3StorageBackendConfig } from './impl/S3StorageBackend.js';
export { RetentionPolicyEvaluator, parseDurationToMs } from './impl/RetentionPolicyEvaluator.js';
export type { RetentionOutcome } from './impl/RetentionPolicyEvaluator.js';
export { dependentsOf, newestCompletedSnapshot, unrestorableReason } from './impl/backupChain.js';
export { BackupVerifier } from './impl/BackupVerifier.js';
export type { VerifyOptions, VerifyResult } from './impl/BackupVerifier.js';
