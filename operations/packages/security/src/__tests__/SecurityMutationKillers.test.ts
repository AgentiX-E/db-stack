/**
 * SecurityMutationKillers.test.ts — targeted tests for security-package
 * mutation survivors (Phase 1: small in-memory impls + key manager + AES).
 *
 * Coverage map:
 *   - InMemoryRateLimiter  : resetMs/remaining arithmetic (L30/L31/L36/L37)
 *   - InMemoryTLSManager   : validFrom/validTo date arithmetic (L14/L15/L37/L38)
 *   - AES256GCMEncryption  : minimum-ciphertext-length guard (L87/L89)
 *   - KeyManager           : version-bump on loadKey (L121)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryRateLimiter } from "../impl/InMemoryRateLimiter.js";
import { InMemoryTLSManager } from "../impl/InMemoryTLSManager.js";
import { AES256GCMEncryptionProvider } from "../impl/AES256GCMEncryptionProvider.js";
import { KeyManager } from "../impl/KeyManager.js";

describe("SEC-MK: InMemoryRateLimiter resetMs/remaining arithmetic", () => {
  it("remaining = maxRequests - count (first request)", () => {
    const l = new InMemoryRateLimiter();
    const r = l.check("k", { maxRequests: 3, windowMs: 30_000 });
    expect(r.allowed).toBe(true);
    // `maxRequests - 1` (L24): 3 - 1 = 2. A `-`→`+` mutant yields 4.
    expect(r.remaining).toBe(2);
    expect(r.resetMs).toBe(30_000);
  });

  it("remaining = maxRequests - count (subsequent request)", () => {
    const l = new InMemoryRateLimiter();
    l.check("k", { maxRequests: 3, windowMs: 30_000 });
    const r = l.check("k", { maxRequests: 3, windowMs: 30_000 });
    expect(r.allowed).toBe(true);
    // After count=2, `maxRequests - entry.count` = 3 - 2 = 1 (L38).
    expect(r.remaining).toBe(1);
  });

  it("resetMs = windowMs - elapsed (allowed branch, L36/L37)", () => {
    const l = new InMemoryRateLimiter();
    const cfg = { maxRequests: 5, windowMs: 60_000 };
    l.check("k", cfg);
    // Second check within the same window: elapsed ≈ 0, resetMs ≈ windowMs.
    const r = l.check("k", cfg);
    expect(r.allowed).toBe(true);
    // `windowMs - elapsed` (L37). elapsed is tiny (>=0), so resetMs is close to
    // windowMs. A `-`→`+` mutant yields resetMs ≈ windowMs + 2*now (huge) and a
    // `now - windowStart` `-`→`+` mutant makes elapsed huge → resetMs=0.
    expect(r.resetMs).toBeGreaterThan(55_000);
    expect(r.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("resetMs = max(0, windowMs - elapsed) (blocked branch, L30/L31)", () => {
    const l = new InMemoryRateLimiter();
    const cfg = { maxRequests: 2, windowMs: 60_000 };
    l.check("k", cfg);
    l.check("k", cfg);
    // Third check is blocked; elapsed ≈ 0, resetMs ≈ windowMs (>= 0).
    const r = l.check("k", cfg);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.resetMs).toBeGreaterThan(55_000);
  });

  it("blocked-branch resetMs = windowMs - elapsed with non-zero elapsed (L31)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const l = new InMemoryRateLimiter();
      const cfg = { maxRequests: 1, windowMs: 60_000 };
      l.check("k", cfg); // windowStart = T0
      // Advance 10s → elapsed = 10000
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      const r = l.check("k", cfg);
      expect(r.allowed).toBe(false);
      // resetMs = max(0, 60000 - 10000) = 50000. A `-`→`+` mutant → 70000.
      expect(r.resetMs).toBe(50_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allowed-branch resetMs = windowMs - elapsed with non-zero elapsed (L37)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const l = new InMemoryRateLimiter();
      const cfg = { maxRequests: 5, windowMs: 60_000 };
      l.check("k", cfg); // windowStart = T0, count=1
      // Advance 10s → elapsed = 10000
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      const r = l.check("k", cfg);
      expect(r.allowed).toBe(true);
      // resetMs = max(0, 60000 - 10000) = 50000. A `-`→`+` mutant → 70000.
      expect(r.resetMs).toBe(50_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SEC-MK: InMemoryTLSManager date arithmetic", () => {
  it("validFrom is ~60 days in the past, validTo ~30 days ahead (loadConfig)", async () => {
    const tls = new InMemoryTLSManager();
    await tls.loadConfig({ certPath: "/c.crt", keyPath: "/c.key" } as any);
    const info = await tls.getCertInfo();
    const now = Date.now();
    const DAY = 86_400_000;
    // validFrom = now - 86400000*60 (L14). A `*`→`/` mutant gives only
    // 1440000ms (~24min), so the day-offset assertion distinctly fails.
    const fromOffsetDays = (now - new Date(info.validFrom).getTime()) / DAY;
    expect(fromOffsetDays).toBeCloseTo(60, 1);
    // validTo = now + 86400000*30 (L15). `*`→`/` → ~24min ahead.
    const toOffsetDays = (new Date(info.validTo).getTime() - now) / DAY;
    expect(toOffsetDays).toBeCloseTo(30, 1);
    expect(info.daysRemaining).toBe(30);
  });

  it("reloadCerts: validFrom ~30 days in the past, validTo ~60 days ahead (L37/L38)", async () => {
    const tls = new InMemoryTLSManager();
    await tls.loadConfig({ certPath: "/c.crt", keyPath: "/c.key" } as any);
    await tls.reloadCerts();
    const info = await tls.getCertInfo();
    const now = Date.now();
    const DAY = 86_400_000;
    // reloadCerts sets validFrom = now - 86400000*30 (L37), validTo = now + 86400000*60 (L38).
    // `*`→`/` mutants collapse these to ~24min back/ahead.
    const fromOffsetDays = (new Date(info.validFrom).getTime() - now) / DAY;
    expect(fromOffsetDays).toBeCloseTo(-30, 1);
    const toOffsetDays = (new Date(info.validTo).getTime() - now) / DAY;
    expect(toOffsetDays).toBeCloseTo(60, 1);
    expect(info.daysRemaining).toBe(60);
  });
});

describe("SEC-MK: AES256GCM minimum ciphertext length guard", () => {
  it("rejects ciphertext shorter than version+iv+tag (32B)", async () => {
    const enc = new AES256GCMEncryptionProvider();
    await enc.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" } as any);
    // 16 bytes < KEY_VERSION_PREFIX(4)+IV(12)+TAG(16) = 32.
    // `+`→`-` mutants lower the threshold (4-12+16=8 etc.), so a 16-byte input
    // would wrongly pass. Original throws.
    await expect(enc.decrypt(Buffer.alloc(16))).rejects.toThrow(/too short/i);
  });

  it("error message reports the exact minimum length 32 (L89)", async () => {
    const enc = new AES256GCMEncryptionProvider();
    await enc.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" } as any);
    // The guard already rejects, but the message interpolates
    // `KEY_VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH` = 4+12+16 = 32 (L89).
    // A `+`→`-` mutant changes the message to "minimum 8B" or "minimum 0B".
    await expect(enc.decrypt(Buffer.alloc(8))).rejects.toThrow(/minimum 32B/i);
  });

  it("accepts a 32-byte (empty-plaintext) ciphertext produced by encrypt", async () => {
    const enc = new AES256GCMEncryptionProvider();
    await enc.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" } as any);
    const ct = await enc.encrypt(Buffer.alloc(0));
    // [version 4][iv 12][empty 0][tag 16] = 32 bytes, exactly at the guard.
    expect(ct.length).toBe(32);
    const pt = await enc.decrypt(ct);
    expect(pt.length).toBe(0);
  });
});

describe("SEC-MK: KeyManager version bump on loadKey", () => {
  it("loadKey bumps currentVersion when wrapped.version is higher", async () => {
    const km = new KeyManager({ masterSecret: "mk-secret", iterations: 1000 } as any);
    // Wrap a DEK with an explicit high version.
    const wrapped = await km.wrapKey(Buffer.from("dek-0123456789"), 5);
    const loadedVersion = await km.loadKey(wrapped);
    expect(loadedVersion).toBe(5);
    // `version > this.currentVersion` (L121): a `>`→`<=` mutant never bumps,
    // leaving version at 0.
    expect(km.version).toBe(5);
  });
});
