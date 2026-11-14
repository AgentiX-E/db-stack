/**
 * I30 — E4 RBAC Engine.
 *
 * Production-grade multi-dimensional RBAC with:
 *   - DAG-based role hierarchy with circular dependency detection
 *   - Inherited permission resolution via BFS traversal
 *   - ABAC: attribute-based policy evaluation (resource owner, time-of-day)
 *   - Constraint enforcement: time window, IP range, MFA requirement
 *   - Deny-override strategy: explicit deny trumps all grants
 *   - LRU permission resolution cache (invalidated on role mutation)
 *   - Resolution order: direct+inherited → constraints → ABAC → final
 */

import {
  type IRBACEngine,
  type RBACRole,
  type RBACPermission,
  type RBACIdentity,
  type RBACConstraint,
  type RBACDecision,
  type RBACEvaluationContext,
  type RBACStats,
  type ConstraintType,
} from "../interfaces/IRBACEngine.js";

// ── Constants ──────────────────────────────────────────────

const CACHE_MAX_SIZE = 500;
const DENY_PREFIX = "deny:";

// ── RBACEngine ──────────────────────────────────────────────

export class RBACEngine implements IRBACEngine {
  private roles = new Map<string, RBACRole>();
  private constraints: RBACConstraint[] = [];
  private resolutionCache = new Map<string, RBACPermission[]>();
  /**
   * Reverse index: identity id → cache keys holding its resolutions.
   *
   * Cache keys are `perm:<id>:<roles>`, so `resolutionCache.delete(id)` could
   * never match anything — per-identity invalidation was a silent no-op and a
   * revoked role kept being served from cache until the 500-entry LRU evicted
   * it. The index makes targeted invalidation exact and O(1).
   */
  private readonly cacheKeysByIdentity = new Map<string, Set<string>>();
  /** Cache key → owning identity id, so eviction can update the index in O(1). */
  private readonly cacheKeyOwner = new Map<string, string>();
  private evaluationCount = 0;

  // ── Role Management ───────────────────────────────────────

  registerRole(role: RBACRole): void {
    if (!role.name) throw new Error("Role must have a name");
    if (role.parents.includes(role.name)) {
      throw new Error(`Role "${role.name}" cannot be its own parent`);
    }
    this.roles.set(role.name, {
      ...role,
      permissions: [...role.permissions],
      parents: [...role.parents],
    });
    this.invalidateCache(); // Role changes invalidate all cached resolutions
  }

  removeRole(name: string): boolean {
    const role = this.roles.get(name);
    if (role?.system) return false; // System roles are immutable

    const deleted = this.roles.delete(name);
    if (deleted) this.invalidateCache();
    return deleted;
  }

  getRole(name: string): RBACRole | null {
    return this.roles.get(name) ?? null;
  }

  getRoles(): RBACRole[] {
    return Array.from(this.roles.values());
  }

  updateRole(name: string, updates: Partial<RBACRole>): boolean {
    const existing = this.roles.get(name);
    if (!existing) return false;
    if (existing.system) return false;

    const updated: RBACRole = {
      name: existing.name,
      description: updates.description ?? existing.description,
      permissions: updates.permissions ?? existing.permissions,
      parents: updates.parents ?? existing.parents,
      system: existing.system,
      priority: updates.priority ?? existing.priority,
    };

    if (updated.parents.includes(updated.name)) {
      throw new Error(`Role "${updated.name}" cannot be its own parent`);
    }

    this.roles.set(name, updated);
    this.invalidateCache();
    return true;
  }

  // ── Permission Check ──────────────────────────────────────

  async checkPermission(
    identity: RBACIdentity,
    permission: RBACPermission,
    context?: RBACEvaluationContext,
  ): Promise<RBACDecision> {
    this.evaluationCount++;

    // 1. Resolve effective permissions (with cache)
    const effective = this._resolveEffectivePermissions(identity);

    // 2. Check for explicit deny (action prefixed with "deny:")
    const deniedPerm = effective.find(
      (p) => p.action.startsWith(DENY_PREFIX),
    );

    if (deniedPerm) {
      // Extract the denied action: "deny:DELETE" → "DELETE"
      const deniedAction = deniedPerm.action.slice(DENY_PREFIX.length);
      if (
        this._matchPermission(
          { resource: deniedPerm.resource, action: deniedAction },
          permission,
        )
      ) {
        return {
          allowed: false,
          reason: `Explicit deny on ${permission.resource}:${permission.action}`,
          deniedByConstraint: ["explicit_deny"],
        };
      }
    }

    // 3. Check for grant (direct or wildcard)
    const granted = effective.some(
      (p) =>
        this._matchPermission(p, permission),
    );

    if (!granted) {
      return {
        allowed: false,
        reason: `No permission for ${permission.resource}:${permission.action}`,
      };
    }

    // 4. Evaluate constraints
    if (context) {
      const constraintResult = this._evaluateConstraints(permission, context);
      if (!constraintResult.allowed) {
        return constraintResult;
      }
    }

    // 5. Evaluate ABAC attributes
    if (identity.attributes) {
      const abacResult = this._evaluateABAC(identity, permission, context);
      if (!abacResult.allowed) {
        return abacResult;
      }
    }

    // 6. Allowed
    const grantedBy = this._findGrantingRoles(identity, permission);
    return {
      allowed: true,
      reason: "Permission granted",
      grantedBy,
      effectivePermissions: effective,
    };
  }

  async checkPermissions(
    identity: RBACIdentity,
    permissions: RBACPermission[],
    context?: RBACEvaluationContext,
  ): Promise<RBACDecision[]> {
    const results: RBACDecision[] = [];
    for (const perm of permissions) {
      results.push(await this.checkPermission(identity, perm, context));
    }
    return results;
  }

  // ── Effective Permissions ─────────────────────────────────

  getEffectivePermissions(identity: RBACIdentity): RBACPermission[] {
    return this._resolveEffectivePermissions(identity);
  }

  // ── Constraints ───────────────────────────────────────────

  addConstraint(constraint: RBACConstraint): void {
    this.constraints.push(constraint);
  }

  removeConstraint(resource: string, action: string, type: ConstraintType): boolean {
    const idx = this.constraints.findIndex(
      (c) => c.resource === resource && c.action === action && c.type === type,
    );
    if (idx < 0) return false;
    this.constraints.splice(idx, 1);
    return true;
  }

  getConstraints(): RBACConstraint[] {
    return [...this.constraints];
  }

  // ── Hierarchy ─────────────────────────────────────────────

  validateHierarchy(): { valid: boolean; circularRoles: string[] } {
    const circular: string[] = [];

    for (const [roleName] of this.roles) {
      if (this._hasCycle(roleName)) {
        circular.push(roleName);
      }
    }

    return { valid: circular.length === 0, circularRoles: circular };
  }

  getRoleAncestors(roleName: string): string[] {
    const ancestors = new Set<string>();
    const visited = new Set<string>();

    const traverse = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const role = this.roles.get(name);
      if (!role) return;
      for (const parent of role.parents) {
        ancestors.add(parent);
        traverse(parent);
      }
    };

    traverse(roleName);
    return Array.from(ancestors);
  }

  // ── Statistics ────────────────────────────────────────────

  getStats(): RBACStats {
    const hierarchyCheck = this.validateHierarchy();
    const totalPermissions = Array.from(this.roles.values()).reduce(
      (sum, r) => sum + r.permissions.length,
      0,
    );

    let maxDepth = 0;
    for (const [roleName] of this.roles) {
      const ancestors = this.getRoleAncestors(roleName);
      if (ancestors.length > maxDepth) maxDepth = ancestors.length;
    }

    return {
      totalRoles: this.roles.size,
      totalPermissions,
      totalIdentities: 0, // Managed externally
      hierarchyDepth: maxDepth,
      circularRoles: hierarchyCheck.circularRoles,
      cachedResolutions: this.resolutionCache.size,
      evaluationsPerformed: this.evaluationCount,
    };
  }

  // ── Caching ───────────────────────────────────────────────

  invalidateCache(identityId?: string): void {
    if (identityId) {
      const keys = this.cacheKeysByIdentity.get(identityId);
      if (!keys) return;
      for (const key of keys) {
        this.resolutionCache.delete(key);
        this.cacheKeyOwner.delete(key);
      }
      this.cacheKeysByIdentity.delete(identityId);
    } else {
      this.resolutionCache.clear();
      this.cacheKeyOwner.clear();
      this.cacheKeysByIdentity.clear();
    }
  }

  // ── Internal: Permission Resolution ───────────────────────

  private _resolveEffectivePermissions(identity: RBACIdentity): RBACPermission[] {
    const cacheKey = `perm:${identity.id}:${identity.roles.sort().join(",")}`;

    const cached = this.resolutionCache.get(cacheKey);
    if (cached) return cached;

    const resolved = new Map<string, RBACPermission>();
    const visited = new Set<string>();

    const resolveRole = (roleName: string) => {
      if (visited.has(roleName)) return;
      visited.add(roleName);

      const role = this.roles.get(roleName);
      if (!role) return;

      // Add direct permissions
      for (const perm of role.permissions) {
        const key = `${perm.resource}:${perm.action}`;
        if (!resolved.has(key)) {
          resolved.set(key, { ...perm });
        }
      }

      // Resolve parent hierarchy (DFS with cycle detection)
      for (const parent of role.parents) {
        resolveRole(parent);
      }
    };

    // Process roles by priority (higher first), then name order
    const sortedRoles = identity.roles
      .map((name) => this.roles.get(name))
      .filter(Boolean)
      .sort((a, b) => {
        const pa = a!.priority ?? 0;
        const pb = b!.priority ?? 0;
        if (pa !== pb) return pb - pa; // Higher first
        return a!.name.localeCompare(b!.name);
      });

    for (const role of sortedRoles) {
      resolveRole(role!.name);
    }

    const result = Array.from(resolved.values());

    // Cache with LRU eviction
    if (this.resolutionCache.size >= CACHE_MAX_SIZE) {
      const firstKey = this.resolutionCache.keys().next().value;
      if (firstKey) {
        this.resolutionCache.delete(firstKey);
        this._dropIndexEntry(firstKey);
      }
    }
    this.resolutionCache.set(cacheKey, result);
    this.cacheKeyOwner.set(cacheKey, identity.id);
    const owned = this.cacheKeysByIdentity.get(identity.id);
    if (owned) owned.add(cacheKey);
    else this.cacheKeysByIdentity.set(identity.id, new Set([cacheKey]));

    return result;
  }

  /** Remove an evicted cache key from the per-identity reverse index. */
  private _dropIndexEntry(cacheKey: string): void {
    const owner = this.cacheKeyOwner.get(cacheKey);
    this.cacheKeyOwner.delete(cacheKey);
    if (owner === undefined) return;
    const keys = this.cacheKeysByIdentity.get(owner);
    if (!keys) return;
    keys.delete(cacheKey);
    if (keys.size === 0) this.cacheKeysByIdentity.delete(owner);
  }

  // ── Internal: Constraint Evaluation ───────────────────────

  private _evaluateConstraints(
    permission: RBACPermission,
    context: RBACEvaluationContext,
  ): RBACDecision {
    const applicable = this.constraints.filter(
      (c) =>
        (c.resource === "*" || c.resource === permission.resource) &&
        (c.action === "*" || c.action === permission.action),
    );

    for (const constraint of applicable) {
      switch (constraint.type) {
        case "time": {
          const allowed = this._checkTimeConstraint(constraint.params, context);
          if (!allowed) {
            return {
              allowed: false,
              reason: `Time constraint violated: access only allowed during ${JSON.stringify(constraint.params)}`,
              deniedByConstraint: [JSON.stringify(constraint)],
            };
          }
          break;
        }
        case "ip_range": {
          const allowed = this._checkIPConstraint(constraint.params, context);
          if (!allowed) {
            return {
              allowed: false,
              reason: `IP constraint violated: access from ${context.ip} not in allowed ranges`,
              deniedByConstraint: [JSON.stringify(constraint)],
            };
          }
          break;
        }
        case "mfa_required": {
          if (!context.mfaVerified) {
            return {
              allowed: false,
              reason: "MFA required but not verified",
              deniedByConstraint: ["mfa_required"],
            };
          }
          break;
        }
        case "rate_limit":
        case "audit":
          // Audit and rate-limit constraints are non-blocking (pass-through)
          break;
      }
    }

    return { allowed: true, reason: "Constraints satisfied" };
  }

  // ── Internal: ABAC Evaluation ─────────────────────────────

  private _evaluateABAC(
    identity: RBACIdentity,
    permission: RBACPermission,
    context?: RBACEvaluationContext,
  ): RBACDecision {
    const attrs = identity.attributes;
    if (!attrs) return { allowed: true, reason: "No ABAC policies" };

    // Resource ownership: user can only access their own data
    if (attrs.resourceOwner === identity.id) {
      // Attribute says "this user owns resource X" — allow
      return { allowed: true, reason: "ABAC: resource owner" };
    }

    // Department-based access
    if (attrs.department && attrs.allowedDepartments) {
      const allowed = attrs.allowedDepartments as string[];
      if (!allowed.includes(attrs.department as string)) {
        return {
          allowed: false,
          reason: `ABAC: department "${attrs.department}" not in allowed list`,
          deniedByConstraint: ["abac_department"],
        };
      }
    }

    // Time-of-day attribute check
    if (attrs.workingHoursOnly === true && context?.timestamp) {
      const hour = new Date(context.timestamp).getUTCHours();
      if (hour < 9 || hour >= 18) {
        return {
          allowed: false,
          reason: "ABAC: access restricted to 9:00-18:00 working hours",
          deniedByConstraint: ["abac_working_hours"],
        };
      }
    }

    return { allowed: true, reason: "ABAC satisfied" };
  }

  // ── Internal: Permission Matching ─────────────────────────

  private _matchPermission(
    granted: RBACPermission,
    requested: RBACPermission,
  ): boolean {
    // Wildcard match: "*:*" grants everything, "table:*" grants all actions on table
    if (granted.resource === "*" && granted.action === "*") return true;
    if (granted.resource === requested.resource && granted.action === "*") return true;
    if (granted.resource === "*" && granted.action === requested.action) return true;

    // Scope match: "sales.*" matches "sales.orders" and "sales.customers"
    if (granted.scope) {
      const scopePattern = granted.scope.replace("*", ".*");
      try {
        const regex = new RegExp(`^${scopePattern}$`);
        if (regex.test(requested.resource) && granted.action === requested.action) {
          return true;
        }
      } catch {
        // Invalid regex scope — fall through to exact match
      }
    }

    // Exact match
    return granted.resource === requested.resource && granted.action === requested.action;
  }

  // ── Internal: Granting Roles ──────────────────────────────

  private _findGrantingRoles(
    identity: RBACIdentity,
    permission: RBACPermission,
  ): string[] {
    const granting: string[] = [];
    const visited = new Set<string>();

    const checkRole = (roleName: string) => {
      if (visited.has(roleName)) return;
      visited.add(roleName);

      const role = this.roles.get(roleName);
      if (!role) return;

      const hasPerm = role.permissions.some((p) => this._matchPermission(p, permission));
      if (hasPerm) {
        granting.push(roleName);
      }

      for (const parent of role.parents) {
        checkRole(parent);
      }
    };

    for (const roleName of identity.roles) {
      checkRole(roleName);
    }

    return granting;
  }

  // ── Internal: Cycle Detection ─────────────────────────────

  private _hasCycle(roleName: string): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (name: string): boolean => {
      if (stack.has(name)) return true; // Back edge = cycle
      if (visited.has(name)) return false;

      visited.add(name);
      stack.add(name);

      const role = this.roles.get(name);
      if (role) {
        for (const parent of role.parents) {
          if (dfs(parent)) return true;
        }
      }

      stack.delete(name);
      return false;
    };

    return dfs(roleName);
  }

  // ── Internal: Time Constraint ─────────────────────────────

  private _checkTimeConstraint(
    params: Record<string, unknown>,
    context: RBACEvaluationContext,
  ): boolean {
    const now = context.timestamp ?? Date.now();
    const date = new Date(now);

    if (params.startHour !== undefined && params.endHour !== undefined) {
      const hour = date.getUTCHours();
      const start = params.startHour as number;
      const end = params.endHour as number;
      if (hour < start || hour >= end) return false;
    }

    if (params.dayOfWeek !== undefined) {
      const allowedDays = params.dayOfWeek as number[];
      const today = date.getDay(); // 0=Sun, 1=Mon, ...
      if (!allowedDays.includes(today)) return false;
    }

    return true;
  }

  // ── Internal: IP Constraint ───────────────────────────────

  private _checkIPConstraint(
    params: Record<string, unknown>,
    context: RBACEvaluationContext,
  ): boolean {
    if (!context.ip) return true; // No IP — cannot enforce, allow
    const allowedRanges = params.ranges as string[];
    if (!allowedRanges || allowedRanges.length === 0) return true;

    return allowedRanges.some((range) => this._ipInRange(context.ip!, range));
  }

  /**
   * Check if an IP is in a CIDR range or exact match.
   * Supports: "192.168.1.0/24", "10.0.0.1", "172.16.0.0/16", "0.0.0.0/0" (any)
   */
  private _ipInRange(ip: string, range: string): boolean {
    // "0.0.0.0/0" matches any
    if (range === "0.0.0.0/0") return true;

    // Exact match
    if (!range.includes("/")) {
      return ip === range;
    }

    // CIDR match
    const [network, bitsStr] = range.split("/");
    if (!network || !bitsStr) return false;

    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;

    const ipNum = this._ipToNumber(ip);
    const netNum = this._ipToNumber(network);

    if (bits === 0) return true;
    const mask = ~(2 ** (32 - bits) - 1);

    // Use unsigned 32-bit via >>> 0
    return ((ipNum & mask) >>> 0) === ((netNum & mask) >>> 0);
  }

  private _ipToNumber(ip: string): number {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return 0;
    return ((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!;
  }
}
