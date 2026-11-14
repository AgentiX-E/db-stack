/**
 * RBACEngine — defensive paths that decide *deny* semantics.
 *
 * The i30 suite covers the documented allow/deny flows. What it does not cover
 * is where a mistake silently grants access:
 *
 *   - a role graph with converging paths (diamond) must not loop or duplicate,
 *   - an identity referencing an unregistered role must not throw,
 *   - a malformed CIDR must deny rather than throw,
 *   - a malformed scope regex must fall back to exact matching,
 *   - non-blocking constraints (rate-limit / audit) must pass through.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RBACEngine } from "../impl/RBACEngine.js";
import type {
  RBACConstraint,
  RBACIdentity,
  RBACPermission,
  RBACRole,
} from "../interfaces/IRBACEngine.js";

function perm(resource: string, action: string, scope?: string): RBACPermission {
  return { resource, action, ...(scope ? { scope } : {}) };
}

function role(name: string, overrides: Partial<RBACRole> = {}): RBACRole {
  return { name, permissions: [], parents: [], ...overrides };
}

function identity(id: string, roles: string[], attributes?: Record<string, unknown>): RBACIdentity {
  return { id, roles, ...(attributes ? { attributes } : {}) };
}

function constraint(
  type: RBACConstraint["type"],
  params: Record<string, unknown>,
  resource = "*",
  action = "*",
): RBACConstraint {
  return { type, resource, action, params };
}

describe("RBACEngine — role registration guards", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
  });

  it("rejects a role without a name", () => {
    expect(() => engine.registerRole(role(""))).toThrow("Role must have a name");
  });

  it("rejects a role that is its own parent", () => {
    expect(() => engine.registerRole(role("loop", { parents: ["loop"] }))).toThrow(
      "cannot be its own parent",
    );
  });
});

describe("RBACEngine — hierarchy traversal", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    // Diamond: both `writer` and `reader` inherit from `base`.
    engine.registerRole(role("base", { permissions: [perm("table", "read")] }));
    engine.registerRole(role("writer", { parents: ["base"], permissions: [perm("table", "write")] }));
    engine.registerRole(role("reader", { parents: ["base"] }));
    engine.registerRole(role("editor", { parents: ["writer", "reader"] }));
  });

  it("visits a shared ancestor once when resolving a diamond", () => {
    expect(engine.getRoleAncestors("editor").sort()).toEqual(["base", "reader", "writer"]);
  });

  it("resolves inherited permissions once per resource:action", async () => {
    const decision = await engine.checkPermission(identity("u1", ["editor"]), perm("table", "read"));

    expect(decision.allowed).toBe(true);
    expect(decision.effectivePermissions?.filter((p) => p.action === "read")).toHaveLength(1);
  });

  it("reports which role granted the permission, without duplicates", async () => {
    const decision = await engine.checkPermission(identity("u2", ["editor"]), perm("table", "read"));

    expect(decision.grantedBy).toEqual(["base"]);
  });
});

describe("RBACEngine — unknown references", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "read")] }));
  });

  it("ignores a role that was never registered", async () => {
    const decision = await engine.checkPermission(
      identity("u3", ["ghost", "reader"]),
      perm("table", "read"),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.grantedBy).toEqual(["reader"]);
  });

  it("denies when every referenced role is unknown", async () => {
    const decision = await engine.checkPermission(identity("u4", ["ghost"]), perm("table", "read"));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("No permission");
  });

  it("returns no ancestors for an unknown role", () => {
    expect(engine.getRoleAncestors("ghost")).toEqual([]);
  });
});

describe("RBACEngine — resolution cache", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    engine.registerRole(role("reader", { permissions: [perm("table", "read")] }));
  });

  it("serves the second evaluation from the cache", async () => {
    const who = identity("u5", ["reader"]);
    await engine.checkPermission(who, perm("table", "read"));
    const cached = engine.getStats().cachedResolutions;

    await engine.checkPermission(who, perm("table", "read"));

    expect(engine.getStats().cachedResolutions).toBe(cached);
  });

  it("invalidates a single identity's cache entry", async () => {
    await engine.checkPermission(identity("u6", ["reader"]), perm("table", "read"));
    expect(engine.getStats().cachedResolutions).toBe(1);

    engine.invalidateCache("u6");

    expect(engine.getStats().cachedResolutions).toBe(0);
  });

  it("keeps other identities cached when one is invalidated", async () => {
    await engine.checkPermission(identity("u6", ["reader"]), perm("table", "read"));
    await engine.checkPermission(identity("u6b", ["reader"]), perm("table", "read"));

    engine.invalidateCache("u6");

    expect(engine.getStats().cachedResolutions).toBe(1);
  });

  it("ignores an identity that holds no cache entry", async () => {
    await engine.checkPermission(identity("u6c", ["reader"]), perm("table", "read"));

    expect(() => engine.invalidateCache("never-seen")).not.toThrow();
    expect(engine.getStats().cachedResolutions).toBe(1);
  });

  it("serves revoked permissions only until the cache is invalidated", async () => {
    const who = identity("u6d", ["reader"]);
    expect((await engine.checkPermission(who, perm("table", "read"))).allowed).toBe(true);

    engine.removeRole("reader");
    engine.invalidateCache("u6d");

    expect((await engine.checkPermission(who, perm("table", "read"))).allowed).toBe(false);
  });

  it("invalidates the whole cache when no identity is given", async () => {
    await engine.checkPermission(identity("u7", ["reader"]), perm("table", "read"));
    await engine.checkPermission(identity("u8", ["reader"]), perm("table", "read"));
    expect(engine.getStats().cachedResolutions).toBe(2);

    engine.invalidateCache();

    expect(engine.getStats().cachedResolutions).toBe(0);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    // CACHE_MAX_SIZE is 500: the 501st distinct identity must evict, keeping the
    // cache bounded instead of growing with every new caller.
    for (let i = 0; i <= 500; i++) {
      await engine.checkPermission(identity(`bulk-${i}`, ["reader"]), perm("table", "read"));
    }

    expect(engine.getStats().cachedResolutions).toBeLessThanOrEqual(500);
  });
});

describe("RBACEngine — constraint evaluation", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    engine.registerRole(role("admin", { permissions: [perm("*", "*")] }));
  });

  it("passes through rate-limit constraints", async () => {
    engine.addConstraint(constraint("rate_limit", { maxPerMinute: 10 }));

    const decision = await engine.checkPermission(identity("c1", ["admin"]), perm("table", "read"), {
      sessionId: "s1",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("Permission granted");
  });

  it("passes through audit constraints", async () => {
    engine.addConstraint(constraint("audit", { level: "verbose" }));

    const decision = await engine.checkPermission(identity("c2", ["admin"]), perm("table", "read"), {
      sessionId: "s2",
    });

    expect(decision.allowed).toBe(true);
  });

  it("denies a time-window violation and names the constraint", async () => {
    engine.addConstraint(constraint("time", { startHour: 9, endHour: 17 }));

    const decision = await engine.checkPermission(identity("c3", ["admin"]), perm("table", "read"), {
      timestamp: Date.UTC(2024, 0, 1, 3), // 03:00 UTC — outside 09:00–17:00
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Time constraint violated");
    expect(decision.deniedByConstraint).toHaveLength(1);
  });

  it("falls back to the current clock when the context has no timestamp", async () => {
    engine.addConstraint(constraint("time", { startHour: 0, endHour: 24 }));

    const decision = await engine.checkPermission(identity("c4", ["admin"]), perm("table", "read"), {
      sessionId: "s4",
    });

    // The whole UTC day is allowed, so the fallback path cannot deny.
    expect(decision.allowed).toBe(true);
  });

  it("only applies a constraint to its resource and action", async () => {
    engine.addConstraint(constraint("mfa_required", {}, "secret", "read"));

    const other = await engine.checkPermission(identity("c5", ["admin"]), perm("table", "read"), {
      mfaVerified: false,
    });
    const scoped = await engine.checkPermission(identity("c5", ["admin"]), perm("secret", "read"), {
      mfaVerified: false,
    });

    expect(other.allowed).toBe(true);
    expect(scoped.allowed).toBe(false);
  });
});

describe("RBACEngine — IP constraints", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
    engine.registerRole(role("admin", { permissions: [perm("*", "*")] }));
  });

  it("allows when the range list is empty", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: [] }));

    const decision = await engine.checkPermission(identity("i1", ["admin"]), perm("t", "read"), {
      ip: "10.0.0.1",
    });

    expect(decision.allowed).toBe(true);
  });

  it("allows any address for 0.0.0.0/0", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["0.0.0.0/0"] }));

    const decision = await engine.checkPermission(identity("i2", ["admin"]), perm("t", "read"), {
      ip: "203.0.113.9",
    });

    expect(decision.allowed).toBe(true);
  });

  it("matches an exact address", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["10.1.2.3"] }));

    const inside = await engine.checkPermission(identity("i3", ["admin"]), perm("t", "read"), {
      ip: "10.1.2.3",
    });
    const outside = await engine.checkPermission(identity("i4", ["admin"]), perm("t", "read"), {
      ip: "10.1.2.4",
    });

    expect(inside.allowed).toBe(true);
    expect(outside.allowed).toBe(false);
  });

  it("denies a truncated CIDR instead of throwing", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["10.0.0.0/"] }));

    const decision = await engine.checkPermission(identity("i5", ["admin"]), perm("t", "read"), {
      ip: "10.0.0.1",
    });

    expect(decision.allowed).toBe(false);
  });

  it("denies an out-of-range prefix length", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["10.0.0.0/40"] }));

    const decision = await engine.checkPermission(identity("i6", ["admin"]), perm("t", "read"), {
      ip: "10.0.0.1",
    });

    expect(decision.allowed).toBe(false);
  });

  it("treats /0 as a match-all prefix", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["1.2.3.4/0"] }));

    const decision = await engine.checkPermission(identity("i7", ["admin"]), perm("t", "read"), {
      ip: "198.51.100.7",
    });

    expect(decision.allowed).toBe(true);
  });

  it("treats an unparsable address as 0.0.0.0", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["0.0.0.0/32"] }));

    const decision = await engine.checkPermission(identity("i8", ["admin"]), perm("t", "read"), {
      ip: "not-an-ip",
    });

    expect(decision.allowed).toBe(true);
  });

  it("matches a /24 subnet", async () => {
    engine.addConstraint(constraint("ip_range", { ranges: ["192.168.1.0/24"] }));

    const inside = await engine.checkPermission(identity("i9", ["admin"]), perm("t", "read"), {
      ip: "192.168.1.200",
    });
    const outside = await engine.checkPermission(identity("i10", ["admin"]), perm("t", "read"), {
      ip: "192.168.2.1",
    });

    expect(inside.allowed).toBe(true);
    expect(outside.allowed).toBe(false);
  });
});

describe("RBACEngine — scope matching", () => {
  let engine: RBACEngine;

  beforeEach(() => {
    engine = new RBACEngine();
  });

  it("matches a wildcard scope against a dot-separated resource", async () => {
    engine.registerRole(
      role("sales", { permissions: [perm("sales.orders", "read", "sales.*")] }),
    );

    const decision = await engine.checkPermission(identity("s1", ["sales"]), perm("sales.orders", "read"));

    expect(decision.allowed).toBe(true);
  });

  it("falls back to exact matching for an invalid scope pattern", async () => {
    // An unbalanced group would make `new RegExp` throw; the engine must not
    // propagate that failure to the caller.
    engine.registerRole(
      role("broken", { permissions: [perm("table.a", "read", "table.([a-z")] }),
    );

    const exact = await engine.checkPermission(identity("s2", ["broken"]), perm("table.a", "read"));
    const other = await engine.checkPermission(identity("s3", ["broken"]), perm("table.b", "read"));

    expect(exact.allowed).toBe(true);
    expect(other.allowed).toBe(false);
  });
});

describe("RBACEngine — explicit deny", () => {
  it("lets an explicit deny override a wildcard grant", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("admin", { permissions: [perm("*", "*")] }));
    engine.registerRole(role("restricted", { parents: ["admin"], permissions: [perm("secret", "deny:read")] }));

    const decision = await engine.checkPermission(identity("d1", ["restricted"]), perm("secret", "read"));

    expect(decision.allowed).toBe(false);
    expect(decision.deniedByConstraint).toEqual(["explicit_deny"]);
  });

  it("keeps other actions allowed when only one is denied", async () => {
    const engine = new RBACEngine();
    engine.registerRole(role("admin", { permissions: [perm("*", "*")] }));
    engine.registerRole(role("restricted", { parents: ["admin"], permissions: [perm("secret", "deny:read")] }));

    const decision = await engine.checkPermission(identity("d2", ["restricted"]), perm("secret", "write"));

    expect(decision.allowed).toBe(true);
  });
});
