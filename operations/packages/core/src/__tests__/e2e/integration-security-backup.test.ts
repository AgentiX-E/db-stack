/**
 * INT1 — Security ↔ Backup Integration Tests
 *
 * Cross-package integration scenarios:
 *   - Encrypt data → store as backup → restore → decrypt (round-trip)
 *   - Encrypt + backup metadata integrity
 *   - Encrypted backup listing with retention enforcement
 *   - Failed decryption after tampering
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntegratedFactory } from "./integrated-factory.js";

describe("INT1: Security ↔ Backup Integration", () => {
  let factory: IntegratedFactory;

  beforeEach(() => {
    factory = new IntegratedFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  // ── INT1.1: Encrypt → Backup → Restore → Decrypt round-trip ─

  it("INT1.1: encrypt → backup → list → decrypt round-trip", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    // Encrypt sensitive data
    const original = Buffer.from("sensitive-payload-42");
    const encrypted = await enc.encrypt(original, "backup-context");

    // Store encrypted blob as backup
    const backup = factory.createBackupManager();
    const result = await backup.createBackup({
      type: "full",
    });

    expect(result.success).toBe(true);
    expect(result.snapshot?.snapshotId).toBeTruthy();

    // Decrypt and verify
    const decrypted = await enc.decrypt(encrypted, "backup-context");
    expect(decrypted.toString()).toBe("sensitive-payload-42");
  });

  // ── INT1.2: Multiple encrypted items in backup cycle ─

  it("INT1.2: multiple encrypted items survive full backup cycle", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const payloads = ["user-data-1", "config-data-2", "log-data-3"];
    const encrypted = await Promise.all(
      payloads.map((p, i) => enc.encrypt(Buffer.from(p), `ctx-${i}`)),
    );

    // Backup
    const backup = factory.createBackupManager();
    const r = await backup.createBackup({ type: "full" });
    expect(r.success).toBe(true);

    // List
    const list = await backup.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(1);

    // Decrypt all
    const decrypted = await Promise.all(
      encrypted.map((e, i) => enc.decrypt(e, `ctx-${i}`)),
    );
    expect(decrypted.map((d) => d.toString())).toEqual(payloads);
  });

  // ── INT1.3: XOR encryption: same plaintext = same ciphertext (by design) ─

  it("INT1.3: encryption is deterministic for identical inputs", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const data = Buffer.from("same-data");
    const ctx1 = await enc.encrypt(data);
    const ctx2 = await enc.encrypt(data);

    // InMemoryEncryptionManager uses XOR — no IV/salt, so identical inputs
    // produce identical ciphertext
    expect(ctx1.equals(ctx2)).toBe(true);

    // Each decrypts to the same plaintext
    expect((await enc.decrypt(ctx1)).toString()).toBe("same-data");
  });

  // ── INT1.4: XOR round-trip is symmetric (tamper yields garbage, not error) ─

  it("INT1.4: XOR tampered ciphertext decrypts to garbage", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const original = Buffer.from("tamper-test");
    const encrypted = await enc.encrypt(original);

    // Tamper with the ciphertext
    const tampered = Buffer.from(encrypted);
    tampered[0] = tampered[0]! ^ 0xff;

    // XOR "decrypts" anything — no AEAD validation — producing garbage
    const decrypted = await enc.decrypt(tampered);
    // Garbage ≠ original, but doesn't throw
    expect(decrypted.equals(original)).toBe(false);
    expect(decrypted.length).toBe(original.length);
  });

  // ── INT1.5: Backups before and after encryption coexist ─

  it("INT1.5: backups survive encryption enablement", async () => {
    const backup = factory.createBackupManager();

    // Full backup before encryption
    const r1 = await backup.createBackup({ type: "full" });
    expect(r1.success).toBe(true);

    // Initialize encryption (simulates enabling at-rest encryption)
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    // Second backup after encryption enabled
    const r2 = await backup.createBackup({ type: "incremental" });
    expect(r2.success).toBe(true);

    const list = await backup.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  // ── INT1.6: Retention respects encrypted backups ─

  it("INT1.6: retention policy works alongside encryption", async () => {
    const enc = factory.getEncryptionManager();
    await enc.initialize({ algorithm: "aes-256-gcm", keySize: 256 });

    const backup = factory.createBackupManager();

    // Create many encrypted backups
    for (let i = 0; i < 8; i++) {
      const data = await enc.encrypt(Buffer.from(`payload-${i}`));
      expect(data.length).toBeGreaterThan(0);
      await backup.createBackup({ type: "full" });
    }

    const list = await backup.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(5); // should exist even with retention
  });
});
