/**
 * I30 — E4 RBAC tests.
 *
 * RB1-RB3: RBACEngine — Role management & hierarchy
 * RB4-RB6: Permission evaluation (direct, inherited, wildcard, scope)
 * RB7-RB9: Constraints (time, IP, MFA)
 * RB10-RB12: ABAC + Bulk evaluation + Edge cases
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RBACEngine } from "../impl/RBACEngine.js";
import type {
  RBACRole,
  RBACPermission,
  RBACIdentity,
  RBACConstraint,
  RBACEvaluationContext,
} from "../interfaces/IRBACEngine.js";

// ── Helpers ────────────────────────────────────────────────

function perm(resource: string, action: string, scope?: string): RBACPermission {
  return { resource, action, ...(scope ? { scope } : {}) };
}

function identity(
  id: string,
  roles: string[],
  attributes?: Record<string, unknown>,
): RBACIdentity {
  return { id, roles, ...(attributes ? { attributes } : {}) };
}

function role(
  name: string,
  overrides: Partial<RBACRole> = {},
): RBACRole {
  return {
    name,
    permissions: [],
    parents: [],
    ...overrides,
  };
}

// ── RB1: Role Management ────────────────────────────────────

describe("RB1: Role registration and management", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
  });

  it("registers a role", () => {
    engine.registerRole(role("admin", {
      permissions: [perm("*", "*")],
    }));

    expect(engine.getRole("admin")).toBeTruthy();
    expect(engine.getRole("admin")!.permissions).toHaveLength(1);
  });

  it("prevents self-referencing parent", () => {
    expect(() => {
      engine.registerRole(role("self-ref", { parents: ["self-ref"] }));
    }).toThrow("cannot be its own parent");
  });

  it("removes a non-system role", () => {
    engine.registerRole(role("temp"));
    expect(engine.removeRole("temp")).toBe(true);
    expect(engine.getRole("temp")).toBeNull();
  });

  it("prevents removal of system roles", () => {
    engine.registerRole(role("readonly", { system: true }));
    expect(engine.removeRole("readonly")).toBe(false);
    expect(engine.getRole("readonly")).toBeTruthy();
  });

  it("updates a non-system role", () => {
    engine.registerRole(role("editor", { permissions: [perm("table", "SELECT")] }));
    expect(engine.updateRole("editor", {
      permissions: [perm("table", "SELECT"), perm("table", "UPDATE")],
    })).toBe(true);

    const updated = engine.getRole("editor")!;
    expect(updated.permissions).toHaveLength(2);
  });

  it("prevents updating system roles", () => {
    engine.registerRole(role("sys_role", { system: true, permissions: [perm("*", "READ")] }));
    expect(engine.updateRole("sys_role", { permissions: [perm("*", "DELETE")] })).toBe(false);
    // Permissions unchanged
    expect(engine.getRole("sys_role")!.permissions[0]!.action).toBe("READ");
  });

  it("update role with self-referencing parent throws", () => {
    engine.registerRole(role("cycle"));
    expect(() => {
      engine.updateRole("cycle", { parents: ["cycle"] });
    }).toThrow("cannot be its own parent");
  });

  it("description is preserved", () => {
    engine.registerRole(role("described", {
      description: "A role with a description",
    }));
    expect(engine.getRole("described")!.description).toBe("A role with a description");
  });
});

// ── RB2: Role Hierarchy ─────────────────────────────────────

describe("RB2: Role hierarchy", () => {
  it("inherits permissions from parent roles", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("viewer", {
      permissions: [perm("table", "SELECT")],
    }));
    engine.registerRole(role("editor", {
      permissions: [perm("table", "UPDATE")],
      parents: ["viewer"],
    }));
    engine.registerRole(role("admin", {
      permissions: [perm("table", "DELETE")],
      parents: ["editor"],
    }));

    const effective = engine.getEffectivePermissions(identity("u", ["admin"]));
    const actions = effective.map((p) => p.action).sort();
    expect(actions).toContain("SELECT");
    expect(actions).toContain("UPDATE");
    expect(actions).toContain("DELETE");
  });

  it("multi-level hierarchy resolves correctly", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("L1", { permissions: [perm("db", "CONNECT")] }));
    engine.registerRole(role("L2", { parents: ["L1"], permissions: [perm("schema", "LIST")] }));
    engine.registerRole(role("L3", { parents: ["L2"], permissions: [perm("table", "SELECT")] }));
    engine.registerRole(role("L4", { parents: ["L3"], permissions: [perm("table", "INSERT")] }));

    const effective = engine.getEffectivePermissions(identity("u", ["L4"]));
    expect(effective.length).toBeGreaterThanOrEqual(4);
  });

  it("diamond inheritance deduplicates permissions", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("base", { permissions: [perm("t", "READ")] }));
    engine.registerRole(role("path_a", { parents: ["base"] }));
    engine.registerRole(role("path_b", { parents: ["base"] }));
    engine.registerRole(role("combo", { parents: ["path_a", "path_b"] }));

    const effective = engine.getEffectivePermissions(identity("u", ["combo"]));
    // "t:READ" should appear only once (deduped)
    const readPerms = effective.filter((p) => p.resource === "t" && p.action === "READ");
    expect(readPerms).toHaveLength(1);
  });

  it("detects circular dependencies", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("A", { parents: ["B"] }));
    engine.registerRole(role("B", { parents: ["C"] }));
    engine.registerRole(role("C", { parents: ["A"] }));

    const check = engine.validateHierarchy();
    expect(check.valid).toBe(false);
    expect(check.circularRoles.length).toBeGreaterThan(0);
  });

  it("clean hierarchy validates as valid", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("root"));
    engine.registerRole(role("child", { parents: ["root"] }));
    engine.registerRole(role("grandchild", { parents: ["child"] }));

    const check = engine.validateHierarchy();
    expect(check.valid).toBe(true);
    expect(check.circularRoles).toHaveLength(0);
  });

  it("getRoleAncestors returns all ancestors", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("A"));
    engine.registerRole(role("B", { parents: ["A"] }));
    engine.registerRole(role("C", { parents: ["B"] }));
    engine.registerRole(role("D", { parents: ["A"] }));

    const ancestors = engine.getRoleAncestors("C");
    expect(ancestors).toContain("B");
    expect(ancestors).toContain("A");
  });
});

// ── RB3: Permission Evaluation — Basic ──────────────────────

describe("RB3: Basic permission evaluation", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    engine.registerRole(role("reader", {
      permissions: [perm("table", "SELECT")],
    }));
    engine.registerRole(role("writer", {
      permissions: [perm("table", "SELECT"), perm("table", "INSERT"), perm("table", "UPDATE")],
    }));
    engine.registerRole(role("admin", {
      permissions: [perm("*", "*")],
    }));
  });

  it("grants allowed permission", async () => {
    const result = await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));
    expect(result.allowed).toBe(true);
  });

  it("denies missing permission", async () => {
    const result = await engine.checkPermission(identity("u", ["reader"]), perm("table", "DELETE"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No permission");
  });

  it("wildcard grants everything", async () => {
    const result = await engine.checkPermission(identity("u", ["admin"]), perm("anything", "anything"));
    expect(result.allowed).toBe(true);
  });

  it("reports granting roles", async () => {
    const result = await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));
    expect(result.grantedBy).toContain("reader");
  });

  it("inherited permission grants correctly", async () => {
    engine.registerRole(role("super_reader", {
      parents: ["reader"],
    }));
    const result = await engine.checkPermission(identity("u", ["super_reader"]), perm("table", "SELECT"));
    expect(result.allowed).toBe(true);
    expect(result.grantedBy).toContain("reader");
  });
});

// ── RB4: Permission Evaluation — Wildcards & Scopes ─────────

describe("RB4: Wildcard and scope matching", () => {
  it("resource:*, action:* wildcard matches anything", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("super", { permissions: [perm("*", "*")] }));

    const r1 = await engine.checkPermission(identity("u", ["super"]), perm("system", "reboot"));
    expect(r1.allowed).toBe(true);

    const r2 = await engine.checkPermission(identity("u", ["super"]), perm("db", "DROP_DB"));
    expect(r2.allowed).toBe(true);
  });

  it("resource-specific * action matches all actions", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("db_admin", { permissions: [perm("db", "*")] }));

    const r1 = await engine.checkPermission(identity("u", ["db_admin"]), perm("db", "CREATE"));
    expect(r1.allowed).toBe(true);

    const r2 = await engine.checkPermission(identity("u", ["db_admin"]), perm("db", "DELETE"));
    expect(r2.allowed).toBe(true);

    const r3 = await engine.checkPermission(identity("u", ["db_admin"]), perm("table", "SELECT"));
    expect(r3.allowed).toBe(false);
  });

  it("scope pattern matches resources", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("sales", {
      permissions: [perm("sales.*", "SELECT", "sales.*")],
    }));

    const r1 = await engine.checkPermission(identity("u", ["sales"]), perm("sales.orders", "SELECT"));
    expect(r1.allowed).toBe(true);

    const r2 = await engine.checkPermission(identity("u", ["sales"]), perm("sales.customers", "SELECT"));
    expect(r2.allowed).toBe(true);

    const r3 = await engine.checkPermission(identity("u", ["sales"]), perm("hr.employees", "SELECT"));
    expect(r3.allowed).toBe(false);
  });
});

// ── RB5: Explicit Deny ──────────────────────────────────────

describe("RB5: Explicit deny override", () => {
  it("deny: overrides grant", async () => {
    const engine = new RBACEngine();

    engine.registerRole(role("full_access", { permissions: [perm("*", "*")] }));
    engine.registerRole(role("no_delete", {
      permissions: [perm("table", "deny:DELETE")],
    }));

    const result = await engine.checkPermission(
      identity("u", ["full_access", "no_delete"]),
      perm("table", "DELETE"),
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Explicit deny");
  });

  it("deny on inherited permission", async () => {
    const engine = new RBACEngine();

    engine.registerRole(role("base_admin", { permissions: [perm("*", "*")] }));
    engine.registerRole(role("restricted", {
      permissions: [perm("table", "deny:DELETE")],
      parents: ["base_admin"],
    }));

    const result = await engine.checkPermission(
      identity("u", ["restricted"]),
      perm("table", "DELETE"),
    );

    expect(result.allowed).toBe(false);
  });
});

// ── RB6: Time Constraints ───────────────────────────────────

describe("RB6: Time constraints", () => {
  it("allows during permitted hours", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("daytime", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "time",
      resource: "table",
      action: "*",
      params: { startHour: 9, endHour: 17 },
    });

    const ctx: RBACEvaluationContext = { timestamp: Date.UTC(2026, 0, 1, 12, 0, 0) }; // noon UTC
    const result = await engine.checkPermission(
      identity("u", ["daytime"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks outside permitted hours", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("daytime", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "time",
      resource: "table",
      action: "*",
      params: { startHour: 9, endHour: 17 },
    });

    const ctx: RBACEvaluationContext = { timestamp: Date.UTC(2026, 0, 1, 3, 0, 0) }; // 3 AM UTC
    const result = await engine.checkPermission(
      identity("u", ["daytime"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Time constraint");
  });

  it("day-of-week constraint", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("weekday_user", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "time",
      resource: "table",
      action: "*",
      params: { dayOfWeek: [1, 2, 3, 4, 5] }, // Mon-Fri
    });

    // Mon Jan 5, 2026 is a Monday (day 1)
    const ctx: RBACEvaluationContext = { timestamp: Date.UTC(2026, 0, 5, 12, 0, 0) };
    const result = await engine.checkPermission(
      identity("u", ["weekday_user"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });
});

// ── RB7: IP Constraints ─────────────────────────────────────

describe("RB7: IP constraints", () => {
  it("allows from permitted IP", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("internal", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "ip_range",
      resource: "table",
      action: "*",
      params: { ranges: ["10.0.0.0/8", "192.168.1.1"] },
    });

    const ctx: RBACEvaluationContext = { ip: "10.0.0.5" };
    const result = await engine.checkPermission(
      identity("u", ["internal"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks from non-permitted IP", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("internal", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "ip_range",
      resource: "table",
      action: "*",
      params: { ranges: ["10.0.0.0/8"] },
    });

    const ctx: RBACEvaluationContext = { ip: "203.0.113.1" };
    const result = await engine.checkPermission(
      identity("u", ["internal"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("IP constraint");
  });

  it("exact IP match works", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("specific_ip", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "ip_range",
      resource: "table",
      action: "*",
      params: { ranges: ["192.168.1.1"] },
    });

    const ctx: RBACEvaluationContext = { ip: "192.168.1.1" };
    const result = await engine.checkPermission(
      identity("u", ["specific_ip"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });

  it("0.0.0.0/0 matches any IP (pass-through)", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("any_ip", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "ip_range",
      resource: "table",
      action: "*",
      params: { ranges: ["0.0.0.0/0"] },
    });

    const ctx: RBACEvaluationContext = { ip: "203.0.113.99" };
    const result = await engine.checkPermission(
      identity("u", ["any_ip"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });
});

// ── RB8: MFA Constraint ─────────────────────────────────────

describe("RB8: MFA constraint", () => {
  it("denies when MFA is required but not verified", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("sensitive", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "mfa_required",
      resource: "table",
      action: "*",
      params: {},
    });

    const result = await engine.checkPermission(
      identity("u", ["sensitive"]),
      perm("table", "SELECT"),
      { mfaVerified: false },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("MFA");
  });

  it("allows when MFA is verified", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("sensitive", { permissions: [perm("table", "SELECT")] }));
    engine.addConstraint({
      type: "mfa_required",
      resource: "table",
      action: "*",
      params: {},
    });

    const result = await engine.checkPermission(
      identity("u", ["sensitive"]),
      perm("table", "SELECT"),
      { mfaVerified: true },
    );
    expect(result.allowed).toBe(true);
  });
});

// ── RB9: Constraint Management ──────────────────────────────

describe("RB9: Constraint management", () => {
  it("adds and removes constraints", () => {
    const engine = new RBACEngine();

    engine.addConstraint({
      type: "time",
      resource: "table",
      action: "SELECT",
      params: { startHour: 9, endHour: 17 },
    });

    expect(engine.getConstraints()).toHaveLength(1);

    const removed = engine.removeConstraint("table", "SELECT", "time");
    expect(removed).toBe(true);
    expect(engine.getConstraints()).toHaveLength(0);
  });

  it("remove nonexistent constraint returns false", () => {
    const engine = new RBACEngine();
    expect(engine.removeConstraint("x", "y", "time")).toBe(false);
  });

  it("multiple constraints coexist", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("user", { permissions: [perm("table", "SELECT")] }));

    engine.addConstraint({ type: "mfa_required", resource: "table", action: "*", params: {} });
    engine.addConstraint({ type: "time", resource: "table", action: "*", params: { startHour: 9, endHour: 17 } });

    // MFA verified, within hours
    const ctx: RBACEvaluationContext = {
      mfaVerified: true,
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    };
    const result = await engine.checkPermission(
      identity("u", ["user"]),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });
});

// ── RB10: ABAC ──────────────────────────────────────────────

describe("RB10: Attribute-Based Access Control", () => {
  it("resource owner check passes for owner", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("user", { permissions: [perm("table", "SELECT")] }));

    const result = await engine.checkPermission(
      identity("user-42", ["user"], { resourceOwner: "user-42" }),
      perm("table", "SELECT"),
    );
    expect(result.allowed).toBe(true);
  });

  it("department-based access restricts unlisted departments", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("employee", { permissions: [perm("hr", "READ")] }));

    const result = await engine.checkPermission(
      identity("u", ["employee"], {
        department: "engineering",
        allowedDepartments: ["hr", "finance"],
      }),
      perm("hr", "READ"),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("department");
  });

  it("department-based access allows listed department", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("employee", { permissions: [perm("hr", "READ")] }));

    const result = await engine.checkPermission(
      identity("u", ["employee"], {
        department: "hr",
        allowedDepartments: ["hr", "finance"],
      }),
      perm("hr", "READ"),
    );
    expect(result.allowed).toBe(true);
  });

  it("working hours ABAC blocks outside 9-6", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("employee", { permissions: [perm("table", "SELECT")] }));

    // 8 PM (20:00)
    const ctx: RBACEvaluationContext = { timestamp: Date.UTC(2026, 0, 1, 20, 0, 0) };
    const result = await engine.checkPermission(
      identity("u", ["employee"], { workingHoursOnly: true }),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("working hours");
  });

  it("working hours ABAC allows during 9-6", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("employee", { permissions: [perm("table", "SELECT")] }));

    // 2 PM (14:00)
    const ctx: RBACEvaluationContext = { timestamp: Date.UTC(2026, 0, 1, 14, 0, 0) };
    const result = await engine.checkPermission(
      identity("u", ["employee"], { workingHoursOnly: true }),
      perm("table", "SELECT"),
      ctx,
    );
    expect(result.allowed).toBe(true);
  });
});

// ── RB11: Bulk Operations ──────────────────────────────────

describe("RB11: Bulk operations", () => {
  it("evaluates multiple permissions in batch", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));

    const results = await engine.checkPermissions(
      identity("u", ["reader"]),
      [perm("table", "SELECT"), perm("table", "DELETE"), perm("table", "INSERT")],
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.allowed).toBe(true);
    expect(results[1]!.allowed).toBe(false);
    expect(results[2]!.allowed).toBe(false);
  });
});

// ── RB12: Edge Cases ────────────────────────────────────────

describe("RB12: Edge cases", () => {
  it("role with no permissions inherits from parents", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));
    engine.registerRole(role("empty_role", { parents: ["reader"] }));

    const result = await engine.checkPermission(
      identity("u", ["empty_role"]),
      perm("table", "SELECT"),
    );
    expect(result.allowed).toBe(true);
  });

  it("identity with no roles has no permissions", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));

    const result = await engine.checkPermission(
      identity("u", []),
      perm("table", "SELECT"),
    );
    expect(result.allowed).toBe(false);
  });

  it("identity with nonexistent role is handled gracefully", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));

    const result = await engine.checkPermission(
      identity("u", ["nonexistent"]),
      perm("table", "SELECT"),
    );
    expect(result.allowed).toBe(false);
  });

  it("priority ordering: higher priority role resolved first", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("low_priority", {
      permissions: [perm("table", "SELECT")],
      priority: 1,
    }));
    engine.registerRole(role("high_priority", {
      permissions: [perm("table", "deny:SELECT")],
      priority: 100,
    }));

    // high_priority deny:SELECT should override low_priority SELECT
    const result = await engine.checkPermission(
      identity("u", ["low_priority", "high_priority"]),
      perm("table", "SELECT"),
    );
    expect(result.allowed).toBe(false);
  });

  it("stats report is accurate", () => {
    const engine = new RBACEngine();

    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));
    engine.registerRole(role("writer", {
      permissions: [perm("table", "SELECT"), perm("table", "UPDATE")],
      parents: ["reader"],
    }));

    const stats = engine.getStats();
    expect(stats.totalRoles).toBe(2);
    expect(stats.totalPermissions).toBe(3);
    expect(stats.hierarchyDepth).toBe(1); // writer → reader = 1 ancestor
    expect(stats.circularRoles).toHaveLength(0);
  });

  it("cache is invalidated on role mutation", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));

    // First evaluate — cached
    await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));

    // Mutate role
    engine.updateRole("reader", { permissions: [perm("table", "DELETE")] });

    // Should NOT have SELECT anymore
    const result = await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));
    expect(result.allowed).toBe(false);
  });

  it("duplicate role registration overwrites", () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));
    engine.registerRole(role("reader", { permissions: [perm("table", "DELETE")] }));

    expect(engine.getRole("reader")!.permissions[0]!.action).toBe("DELETE");
  });

  it("rate_limit and audit constraints are non-blocking", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("user", { permissions: [perm("table", "SELECT")] }));

    engine.addConstraint({
      type: "rate_limit",
      resource: "table",
      action: "*",
      params: { maxPerMinute: 100 },
    });
    engine.addConstraint({
      type: "audit",
      resource: "*",
      action: "*",
      params: { level: "detailed" },
    });

    const result = await engine.checkPermission(
      identity("u", ["user"]),
      perm("table", "SELECT"),
    );
    // Both should pass through (non-blocking)
    expect(result.allowed).toBe(true);
  });

  it("getRoleAncestors for unknown role returns empty", () => {
    const engine = new RBACEngine();
    expect(engine.getRoleAncestors("nonexistent")).toHaveLength(0);
  });

  it("evaluation count increments in stats", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "SELECT")] }));

    await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));
    await engine.checkPermission(identity("u", ["reader"]), perm("table", "SELECT"));

    expect(engine.getStats().evaluationsPerformed).toBe(2);
  });

  it("default context allows permission check without constraints", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("basic", { permissions: [perm("api", "call")] }));

    const result = await engine.checkPermission(
      identity("u", ["basic"]),
      perm("api", "call"),
    );
    expect(result.allowed).toBe(true);
  });
});
