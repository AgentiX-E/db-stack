/**
 * security interfaces — Security-focused operation abstractions.
 *
 * Covers: TLS certificate management, encryption, RBAC, rate limiting,
 *         SCIM sync, and security compliance baselines.
 *
 * @module @agentix-e/db-operations-security/interfaces
 */

import type { CertInfo, CertWarningLevel, SecurityCheck } from '@agentix-e/db-operations-core/types';

// ── TLS / Certificate Monitor ─────────────────────────────────

/** Configuration for TLS manager. */
export interface TLSConfig {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

/**
 * TLS manager — manages TLS certificate lifecycle.
 */
export interface ITLSManager {
  /**
   * Load and validate current certificates.
   */
  loadConfig(config: TLSConfig): Promise<void>;

  /**
   * Get info about the current certificate.
   */
  getCertInfo(): Promise<CertInfo>;

  /**
   * Reload certificates from disk (for hot-reload after renewal).
   */
  reloadCerts(): Promise<void>;
}

/**
 * Certificate expiry monitor.
 */
export interface ICertMonitor {
  /**
   * Start monitoring certificates at a given interval.
   */
  start(checkIntervalMs: number): void;

  /**
   * Stop monitoring.
   */
  stop(): void;

  /**
   * Get the current expiry level for all monitored certs.
   */
  getExpiryStatus(): Array<{ cert: CertInfo; level: CertWarningLevel }>;

  /**
   * Register a callback for expiry warnings.
   */
  onWarning(cb: (cert: CertInfo, level: CertWarningLevel) => void): () => void;

  /**
   * Attempt automated certificate renewal (if ACME configured).
   */
  autoRenew(): Promise<boolean>;
}

// ── Encryption Manager ────────────────────────────────────────

/** Encryption configuration. */
export interface EncryptionConfig {
  algorithm: 'aes-256-gcm' | 'chacha20-poly1305';
  keyDerivation: 'pbkdf2' | 'argon2';
}

/**
 * Encryption manager — data at rest encryption.
 */
export interface IEncryptionManager {
  /**
   * Initialize encryption with the given config.
   */
  initialize(config: EncryptionConfig): Promise<void>;

  /**
   * Encrypt data at rest.
   * Returns { encrypted: Buffer, iv: Buffer, tag: Buffer } or similar.
   */
  encrypt(plaintext: Buffer, context?: string): Promise<Buffer>;

  /**
   * Decrypt data at rest.
   */
  decrypt(ciphertext: Buffer, context?: string): Promise<Buffer>;

  /**
   * Rotate the encryption key.
   */
  rotateKey(): Promise<void>;

  /**
   * Check if encryption is initialized.
   */
  isEnabled(): boolean;
}

// ── RBAC / Authorization ─────────────────────────────────────

/** Permission definition. */
export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'admin';
}

/** Role definition. */
export interface Role {
  name: string;
  permissions: Permission[];
}

/** User identity with roles. */
export interface Identity {
  id: string;
  roles: string[];
  attributes?: Record<string, string>;
}

/**
 * RBAC provider — role-based access control.
 */
export interface IRBACProvider {
  /**
   * Check if an identity has a given permission.
   */
  hasPermission(identity: Identity, permission: Permission): boolean;

  /**
   * Get all permissions for an identity.
   */
  getPermissions(identity: Identity): Permission[];

  /**
   * Register or update a role definition.
   */
  registerRole(role: Role): void;

  /**
   * Get all registered roles.
   */
  getRoles(): Role[];
}

// ── Rate Limiter ─────────────────────────────────────────────

/** Rate limiter configuration. */
export interface RateLimitConfig {
  /** Maximum number of requests in the window. */
  maxRequests: number;
  /** Time window in milliseconds. */
  windowMs: number;
}

/**
 * Rate limiter — enforces request rate limits.
 */
export interface IRateLimiter {
  /**
   * Check if a request should be allowed.
   * Implementations should use sliding window or token bucket.
   */
  check(key: string, config?: RateLimitConfig): { allowed: boolean; remaining: number; resetMs: number };

  /**
   * Reset rate limit tracking for a key.
   */
  reset(key: string): void;
}

// ── SCIM Sync ────────────────────────────────────────────────

/**
 * SCIM sync provider — syncs user/group identities from an IdP.
 */
export interface ISCIMSyncProvider {
  /**
   * Sync users from the identity provider.
   * Returns number of users added, updated, and removed.
   */
  syncUsers(): Promise<{ added: number; updated: number; removed: number }>;

  /**
   * Get the last sync timestamp.
   */
  getLastSyncTime(): Date | null;

  /**
   * Trigger a full resync (not incremental).
   */
  fullResync(): Promise<void>;
}

// ── Security Compliance ──────────────────────────────────────

/**
 * Security compliance checker — evaluates deployment against a baseline.
 */
export interface ISecurityCompliance {
  /**
   * Run all security checks against the current deployment.
   */
  runChecks(): Promise<SecurityCheck[]>;

  /**
   * Run checks in a specific category.
   */
  runCategory(category: string): Promise<SecurityCheck[]>;

  /**
   * Get the overall compliance score (0–100).
   */
  getScore(): number;
}
