// ── Existing Interfaces ──

export interface IRBACProvider {
  /** Check if a role has permission for a specific action on a resource */
  checkPermission(role: string, action: string, resource: string): Promise<boolean>;
  /** Assign a role to a user */
  assignRole(userId: string, role: string): Promise<void>;
  /** Revoke a role from a user */
  revokeRole(userId: string, role: string): Promise<void>;
  /** List all roles assigned to a user */
  getUserRoles(userId: string): Promise<string[]>;
}

export interface IAuthProvider {
  /** Authenticate a user with credentials */
  authenticate(username: string, password: string): Promise<{ token: string; expiresAt: Date }>;
  /** Validate an existing token */
  validateToken(token: string): Promise<{ userId: string; roles: string[] }>;
  /** Revoke a token */
  revokeToken(token: string): Promise<void>;
}

export interface ITLSManager {
  /** Get the current TLS configuration */
  getConfig(): Promise<{ cert: string; key: string; ca?: string }>;
  /** Rotate TLS certificates */
  rotateCertificates(newCert: string, newKey: string): Promise<void>;
  /** Validate certificate expiration */
  validateExpiration(): Promise<{ valid: boolean; daysRemaining: number }>;
}

export interface IAuditStore {
  /** Record an audit event */
  record(event: AuditEvent): Promise<void>;
  /** Query audit events with filters */
  query(filters: AuditQuery): Promise<AuditEvent[]>;
  /** Export audit log for compliance */
  export(startDate: Date, endDate: Date): Promise<AuditEvent[]>;
}

export interface AuditEvent {
  timestamp: Date;
  userId: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  userId?: string;
  action?: string;
  resource?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// ── Sprint 1.2 New Interfaces ──

export interface IRateLimiter {
  /** Check if a request is allowed under the rate limit, optionally with a specific cost */
  check(key: string, cost?: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

export interface IBottleneckConfig {
  /** Maximum tokens in the bucket */
  maxTokens: number;
  /** Rate at which tokens are refilled per interval */
  refillRate: number;
  /** Interval in milliseconds for token refill */
  refillIntervalMs: number;
}

export interface IEncryptionManager {
  /** Encrypt plaintext using the specified key */
  encrypt(plaintext: string, keyId: string): Promise<string>;
  /** Decrypt ciphertext using the associated key */
  decrypt(ciphertext: string): Promise<string>;
  /** Generate a new encryption key with the given identifier */
  generateKey(keyId: string): Promise<void>;
  /** Rotate an existing key (generate a new version) */
  rotateKey(keyId: string): Promise<void>;
  /** List all available key identifiers */
  listKeys(): Promise<string[]>;
}

export interface ISCIMUser {
  /** Unique identifier for the user */
  id: string;
  /** Unique username/login name */
  userName: string;
  /** Human-readable display name */
  displayName: string;
  /** Email addresses associated with the user */
  emails: string[];
  /** Whether the user account is active */
  active: boolean;
  /** Roles assigned to the user */
  roles: string[];
}

export interface ISCIMSyncProvider {
  /** Create a new user in the external identity provider */
  createUser(user: ISCIMUser): Promise<ISCIMUser>;
  /** Update an existing user in the external identity provider */
  updateUser(user: ISCIMUser): Promise<ISCIMUser>;
  /** Delete a user from the external identity provider */
  deleteUser(userId: string): Promise<void>;
  /** List all users from the external identity provider */
  listUsers(): Promise<ISCIMUser[]>;
  /** Perform a full synchronization of all users */
  syncAll(): Promise<{ created: number; updated: number; deleted: number }>;
}
