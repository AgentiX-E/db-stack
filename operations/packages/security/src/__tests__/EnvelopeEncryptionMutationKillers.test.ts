/**
 * EnvelopeEncryptionMutationKillers.test.ts — targeted tests for
 * EnvelopeEncryptionProvider mutation survivors (4).
 *
 *   L55  enabled = false (default) → isEnabled() before initialize
 *   L129 incomplete-header guard (HEADER_PREFIX + wrappedKeyLen + 12)
 *   L196 canDecryptVersion OR-chain
 *   L235 data-too-short guard (12 + 16)
 */
import { describe, it, expect } from "vitest";
import { EnvelopeEncryptionProvider } from "../impl/EnvelopeEncryptionProvider.js";

function makeProvider(autoGenerateKey = true): EnvelopeEncryptionProvider {
  return new EnvelopeEncryptionProvider({
    keyManager: {
      masterSecret: "envelope-mk-secret",
      iterations: 100000,
      keyLength: 32,
      hashAlgorithm: "sha256",
    },
    encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
    autoGenerateKey,
  });
}

describe("ENC-MK: envelope mutation killers", () => {
  it("L55: isEnabled() is false before initialize", async () => {
    const p = makeProvider(false);
    // `private enabled = false` — a `false`→`true` mutant would report enabled.
    expect(p.isEnabled()).toBe(false);
    await p.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
  });

  it("L129: rejects an incomplete header (both `+` operators)", async () => {
    const p = makeProvider(true);
    await p.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
    // Header prefix is 4 bytes (uint32 wrapped-key length). Use a small claimed
    // length (10) so the guard `ciphertext.length < 4 + wrappedKeyLen + 12` is
    // `16 < 26` → true → "incomplete header". Any `+`→`-` mutant collapses the
    // threshold (4-10+12=6 or 4+10-12=2), so `16 < 6/2` is false and the code
    // falls through to a JSON parse error instead — killing both operators.
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(10, 0); // wrappedKeyLen = 10
    await expect(p.decrypt(buf)).rejects.toThrow(/incomplete header/i);
  });

  it("L196: canDecryptVersion is true when the enc provider is enabled (OR short-circuit)", async () => {
    const p = makeProvider(true);
    await p.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
    // A version that the keyManager does not have (hasKeyVersion = false), but
    // the enc provider is enabled. `||` returns true; `&&` returns false.
    expect(p.canDecryptVersion(999999)).toBe(true);
  });

  it("L235: decrypt rejects AES-GCM data shorter than IV(12)+tag(16)", async () => {
    const p = makeProvider(true);
    await p.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });
    // Encrypt an empty plaintext: the DEK payload is exactly IV(12)+tag(16)=28
    // bytes. Truncate it to 27 bytes so the inner `_encryptWithDEK` guard
    // `data.length < 12 + 16` fires and throws "data too short for AES-GCM".
    // A `+`→`-` mutant makes the threshold `12 - 16 = -4` (always false), so
    // the malformed payload falls through to AES-GCM and throws a different
    // "AES-GCM decryption failed" message instead.
    const ct = await p.encrypt(Buffer.alloc(0));
    const wkl = ct.readUInt32BE(0);
    const truncated = ct.subarray(0, 4 + wkl + 27); // DEK payload = 27 < 28
    await expect(p.decrypt(truncated)).rejects.toThrow(/data too short for AES-GCM/i);
  });
});
