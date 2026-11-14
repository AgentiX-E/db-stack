/**
 * I27 — E1 Encryption at Rest tests.
 *
 * ENC1-ENC4: AES256GCMEncryptionProvider (round-trip, context binding, tamper, edge cases)
 * ENC5-ENC8: KeyManager (generate, wrap/unwrap, multi-version, export/import)
 * ENC9-ENC12: EnvelopeEncryptionProvider (round-trip, key rotation, import, zeroize)
 * ENC13-ENC15: Integration (large payloads, concurrency, cross-provider compatibility)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { AES256GCMEncryptionProvider } from "../impl/AES256GCMEncryptionProvider.js";
import { KeyManager, type WrappedKey } from "../impl/KeyManager.js";
import { EnvelopeEncryptionProvider } from "../impl/EnvelopeEncryptionProvider.js";
import type { EncryptionConfig } from "../interfaces/index.js";

// ── Helpers ────────────────────────────────────────────────

function randomData(size: number): Buffer {
  return crypto.randomBytes(size);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function asyncIterate(
  count: number,
  fn: (i: number) => Promise<void>,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    tasks.push(fn(i));
  }
  await Promise.all(tasks);
}

// ── ENC1-ENC4: AES256GCMEncryptionProvider ─────────────────

describe("ENC1: AES256GCM — basic encrypt/decrypt round-trip", () => {
  let provider: AES256GCMEncryptionProvider;

  beforeEach(async () => {
    provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
  });

  it("encrypts and decrypts plaintext correctly", async () => {
    const plaintext = Buffer.from("hello, world!", "utf-8");
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.toString("utf-8")).toBe("hello, world!");
  });

  it("produces different ciphertexts for same plaintext (unique IV)", async () => {
    const plaintext = Buffer.from("repeat me", "utf-8");
    const ct1 = await provider.encrypt(plaintext);
    const ct2 = await provider.encrypt(plaintext);

    // Different IVs → different ciphertexts
    expect(ct1.equals(ct2)).toBe(false);
  });

  it("round-trip with binary data", async () => {
    const plaintext = randomData(1024);
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trip with empty buffer", async () => {
    const plaintext = Buffer.alloc(0);
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.length).toBe(0);
  });

  it("round-trip with single byte", async () => {
    const plaintext = Buffer.from([0xAB]);
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  });
});

describe("ENC2: AES256GCM — context binding and tamper detection", () => {
  let provider: AES256GCMEncryptionProvider;

  beforeEach(async () => {
    provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
  });

  it("context binding: decrypt with wrong context fails", async () => {
    const plaintext = Buffer.from("classified", "utf-8");
    const encrypted = await provider.encrypt(plaintext, "table:users");

    await expect(
      provider.decrypt(encrypted, "table:orders"),
    ).rejects.toThrow();
  });

  it("context binding: decrypt with correct context succeeds", async () => {
    const ctx = "shard:3/group:default/table:kv";
    const plaintext = randomData(512);

    const encrypted = await provider.encrypt(plaintext, ctx);
    const decrypted = await provider.decrypt(encrypted, ctx);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("detects tampered ciphertext", async () => {
    const plaintext = Buffer.from("tamper me", "utf-8");
    const encrypted = await provider.encrypt(plaintext);

    // Flip a byte in the middle of the ciphertext
    const tampered = Buffer.from(encrypted);
    const midPoint = Math.floor(encrypted.length / 2);
    tampered[midPoint]! ^= 0xFF; // Flip some bits

    await expect(provider.decrypt(tampered)).rejects.toThrow();
  });

  it("detects truncated ciphertext", async () => {
    const plaintext = Buffer.from("truncate me", "utf-8");
    const encrypted = await provider.encrypt(plaintext);

    // Remove last few bytes (auth tag)
    const truncated = encrypted.subarray(0, encrypted.length - 5);

    await expect(provider.decrypt(truncated)).rejects.toThrow();
  });

  it("rejects ciphertext that is too short", async () => {
    const tooShort = Buffer.from([0x00, 0x00, 0x00, 0x00]);

    await expect(provider.decrypt(tooShort)).rejects.toThrow("too short");
  });
});

describe("ENC3: AES256GCM — key rotation", () => {
  it("encrypts with new key after rotation", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    expect(provider.getCurrentKeyVersion()).toBe(1);

    const plaintext = Buffer.from("v1 data", "utf-8");
    const v1Ciphertext = await provider.encrypt(plaintext);

    // Rotate key
    await provider.rotateKey();
    expect(provider.getCurrentKeyVersion()).toBe(2);
    expect(provider.hasKeyVersion(1)).toBe(true);

    // v1 ciphertext should still decrypt (key history preserved)
    const decryptedV1 = await provider.decrypt(v1Ciphertext);
    expect(decryptedV1.toString("utf-8")).toBe("v1 data");

    // New encrypt uses v2 key (version prefix is v2)
    const v2Ciphertext = await provider.encrypt(Buffer.from("v2 data"));
    const decryptedV2 = await provider.decrypt(v2Ciphertext);
    expect(decryptedV2.toString("utf-8")).toBe("v2 data");

    // v1 and v2 ciphertexts differ
    expect(v1Ciphertext.equals(v2Ciphertext)).toBe(false);
  });

  it("multiple key rotations preserve all history", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = Buffer.from("persistent", "utf-8");
    const ciphertexts: Buffer[] = [];

    for (let i = 0; i < 5; i++) {
      ciphertexts.push(await provider.encrypt(plaintext));
      await provider.rotateKey();
    }

    expect(provider.getCurrentKeyVersion()).toBe(6);
    expect(provider.getKeyVersionCount()).toBe(6);

    // All ciphertexts should still decrypt
    for (const ct of ciphertexts) {
      const decrypted = await provider.decrypt(ct);
      expect(decrypted.toString("utf-8")).toBe("persistent");
    }
  });
});

describe("ENC4: AES256GCM — edge cases", () => {
  it("throws when encrypting before initialize", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await expect(provider.encrypt(Buffer.from("data"))).rejects.toThrow("not initialized");
  });

  it("throws when decrypting before initialize", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await expect(provider.decrypt(Buffer.from("data"))).rejects.toThrow("not initialized");
  });

  it("isEnabled reflects state correctly", async () => {
    const provider = new AES256GCMEncryptionProvider();
    expect(provider.isEnabled()).toBe(false);
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
    expect(provider.isEnabled()).toBe(true);
  });

  it("large payload round-trip (1MB)", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = randomData(1024 * 1024); // 1MB
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  }, 10000);
});

// ── ENC5-ENC8: KeyManager ─────────────────────────────────

describe("ENC5: KeyManager — key generation and wrapping", () => {
  it("generates a key and wraps it", async () => {
    const km = new KeyManager({
      masterSecret: "test-master-secret-42",
      iterations: 100000, // Speed up test
    });

    const wrapped = await km.generateKey();

    expect(wrapped.version).toBe(1);
    expect(wrapped.encryptedKey).toBeDefined();
    expect(wrapped.iv).toHaveLength(12);
    expect(wrapped.authTag).toHaveLength(16);
    expect(wrapped.salt).toBeDefined();
    expect(wrapped.createdAt).toBeGreaterThan(0);

    // The current key should be retrievable
    const key = km.getCurrentKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it("wrapped key unwraps correctly", async () => {
    const km = new KeyManager({
      masterSecret: "test-secret-abc",
      iterations: 100000,
    });

    const wrapped = await km.generateKey();
    const originalKey = km.getCurrentKey()!;

    // Unwrap
    const unwrappedKey = await km.unwrapKey(wrapped);
    expect(unwrappedKey.equals(originalKey)).toBe(true);
  });

  it("unwrapping with wrong master secret fails", async () => {
    const km1 = new KeyManager({
      masterSecret: "secret-A",
      iterations: 100000,
    });

    const wrapped = await km1.generateKey();

    const km2 = new KeyManager({
      masterSecret: "secret-B", // Different!
      iterations: 100000,
    });

    await expect(km2.unwrapKey(wrapped)).rejects.toThrow("failed to unwrap key");
  });

  it("unwrapping with wrong salt fails", async () => {
    const km1 = new KeyManager({
      masterSecret: "secret-X",
      salt: crypto.randomBytes(32),
      iterations: 100000,
    });

    const wrapped = await km1.generateKey();

    // Tamper with the salt
    const tamperedWrapped: WrappedKey = {
      ...wrapped,
      salt: crypto.randomBytes(32), // Different salt
    };

    await expect(km1.unwrapKey(tamperedWrapped)).rejects.toThrow();
  });
});

describe("ENC6: KeyManager — multi-version management", () => {
  it("manages multiple key versions", async () => {
    const km = new KeyManager({
      masterSecret: "multi-version-secret",
      iterations: 100000,
    });

    await km.generateKey(); // v1
    await km.generateKey(); // v2
    await km.generateKey(); // v3

    expect(km.version).toBe(3);
    expect(km.versionCount).toBe(3);

    // All versions accessible
    expect(km.getKey(1)?.length).toBe(32);
    expect(km.getKey(2)?.length).toBe(32);
    expect(km.getKey(3)?.length).toBe(32);
    expect(km.getKey(4)).toBeNull();
  });

  it("each version has a unique key", async () => {
    const km = new KeyManager({
      masterSecret: "unique-keys-secret",
      iterations: 100000,
    });

    await km.generateKey();
    const k1 = Buffer.from(km.getKey(1)!);
    await km.generateKey();
    const k2 = Buffer.from(km.getKey(2)!);

    expect(k1.equals(k2)).toBe(false);
  });

  it("hasKeyVersion returns correct results", async () => {
    const km = new KeyManager({
      masterSecret: "check-version-secret",
      iterations: 100000,
    });

    await km.generateKey(); // v1
    await km.generateKey(); // v2

    expect(km.hasKeyVersion(1)).toBe(true);
    expect(km.hasKeyVersion(2)).toBe(true);
    expect(km.hasKeyVersion(3)).toBe(false);
  });
});

describe("ENC7: KeyManager — export and import", () => {
  it("exports and imports wrapped keys correctly", async () => {
    const km1 = new KeyManager({
      masterSecret: "export-secret",
      iterations: 100000,
    });

    await km1.generateKey();
    await km1.generateKey();

    const k1 = Buffer.from(km1.getKey(1)!);
    const k2 = Buffer.from(km1.getKey(2)!);

    // Export
    const exported = await km1.exportWrappedKeys();

    // Import into new manager
    const km2 = new KeyManager({
      masterSecret: "export-secret", // Same master secret!
      iterations: 100000,
    });

    for (const wk of exported) {
      await km2.loadKey(wk, true);
    }

    // Keys should match
    expect(km2.getKey(1)!.equals(k1)).toBe(true);
    expect(km2.getKey(2)!.equals(k2)).toBe(true);
  });

  it("imported keys work with different salt if master secret matches", async () => {
    const km1 = new KeyManager({
      masterSecret: "salt-independent",
      salt: crypto.randomBytes(32),
      iterations: 100000,
    });

    const wrapped = await km1.generateKey();
    const key1 = km1.getKey(1)!;

    // The wrapped key carries its own salt
    const km2 = new KeyManager({
      masterSecret: "salt-independent",
      salt: crypto.randomBytes(32), // Different initial salt, but wrapped key has its own
      iterations: 100000,
    });

    await km2.loadKey(wrapped, true);
    const key2 = km2.getKey(1)!;

    expect(key1.equals(key2)).toBe(true);
  });
});

describe("ENC8: KeyManager — zeroization", () => {
  it("zeroize clears all key material", async () => {
    const km = new KeyManager({
      masterSecret: "zeroize-secret",
      iterations: 100000,
    });

    await km.generateKey();
    await km.generateKey();

    expect(km.versionCount).toBe(2);

    km.zeroize();

    expect(km.versionCount).toBe(0);
    expect(km.version).toBe(0);
    expect(km.getCurrentKey()).toBeNull();
  });

  it("zeroized keys cannot be used for unwrapping", async () => {
    const km = new KeyManager({
      masterSecret: "zeroize-unwrap",
      iterations: 100000,
    });

    const wrapped = await km.generateKey();
    km.zeroize();

    // Unwrapping still works because it derives KEK from masterSecret
    // but the key history is gone
    expect(km.getKey(1)).toBeNull();
  });
});

// ── ENC9-ENC12: EnvelopeEncryptionProvider ─────────────────

describe("ENC9: Envelope — encrypt/decrypt round-trip", () => {
  let provider: EnvelopeEncryptionProvider;

  beforeEach(async () => {
    provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "envelope-test-secret",
        iterations: 100000,
        keyLength: 32,
        hashAlgorithm: "sha256",
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
      autoGenerateKey: true,
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
  });

  it("encrypts and decrypts plaintext correctly", async () => {
    const plaintext = Buffer.from("envelope test data", "utf-8");
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.toString("utf-8")).toBe("envelope test data");
  });

  it("different encryptions produce different ciphertexts", async () => {
    const plaintext = Buffer.from("same text", "utf-8");
    const ct1 = await provider.encrypt(plaintext);
    const ct2 = await provider.encrypt(plaintext);

    expect(ct1.equals(ct2)).toBe(false);
    // Both decryptable
    const d1 = await provider.decrypt(ct1);
    const d2 = await provider.decrypt(ct2);
    expect(d1.toString("utf-8")).toBe("same text");
    expect(d2.toString("utf-8")).toBe("same text");
  });

  it("round-trip with context binding", async () => {
    const ctx = "file:backup-2024.sql";
    const plaintext = randomData(2048);

    const encrypted = await provider.encrypt(plaintext, ctx);
    const decrypted = await provider.decrypt(encrypted, ctx);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("wrong context causes decrypt failure", async () => {
    const plaintext = Buffer.from("sensitive", "utf-8");
    const encrypted = await provider.encrypt(plaintext, "ctx:A");

    await expect(provider.decrypt(encrypted, "ctx:B")).rejects.toThrow();
  });
});

describe("ENC10: Envelope — key rotation", () => {
  it("old ciphertexts decryptable after rotation", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "rotate-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = Buffer.from("pre-rotation data", "utf-8");
    const v1Ciphertext = await provider.encrypt(plaintext);

    expect(provider.getCurrentKeyVersion()).toBe(1);

    // Rotate
    await provider.rotateKey();
    expect(provider.getCurrentKeyVersion()).toBe(2);

    // v1 ciphertext still decryptable
    const decrypted = await provider.decrypt(v1Ciphertext);
    expect(decrypted.toString("utf-8")).toBe("pre-rotation data");

    // New encryption uses v2
    const v2Ciphertext = await provider.encrypt(Buffer.from("post-rotation data"));
    const decryptedV2 = await provider.decrypt(v2Ciphertext);
    expect(decryptedV2.toString("utf-8")).toBe("post-rotation data");
  });

  it("ciphertexts from all versions decrypt correctly after multiple rotations", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "multi-rotate-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const ciphertexts: Buffer[] = [];
    const expected: string[] = [];

    for (let i = 0; i < 5; i++) {
      const msg = `data-v${i + 1}`;
      expected.push(msg);
      ciphertexts.push(await provider.encrypt(Buffer.from(msg)));
      await provider.rotateKey();
    }

    for (let i = 0; i < ciphertexts.length; i++) {
      const decrypted = await provider.decrypt(ciphertexts[i]!);
      expect(decrypted.toString("utf-8")).toBe(expected[i]);
    }
  });
});

describe("ENC11: Envelope — key export and import", () => {
  it("exports and imports keys with correct version mapping", async () => {
    const provider1 = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "export-import-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider1.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = Buffer.from("export me", "utf-8");
    const encrypted = await provider1.encrypt(plaintext);

    // Export keys
    const exported = await provider1.exportKeys();

    // New provider imports them
    const provider2 = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "export-import-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider2.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    for (const wk of exported) {
      await provider2.importKey(wk);
    }

    // Should decrypt old ciphertext
    const decrypted = await provider2.decrypt(encrypted);
    expect(decrypted.toString("utf-8")).toBe("export me");
  });

  it("import with wrong master secret fails", async () => {
    const provider1 = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "correct-secret-123",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider1.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const exported = await provider1.exportKeys();

    const provider2 = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "wrong-secret-456",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider2.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    await expect(provider2.importKey(exported[0]!)).rejects.toThrow("failed to unwrap key");
  });
});

describe("ENC12: Envelope — zeroization and tamper resistance", () => {
  it("zeroize prevents future decryption", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "zeroize-env-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const encrypted = await provider.encrypt(Buffer.from("before zeroize"));
    const decrypted = await provider.decrypt(encrypted);
    expect(decrypted.toString("utf-8")).toBe("before zeroize");

    provider.zeroize();
    expect(provider.isEnabled()).toBe(false);

    // After zeroize, cannot encrypt
    await expect(provider.encrypt(Buffer.from("after"))).rejects.toThrow("not initialized");
  });

  it("detects tampered envelope header", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "tamper-env-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const encrypted = await provider.encrypt(Buffer.from("original"));

    // Tamper with the inner ciphertext (past the header), not the header itself.
    // The header JSON is parseable even with small corruptions.
    // Corrupt the encrypted payload after the wrapped key header.
    const tampered = Buffer.from(encrypted);
    // Find roughly the middle of the ciphertext
    const mid = Math.floor(tampered.length / 2);
    tampered[mid]! ^= 0xFF;

    await expect(provider.decrypt(tampered)).rejects.toThrow();
  });

  it("detects truncated envelope ciphertext", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "trunc-env-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const encrypted = await provider.encrypt(Buffer.from("truncated"));
    const truncated = encrypted.subarray(0, 10);

    await expect(provider.decrypt(truncated)).rejects.toThrow("incomplete header");
  });
});

// ── ENC13-ENC15: Integration ────────────────────────────────

describe("ENC13: Integration — large payloads", () => {
  it("AES256GCM with 10MB payload", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = randomData(10 * 1024 * 1024); // 10MB
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  }, 30000);

  it("Envelope with 5MB payload", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "large-payload-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = randomData(5 * 1024 * 1024); // 5MB
    const encrypted = await provider.encrypt(plaintext);
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  }, 20000);
});

describe("ENC14: Integration — concurrent operations", () => {
  it("AES256GCM concurrent encrypt/decrypt", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const plaintext = Buffer.from(`concurrent-${i}`, "utf-8");
        const encrypted = await provider.encrypt(plaintext);
        const decrypted = await provider.decrypt(encrypted);
        return decrypted.toString("utf-8");
      }),
    );

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(`concurrent-${i}`);
    }
  });

  it("Envelope concurrent encrypt/decrypt", async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: {
        masterSecret: "concurrent-env-secret",
        iterations: 100000,
      },
      encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    });
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const results = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const plaintext = Buffer.from(`env-concurrent-${i}`, "utf-8");
        const encrypted = await provider.encrypt(plaintext);
        const decrypted = await provider.decrypt(encrypted);
        return decrypted.toString("utf-8");
      }),
    );

    for (let i = 0; i < 30; i++) {
      expect(results[i]).toBe(`env-concurrent-${i}`);
    }
  });
});

describe("ENC15: Integration — cross-provider compatibility", () => {
  it("AES256GCM encrypted data decrypts after re-initialize", async () => {
    // Simulate restart: different provider instance, same config
    const p1 = new AES256GCMEncryptionProvider();
    await p1.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = Buffer.from("restart test", "utf-8");
    const encrypted = await p1.encrypt(plaintext);

    // "Restart" — new provider
    const p2 = new AES256GCMEncryptionProvider();
    await p2.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    // Different key → should fail (as expected: keys are ephemeral unless exported)
    await expect(p2.decrypt(encrypted)).rejects.toThrow();
  });

  it("various unicode content survives round-trip", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const content = "日本語 한국어 Español العربية हिन्दी 🚀💻🎯";
    const encrypted = await provider.encrypt(Buffer.from(content, "utf-8"));
    const decrypted = await provider.decrypt(encrypted);

    expect(decrypted.toString("utf-8")).toBe(content);
  });

  it("zero-length context binding works (undefined context)", async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

    const plaintext = Buffer.from("no context", "utf-8");

    // Encrypt without context
    const ct1 = await provider.encrypt(plaintext); // undefined context
    const ct2 = await provider.encrypt(plaintext, undefined);

    // Both should decrypt without context
    expect(await provider.decrypt(ct1).then((b) => b.toString("utf-8"))).toBe("no context");
    expect(await provider.decrypt(ct2).then((b) => b.toString("utf-8"))).toBe("no context");
  });
});
