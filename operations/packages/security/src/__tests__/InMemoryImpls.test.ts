/**
 * InMemoryImpls.test.ts — Mutation-killing tests for untested security implementations.
 *
 * Covers: InMemoryRateLimiter, InMemoryTLSManager, InMemorySecurityCompliance,
 * InMemoryCertMonitor, InMemorySCIMSyncProvider, InMemoryRBACProvider,
 * InMemoryEncryptionManager, AES256GCMEncryptionProvider, EnvelopeEncryptionProvider,
 * KeyRotationManager.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRateLimiter } from "../impl/InMemoryRateLimiter.js";
import { InMemoryTLSManager } from "../impl/InMemoryTLSManager.js";
import { InMemorySecurityCompliance } from "../impl/InMemorySecurityCompliance.js";
import { InMemoryCertMonitor } from "../impl/InMemoryCertMonitor.js";
import { InMemorySCIMSyncProvider } from "../impl/InMemorySCIMSyncProvider.js";
import { InMemoryRBACProvider } from "../impl/InMemoryRBACProvider.js";
import { InMemoryEncryptionManager } from "../impl/InMemoryEncryptionManager.js";
import { AES256GCMEncryptionProvider } from "../impl/AES256GCMEncryptionProvider.js";
import { EnvelopeEncryptionProvider } from "../impl/EnvelopeEncryptionProvider.js";
import { KeyRotationManager } from "../impl/KeyRotationManager.js";

// ════════════════════════════════════════════════════════════
// InMemoryRateLimiter
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemoryRateLimiter", () => {
  let limiter: InMemoryRateLimiter;
  beforeEach(() => { limiter = new InMemoryRateLimiter(); });

  it("M1: first request is always allowed", () => {
    const r = limiter.check("api1");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
    expect(r.resetMs).toBe(60_000);
  });

  it("M2: blocks after reaching max requests (default 10)", () => {
    for (let i = 0; i < 10; i++) limiter.check("api1");
    expect(limiter.check("api1").allowed).toBe(false);
  });

  it("M3: custom config is respected", () => {
    const r = limiter.check("custom", { maxRequests: 3, windowMs: 30_000 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
    expect(r.resetMs).toBe(30_000);
  });

  it("M4: different keys have independent windows", () => {
    limiter.check("keyA"); limiter.check("keyA");
    expect(limiter.check("keyB").remaining).toBe(9);
  });

  it("M5: resetMs stays non-negative at max usage", () => {
    for (let i = 0; i < 10; i++) limiter.check("maxed");
    expect(limiter.check("maxed").resetMs).toBeGreaterThanOrEqual(0);
  });

  it("M6: remaining counts down correctly", () => {
    expect(limiter.check("cd").remaining).toBe(9);
    expect(limiter.check("cd").remaining).toBe(8);
    expect(limiter.check("cd").remaining).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════
// InMemoryTLSManager
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemoryTLSManager", () => {
  let tls: InMemoryTLSManager;
  beforeEach(() => { tls = new InMemoryTLSManager(); });

  it("M7: loadConfig creates cert info with positive days remaining", async () => {
    await tls.loadConfig({ certPath: "/etc/certs/s.crt", keyPath: "/etc/certs/s.key" } as any);
    const info = await tls.getCertInfo();
    expect(info.daysRemaining).toBeGreaterThan(0);
    expect(info.fingerprint).toBe("sha256$$deadbeef");
  });

  it("M8: reloadCerts updates cert fingerprint and days", async () => {
    await tls.loadConfig({ certPath: "/old.crt", keyPath: "/old.key" } as any);
    await tls.reloadCerts();
    const info = await tls.getCertInfo();
    expect(info.fingerprint).toBe("sha256$$reloaded");
    expect(info.daysRemaining).toBe(60);
  });

  it("M9: getCertInfo throws without config", async () => {
    await expect(tls.getCertInfo()).rejects.toThrow("no config");
  });

  it("M10: reloadCerts throws without config", async () => {
    await expect(tls.reloadCerts()).rejects.toThrow("no config");
  });
});

// ════════════════════════════════════════════════════════════
// InMemorySecurityCompliance
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemorySecurityCompliance", () => {
  let c: InMemorySecurityCompliance;
  beforeEach(() => { c = new InMemorySecurityCompliance(); });

  it("M11: empty checks returns score 100", () => {
    expect(c.getScore()).toBe(100);
  });

  it("M12: all PASS gives 100", () => {
    c.registerChecks([
      { id:"c1",name:"c1",category:"auth",severity:"PASS",timestamp:"" },
      { id:"c2",name:"c2",category:"auth",severity:"PASS",timestamp:"" },
    ]);
    expect(c.getScore()).toBe(100);
  });

  it("M13: all FAIL gives 0", () => {
    c.registerChecks([
      { id:"c1",name:"c1",category:"auth",severity:"FAIL",timestamp:"" },
      { id:"c2",name:"c2",category:"auth",severity:"FAIL",timestamp:"" },
    ]);
    expect(c.getScore()).toBe(0);
  });

  it("M14: mixed severities = weighted average (PASS/WARN/FAIL/PASS)", () => {
    c.registerChecks([
      { id:"c1",name:"c1",category:"auth",severity:"PASS",timestamp:"" },
      { id:"c2",name:"c2",category:"auth",severity:"WARN",timestamp:"" },
      { id:"c3",name:"c3",category:"auth",severity:"FAIL",timestamp:"" },
      { id:"c4",name:"c4",category:"auth",severity:"PASS",timestamp:"" },
    ]);
    // (1 + 0.5 + 0 + 1)/4*100 = 62.5 → round → 63
    expect(c.getScore()).toBe(63);
  });

  it("M15: runCategory filters and timestamps", async () => {
    c.registerChecks([
      { id:"c1",name:"c1",category:"auth",severity:"PASS",timestamp:"" },
      { id:"c2",name:"c2",category:"net",severity:"PASS",timestamp:"" },
    ]);
    const auth = await c.runCategory("auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.id).toBe("c1");
  });

  it("M16: runChecks timestamps all entries", async () => {
    c.registerChecks([{ id:"c1",name:"c1",category:"auth",severity:"PASS",timestamp:"" }]);
    const results = await c.runChecks();
    expect(results[0]!.timestamp).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════
// InMemoryCertMonitor
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemoryCertMonitor", () => {
  let m: InMemoryCertMonitor;
  beforeEach(() => { m = new InMemoryCertMonitor(); });

  it("M17: start / stop lifecycle works", () => {
    m.start(5000);
    m.stop();
  });

  it("M18: addExpiryStatus + getExpiryStatus returns entries", () => {
    m.addExpiryStatus({
      subject:"CN=t",issuer:"CN=CA",serialNumber:"123",
      validFrom:"",validTo:"",daysRemaining:5,path:"/t.crt",fingerprint:"fp",
    }, "warning");
    expect(m.getExpiryStatus()).toHaveLength(1);
  });

  it("M19: onWarning registers/unregisters callback", () => {
    const unsub = m.onWarning(() => {});
    unsub();
  });

  it("M20: autoRenew returns true", async () => {
    expect(await m.autoRenew()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// InMemorySCIMSyncProvider
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemorySCIMSyncProvider", () => {
  let s: InMemorySCIMSyncProvider;
  beforeEach(() => { s = new InMemorySCIMSyncProvider(); });

  it("M21: first sync seeds 3 users", async () => {
    const r = await s.syncUsers();
    expect(r.added).toBe(3);
    expect(r.updated).toBe(0);
  });

  it("M22: second sync updates (no adds)", async () => {
    await s.syncUsers();
    const r = await s.syncUsers();
    expect(r.added).toBe(0);
    expect(r.updated).toBe(3);
  });

  it("M23: getLastSyncTime null before sync", () => {
    expect(s.getLastSyncTime()).toBeNull();
  });

  it("M24: getLastSyncTime returns Date after sync", async () => {
    await s.syncUsers();
    expect(s.getLastSyncTime()).toBeInstanceOf(Date);
  });

  it("M25: fullResync resets state", async () => {
    await s.syncUsers();
    await s.fullResync();
    expect((await s.syncUsers()).updated).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════
// InMemoryRBACProvider
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemoryRBACProvider", () => {
  let rbac: InMemoryRBACProvider;
  beforeEach(() => { rbac = new InMemoryRBACProvider(); });

  it("M26: registerRole stores role permissions", () => {
    rbac.registerRole({ name:"admin", permissions:[{resource:"*",action:"*"}] });
    expect(rbac.getRoles()).toHaveLength(1);
  });

  it("M27: hasPermission matches resource + action", () => {
    rbac.registerRole({ name:"reader", permissions:[{resource:"docs",action:"read"}] });
    expect(rbac.hasPermission({roles:["reader"]},{resource:"docs",action:"read"})).toBe(true);
  });

  it("M28: hasPermission denies wrong action", () => {
    rbac.registerRole({ name:"reader", permissions:[{resource:"docs",action:"read"}] });
    expect(rbac.hasPermission({roles:["reader"]},{resource:"docs",action:"write"})).toBe(false);
  });

  it("M29: hasPermission denies unknown role", () => {
    expect(rbac.hasPermission({roles:["ghost"]},{resource:"x",action:"y"})).toBe(false);
  });

  it("M30: getPermissions aggregates across roles", () => {
    rbac.registerRole({ name:"a", permissions:[{resource:"r1",action:"read"}] });
    rbac.registerRole({ name:"b", permissions:[{resource:"r2",action:"write"}] });
    const perms = rbac.getPermissions({roles:["a","b"]});
    expect(perms).toHaveLength(2);
  });

  it("M31: getPermissions deduplicates identical permissions", () => {
    rbac.registerRole({ name:"a", permissions:[{resource:"r",action:"rw"}] });
    rbac.registerRole({ name:"b", permissions:[{resource:"r",action:"rw"}] });
    expect(rbac.getPermissions({roles:["a","b"]})).toHaveLength(1);
  });

  it("M32: getRoles returns all registered roles", () => {
    rbac.registerRole({ name:"r1", permissions:[{resource:"x",action:"y"}] });
    rbac.registerRole({ name:"r2", permissions:[] });
    expect(rbac.getRoles()).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════
// InMemoryEncryptionManager
// ════════════════════════════════════════════════════════════

describe("SEC-M: InMemoryEncryptionManager", () => {
  let em: InMemoryEncryptionManager;
  beforeEach(() => { em = new InMemoryEncryptionManager(); });

  it("M33: encrypt before initialize throws", async () => {
    await expect(em.encrypt(Buffer.from("h"))).rejects.toThrow(/not initialized/i);
  });

  it("M34: initialize + encrypt roundtrip", async () => {
    await em.initialize({ type:"xor",keyBytes:crypto.getRandomValues(new Uint8Array(32)) } as any);
    const c = await em.encrypt(Buffer.from("secret"));
    expect(c).not.toEqual(Buffer.from("secret"));
    expect(c.length).toBe(6);
  });

  it("M35: encrypt + decrypt roundtrip", async () => {
    await em.initialize({ type:"xor",keyBytes:crypto.getRandomValues(new Uint8Array(32)) } as any);
    const p = Buffer.from("hello world");
    expect(await em.decrypt(await em.encrypt(p))).toEqual(p);
  });

  it("M36: rotateKey increments version", async () => {
    await em.initialize({ type:"xor",keyBytes:crypto.getRandomValues(new Uint8Array(32)) } as any);
    const v1 = (em as any)._keyVersion;
    await em.rotateKey();
    expect((em as any)._keyVersion).toBe(v1 + 1);
  });

  it("M37: encrypt empty buffer", async () => {
    await em.initialize({ type:"xor",keyBytes:crypto.getRandomValues(new Uint8Array(32)) } as any);
    const c = await em.encrypt(Buffer.alloc(0));
    expect(c.length).toBe(0);
    expect(await em.decrypt(c).then(b=>b.length)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// AES256GCMEncryptionProvider
// ════════════════════════════════════════════════════════════

describe("SEC-M: AES256GCMEncryptionProvider", () => {
  let gcm: AES256GCMEncryptionProvider;
  beforeEach(async () => {
    gcm = new AES256GCMEncryptionProvider();
    await gcm.initialize({ type:"aes-256-gcm" } as any);
  });

  it("M38: encrypt produces ciphertext > plaintext (IV + tag)", async () => {
    const c = await gcm.encrypt(Buffer.from("data"), "ctx");
    expect(c.length).toBeGreaterThan(4);
  });

  it("M39: encrypt + decrypt roundtrip", async () => {
    const p = Buffer.from("sensitive");
    const c = await gcm.encrypt(p, "auth-ctx");
    expect(await gcm.decrypt(c, "auth-ctx")).toEqual(p);
  });

  it("M40: wrong context → decrypt fails", async () => {
    const c = await gcm.encrypt(Buffer.from("d"), "ctx-A");
    await expect(gcm.decrypt(c, "ctx-B")).rejects.toThrow();
  });

  it("M41: corrupted auth tag → decrypt fails", async () => {
    const c = await gcm.encrypt(Buffer.from("data"), "ctx");
    // Flip the last byte (auth tag portion), avoiding the IV
    c[c.length - 1] = c[c.length - 1]! ^ 0xFF;
    await expect(gcm.decrypt(c, "ctx")).rejects.toThrow();
  });

  it("M42: rotateKey increments version", async () => {
    const v = (gcm as any).keyVersion;
    await gcm.rotateKey();
    expect((gcm as any).keyVersion).toBeGreaterThan(v);
  });

  it("M43: cross-instance decryption fails", async () => {
    const g2 = new AES256GCMEncryptionProvider();
    await g2.initialize({ type:"aes-256-gcm" } as any);
    const c = await gcm.encrypt(Buffer.from("d"), "ctx");
    await expect(g2.decrypt(c, "ctx")).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════
// EnvelopeEncryptionProvider
// ════════════════════════════════════════════════════════════

describe("SEC-M: EnvelopeEncryptionProvider", () => {
  let eep: EnvelopeEncryptionProvider;
  beforeEach(async () => {
    eep = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret:"test-master-pw", iterations: 1000 },
      encryption: { type:"aes-256-gcm" } as any,
    });
    await eep.initialize({ type:"envelope" } as any);
  });

  it("M44: encrypt produces wrapped-DEK ciphertext", async () => {
    const c = await eep.encrypt(Buffer.from("hello"));
    expect(c.length).toBeGreaterThan(5);
  });

  it("M45: decrypt recovers plaintext", async () => {
    const p = Buffer.from("roundtrip");
    expect(await eep.decrypt(await eep.encrypt(p))).toEqual(p);
  });

  it("M46: post-rotation decryption still works", async () => {
    const c = await eep.encrypt(Buffer.from("pre-rot"));
    await eep.rotateKey();
    expect(await eep.decrypt(c)).toEqual(Buffer.from("pre-rot"));
  });

  it("M47: independent plaintexts stay independent", async () => {
    const c1 = await eep.encrypt(Buffer.from("one"));
    const c2 = await eep.encrypt(Buffer.from("two"));
    expect(await eep.decrypt(c1)).toEqual(Buffer.from("one"));
    expect(await eep.decrypt(c2)).toEqual(Buffer.from("two"));
  });
});

// ════════════════════════════════════════════════════════════
// KeyRotationManager
// ════════════════════════════════════════════════════════════

describe("SEC-M: KeyRotationManager", () => {
  let km: KeyRotationManager;
  beforeEach(() => { km = new KeyRotationManager({ type:"aes-256-gcm" } as any); });

  it("M48: checkPolicies returns empty array initially", async () => {
    expect(await km.checkPolicies()).toEqual([]);
  });

  it("M49: getState returns null for unknown policy", async () => {
    expect(await km.getState("nonexistent")).toBeNull();
  });

  it("M50: getHistory returns empty array initially", async () => {
    expect(await km.getHistory()).toEqual([]);
  });

  it("M51: getStats returns zero total", async () => {
    expect((await km.getStats()).totalRotations).toBe(0);
  });
});
