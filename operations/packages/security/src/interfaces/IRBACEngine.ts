/**
 * I30 — E4 RBAC Engine interfaces.
 *
 * Multi-dimensional Role-Based Access Control with:
 *   - Role hierarchy (DAG with inheritance)
 *   - Permission constraints (time, IP, MFA, audit)
 *   - ABAC (Attribute-Based Access Control) extension
 *   - Deny-override evaluation strategy
 *   - Permission resolution cache
 */

// ── Permission ──────────────────────────────────────────────

/** Granular permission: resource + action. */
export interface RBACPermission {
  /** Resource identifier (table, function, schema). */
  resource: string;
  /** Action on the resource. */
  action: string;
  /** Optional resource scope (e.g., "sales.*" for all in schema). */
  scope?: string;
}

// ── Role ────────────────────────────────────────────────────

/** A named role with permissions and parent roles. */
export interface RBACRole {
  /** Unique role name. */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** Directly assigned permissions. */
  permissions: RBACPermission[];
  /** Parent roles (inherit permissions). */
  parents: string[];
  /** Whether this is a system role (cannot be modified/deleted). */
  system?: boolean;
  /** Role priority (higher = checked first). */
  priority?: number;
}

// ── Identity ────────────────────────────────────────────────

/** An authenticated principal. */
export interface RBACIdentity {
  /** Unique principal identifier. */
  id: string;
  /** Assigned role names. */
  roles: string[];
  /** ABAC attributes. */
  attributes?: Record<string, unknown>;
}

// ── Constraints ─────────────────────────────────────────────

/** Constraint type. */
export type ConstraintType = "time" | "ip_range" | "mfa_required" | "rate_limit" | "audit";

/** A permission constraint that must be satisfied. */
export interface RBACConstraint {
  /** Constraint type. */
  type: ConstraintType;
  /** Resource this constraint applies to (or "*" for all). */
  resource: string;
  /** Action this applies to (or "*" for all). */
  action: string;
  /** Constraint parameters. */
  params: Record<string, unknown>;
}

/** Context passed during permission evaluation. */
export interface RBACEvaluationContext {
  /** Current time (epoch ms). */
  timestamp?: number;
  /** Requester IP address. */
  ip?: string;
  /** Whether MFA has been satisfied. */
  mfaVerified?: boolean;
  /** Session identifier. */
  sessionId?: string;
}

// ── Decision ────────────────────────────────────────────────

/** Permission check result with reasoning. */
export interface RBACDecision {
  /** Whether access is granted. */
  allowed: boolean;
  /** Reason for the decision. */
  reason: string;
  /** Which role(s) granted the permission. */
  grantedBy?: string[];
  /** Which constraint(s) denied access (if applicable). */
  deniedByConstraint?: string[];
  /** Resolved effective permissions at decision time. */
  effectivePermissions?: RBACPermission[];
}

// ── Statistics ──────────────────────────────────────────────

export interface RBACStats {
  totalRoles: number;
  totalPermissions: number;
  totalIdentities: number;
  hierarchyDepth: number;
  circularRoles: string[];
  cachedResolutions: number;
  evaluationsPerformed: number;
}

// ── RBAC Engine Interface ───────────────────────────────────

export interface IRBACEngine {
  // Role management
  registerRole(role: RBACRole): void;
  removeRole(name: string): boolean;
  getRole(name: string): RBACRole | null;
  getRoles(): RBACRole[];
  updateRole(name: string, updates: Partial<RBACRole>): boolean;

  // Permission check
  checkPermission(
    identity: RBACIdentity,
    permission: RBACPermission,
    context?: RBACEvaluationContext,
  ): Promise<RBACDecision>;

  // Bulk operations
  checkPermissions(
    identity: RBACIdentity,
    permissions: RBACPermission[],
    context?: RBACEvaluationContext,
  ): Promise<RBACDecision[]>;

  // Effective permissions
  getEffectivePermissions(identity: RBACIdentity): RBACPermission[];

  // Constraints
  addConstraint(constraint: RBACConstraint): void;
  removeConstraint(resource: string, action: string, type: ConstraintType): boolean;
  getConstraints(): RBACConstraint[];

  // Hierarchy
  validateHierarchy(): { valid: boolean; circularRoles: string[] };
  getRoleAncestors(roleName: string): string[];

  // Statistics
  getStats(): RBACStats;

  // Caching
  invalidateCache(identityId?: string): void;
}
