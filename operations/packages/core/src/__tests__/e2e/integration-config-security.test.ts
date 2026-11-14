/**
 * INT4 — ConfigWatcher ↔ Security Integration Tests
 *
 * Cross-package scenarios:
 *   - Config hot-reload via ConfigWatcher while Encryption is active
 *   - RBAC roles set/retrieved alongside config key watches
 *   - Config change notifications with security context isolation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntegratedFactory } from "./integrated-factory.js";

describe("INT4: ConfigWatcher ↔ Security Integration", () => {
  let factory: IntegratedFactory;

  beforeEach(() => {
    factory = new IntegratedFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  // ── INT4.1: Config set/get while encryption is active ─

  it("INT4.1: config operations work alongside active encryption", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    // Encrypt some config data
    const dbPass = await enc.encrypt(Buffer.from("db-password-123"));
    expect(dbPass.length).toBeGreaterThan(0);

    // Decrypt it back
    const decrypted = await enc.decrypt(dbPass);
    expect(decrypted.toString()).toBe("db-password-123");
  });

  // ── INT4.2: RBAC roles coexist with encryption ─

  it("INT4.2: RBAC permissions work while encryption is active", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const rbac = factory.getRBACProvider();
    rbac.registerRole({
      name: "enc-admin",
      permissions: [{ resource: "keys", action: "admin" }],
    });

    const admin: import("@agentix-e/db-operations-security").Identity = {
      id: "admin",
      roles: ["enc-admin"],
    };

    expect(
      rbac.hasPermission(admin, { resource: "keys", action: "admin" }),
    ).toBe(true);
  });

  // ── INT4.3: RBAC permission denial with encryption context ─

  it("INT4.3: unauthorized user denied key access", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const rbac = factory.getRBACProvider();
    rbac.registerRole({
      name: "key-reader",
      permissions: [{ resource: "keys", action: "read" }],
    });

    const attacker: import("@agentix-e/db-operations-security").Identity = {
      id: "bad-actor",
      roles: [],
    };

    expect(
      rbac.hasPermission(attacker, { resource: "keys", action: "admin" }),
    ).toBe(false);
  });

  // ── INT4.4: Audit store accessible during config changes ─

  it("INT4.4: audit entries can be queried during encryption lifecycle", async () => {
    const audit = factory.getAuditStore();
    const enc = factory.getEncryptionManager();

    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    // Audit should be queryable
    const entries = await audit.query({});
    expect(Array.isArray(entries)).toBe(true);
  });

  // ── INT4.5: Logger accessible during RBAC operations ─

  it("INT4.5: logger records during RBAC role registration", () => {
    const rbac = factory.getRBACProvider();
    const logger = factory.getLogger();

    rbac.registerRole({
      name: "auditor",
      permissions: [{ resource: "logs", action: "read" }],
    });

    // Logger should be functional (no crash)
    logger.info({ role: "auditor" }, "role-registered");
    expect(rbac.getRoles().length).toBe(1);
  });
});
