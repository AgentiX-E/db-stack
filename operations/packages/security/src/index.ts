export type {
  ITLSManager,
  ICertMonitor,
  IEncryptionManager,
  IRBACProvider,
  IRateLimiter,
  ISCIMSyncProvider,
  ISecurityCompliance,
  TLSConfig,
  EncryptionConfig,
  Permission,
  Role,
  Identity,
  RateLimitConfig,
} from './interfaces/index.js';

export { InMemoryTLSManager } from './impl/InMemoryTLSManager.js';
export { InMemoryCertMonitor } from './impl/InMemoryCertMonitor.js';
export { InMemoryEncryptionManager } from './impl/InMemoryEncryptionManager.js';
export { InMemoryRBACProvider } from './impl/InMemoryRBACProvider.js';
export { InMemoryRateLimiter } from './impl/InMemoryRateLimiter.js';
export { InMemorySCIMSyncProvider } from './impl/InMemorySCIMSyncProvider.js';
export { InMemorySecurityCompliance } from './impl/InMemorySecurityCompliance.js';

// ── Production implementations ───────────────────────────────
//
// The in-memory providers above are fixtures; these are the ones a deployment
// runs, and until iteration 32 none of them was reachable from the package. The
// user guide imported `KeyManager`, `EnvelopeEncryptionProvider` and
// `KeyRotationManager` from this entry point and the imports resolved to
// nothing: every documented snippet in section 3.4 was unusable, and no test
// noticed because the suites import the implementation files directly.
//
// `AC 79` now walks the guide's import list and fails if any name is missing.

export {
  KeyManager,
  MAX_CACHED_KEKS,
  MAX_DERIVATION_ITERATIONS,
  MAX_SALT_BYTES,
  MIN_SALT_BYTES,
} from './impl/KeyManager.js';
export type { KeyManagerConfig, WrappedKey, KeyPair } from './impl/KeyManager.js';
export { AES256GCMEncryptionProvider } from './impl/AES256GCMEncryptionProvider.js';
export { EnvelopeEncryptionProvider } from './impl/EnvelopeEncryptionProvider.js';
export type { EnvelopeEncryptionConfig } from './impl/EnvelopeEncryptionProvider.js';
export { KeyRotationManager } from './impl/KeyRotationManager.js';
export type { KeyRotationOptions } from './impl/KeyRotationManager.js';
export { RotationAuditor } from './impl/RotationAuditor.js';
export type { AuditEntry, AuditVerificationResult, ComplianceReport } from './impl/RotationAuditor.js';
export { AuditLogManager } from './impl/AuditLogManager.js';
export { RBACEngine } from './impl/RBACEngine.js';

// The three interfaces behind those classes were reachable only as return types:
// `getState()`, `query()`, `checkPermission()` handed a consumer an object whose
// type it could not import. These are the names those signatures use.
export type {
  KeyRotationPolicy,
  RotationTrigger,
  RotationPriority,
  RotationEvent,
  KeyRotationState,
  RotationStats,
  ReEncryptionOutcome,
  ReEncryptionResult,
} from './interfaces/IKeyRotationManager.js';
export type {
  AuditEvent,
  AuditCategory,
  AuditSeverity,
  AuditQuery,
  AuditStats,
  AuditIntegrityResult,
  AuditRetentionAnchor,
} from './interfaces/IAuditLogger.js';
export type {
  RBACRole,
  RBACPermission,
  RBACIdentity,
  RBACEvaluationContext,
  RBACDecision,
  RBACConstraint,
  ConstraintType,
  RBACStats,
} from './interfaces/IRBACEngine.js';
