/**
 * AC75 — The cost of a write is not a key derivation, and a blob cannot choose
 * how much work the reader spends.
 *
 * Two problems, one line of code apart.
 *
 * Cost
 * ----
 * `EnvelopeEncryptionProvider.encrypt()` wrapped the data key on every blob, and
 * wrapping derives the key-encryption key: PBKDF2-HMAC-SHA256 with 600 000
 * iterations by default. Measured on the reference machine that is ~100 ms of CPU
 * spent to re-derive a key the process had already derived, per blob. A database
 * writing thousands of blobs pays minutes of CPU per thousand writes, and the
 * number it pays is the *same* number every time — which is the definition of work
 * a cache can remove without changing a single byte on disk.
 *
 * The fix is a cache of derived key-encryption keys keyed by the derivation
 * parameters (salt + iterations), bounded in size, with one owner (`zeroize()`
 * wipes it). What is *not* cached is the wrapped key: reusing one wrapped blob
 * across many ciphertexts would mean the same key and the same IV over and over,
 * which is a shape nobody should have to reason about in order to trust a write
 * path.
 *
 * Untrusted input
 * ---------------
 * `decrypt()` reads the wrapped key out of the blob it is handed. That header
 * carries the salt and the iteration count — the work factor — so the *data*
 * chose how much CPU the reader would spend: a one-line header edit turned a
 * 100 ms read into an unbounded one. The manager now refuses a header outside a
 * documented range, and the cache is bounded for the same reason: a header field
 * that selects a cache entry is a header field that can fill memory.
 */

import { describe, it, expect } from 'vitest';
import {
  KeyManager,
  MAX_CACHED_KEKS,
  MAX_DERIVATION_ITERATIONS,
  MAX_SALT_BYTES,
  MIN_SALT_BYTES,
  type WrappedKey,
} from '../impl/KeyManager.js';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';
import crypto from 'node:crypto';

const FAST = 1_000;

function manager(overrides: { masterSecret?: string; salt?: Buffer; iterations?: number } = {}): KeyManager {
  return new KeyManager({
    masterSecret: overrides.masterSecret ?? 'ac75-master',
    iterations: overrides.iterations ?? FAST,
    ...(overrides.salt === undefined ? {} : { salt: overrides.salt }),
  });
}

function envelope(iterations = FAST): EnvelopeEncryptionProvider {
  return new EnvelopeEncryptionProvider({
    keyManager: { masterSecret: 'ac75-envelope', iterations },
    encryption: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' },
  });
}

/** A wrapped key whose header has been edited the way an attacker would edit it. */
function withHeader(wrapped: WrappedKey, patch: Partial<WrappedKey>): WrappedKey {
  return { ...wrapped, ...patch };
}

// ── 75.1–75.7: one derivation per parameter set ─────────────

describe('AC75.1–75.7: the key-encryption key is derived once per parameter set', () => {
  it('75.1 twenty writes cost one derivation', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    for (let i = 0; i < 20; i++) {
      await provider.encrypt(Buffer.from(`blob-${i}`));
    }

    // Before the fix this was 20: a full derivation per write.
    expect(provider.keyDerivationCount).toBe(1);
  });

  it('75.2 every one of those writes is still independently readable', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const blobs = [];
    for (let i = 0; i < 20; i++) blobs.push(await provider.encrypt(Buffer.from(`blob-${i}`)));

    for (let i = 0; i < blobs.length; i++) {
      expect((await provider.decrypt(blobs[i]!)).toString()).toBe(`blob-${i}`);
    }
  });

  it('75.3 sharing a derived key still gives every blob a fresh IV', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const first = await provider.encrypt(Buffer.from('same bytes'));
    const second = await provider.encrypt(Buffer.from('same bytes'));

    // Same plaintext, same data key: the only reason the blobs differ is a fresh
    // IV per operation — at both layers.
    expect(first.equals(second)).toBe(false);

    const headerOf = (blob: Buffer): WrappedKey =>
      JSON.parse(blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('utf-8')) as WrappedKey;
    const a = headerOf(first);
    const b = headerOf(second);

    // The cached derivation is shared; the wrapped form of the key is not.
    expect(a.version).toBe(b.version);
    expect(Buffer.from(a.iv)).not.toEqual(Buffer.from(b.iv));
    expect(Buffer.from(a.encryptedKey)).not.toEqual(Buffer.from(b.encryptedKey));
  });

  it('75.4 unwrapping five keys from one salt costs one derivation', async () => {
    const km = manager();
    const wrapped = [];
    for (let i = 0; i < 5; i++) wrapped.push(await km.generateKey());

    for (const w of wrapped) {
      const dek = await km.unwrapKey(w);
      dek.fill(0);
    }

    expect(km.keyDerivationCount).toBe(1);
  });

  it('75.5 a wrapped key from another salt derives that salt once, not per read', async () => {
    const a = manager({ salt: crypto.randomBytes(32) });
    const b = manager({ salt: crypto.randomBytes(32) });
    const fromB = await b.generateKey();

    // Loading derives the salt carried by the wrapped key — B's, not a's.
    expect(await a.loadKey(fromB)).toBe(1);
    expect(a.keyDerivationCount).toBe(1);

    const dek = await a.unwrapKey(fromB);
    dek.fill(0);
    expect(a.keyDerivationCount).toBe(1); // the same salt is answered from the cache
  });

  it('75.6 a key loaded from an export does not re-derive what is already derived', async () => {
    const source = manager();
    await source.generateKey();
    const [exported] = await source.exportWrappedKeys();

    const destination = manager();
    await destination.loadKey(exported!);

    expect(destination.keyDerivationCount).toBe(1);
    expect(destination.versionCount).toBe(1);
  });

  it('75.7 zeroize empties the cache, so the next unwrap derives again', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    expect(km.kekCacheSize).toBe(1);

    km.zeroize();

    // A cached wrapping key is key material: it does not survive the wipe.
    expect(km.kekCacheSize).toBe(0);
    expect(km.keyDerivationCount).toBe(1);

    const dek = await km.unwrapKey(wrapped);
    expect(dek.length).toBe(32);
    dek.fill(0);
    expect(km.keyDerivationCount).toBe(2);
  });
});

// ── 75.8–75.14: the header is untrusted ────────────────────

describe('AC75.8–75.14: a wrapped key cannot choose the work the reader pays', () => {
  it('75.8 an iteration count above the limit is refused before any derivation', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    const derivationsBefore = km.keyDerivationCount;

    await expect(km.unwrapKey(withHeader(wrapped, { iterations: MAX_DERIVATION_ITERATIONS + 1 }))).rejects.toThrow(
      /work factor/,
    );

    expect(km.keyDerivationCount).toBe(derivationsBefore);
  });

  it('75.9 an absurd iteration count is refused, not attempted', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    // 10^12 iterations at the reference speed is roughly four hours. If this case
    // ever hangs, the limit stopped being enforced.
    await expect(km.unwrapKey(withHeader(wrapped, { iterations: 1_000_000_000_000 }))).rejects.toThrow(/work factor/);
  });

  it('75.10 a zero or fractional iteration count is refused', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey(withHeader(wrapped, { iterations: 0 }))).rejects.toThrow(/work factor/);
    await expect(km.unwrapKey(withHeader(wrapped, { iterations: 1.5 }))).rejects.toThrow(/work factor/);
  });

  it('75.11 a salt outside the documented range is refused', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey(withHeader(wrapped, { salt: Buffer.alloc(MIN_SALT_BYTES - 1) }))).rejects.toThrow(/salt/);
    await expect(km.unwrapKey(withHeader(wrapped, { salt: Buffer.alloc(MAX_SALT_BYTES + 1) }))).rejects.toThrow(/salt/);
  });

  it('75.12 the loader refuses the same headers the unwrapper refuses', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.loadKey(withHeader(wrapped, { iterations: MAX_DERIVATION_ITERATIONS + 1 }))).rejects.toThrow(
      /work factor/,
    );
    expect(km.versionCount).toBe(1);
  });

  it('75.13 a legal work factor is not a bypass: a changed one fails authentication', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    // Inside the range, so the range check is not what refuses it: the derived
    // key is simply a different key, and AES-GCM says so through the tag.
    await expect(km.unwrapKey(withHeader(wrapped, { iterations: FAST * 2 }))).rejects.toThrow(/failed to unwrap/);
  });

  it('75.14 the cache does not grow with the number of salts a blob carries', async () => {
    const km = manager();
    await km.generateKey();

    for (let i = 0; i < 200; i++) {
      const foreign = withHeader(await km.generateKey(), { salt: crypto.randomBytes(32) });
      await expect(km.unwrapKey(foreign)).rejects.toThrow(/failed to unwrap/);
    }

    expect(km.kekCacheSize).toBeLessThanOrEqual(MAX_CACHED_KEKS);
    // Every salt was still derived exactly once; bounding the cache is not the
    // same as refusing the work.
    expect(km.keyDerivationCount).toBeGreaterThan(MAX_CACHED_KEKS);
  });
});

// ── 75.15–75.21: the boundaries, stated exactly ────────────

describe('AC75.15–75.21: the range is a boundary, not a direction', () => {
  it('75.15 one iteration is inside the range, so it fails authentication instead', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    // `iterations < 1` mutated to `<= 1` refuses this; the range says 1 is legal
    // and the derived key is simply the wrong one.
    await expect(km.unwrapKey(withHeader(wrapped, { iterations: 1 }))).rejects.toThrow(/failed to unwrap/);
  });

  it('75.16 the ceiling itself is inside the range', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    // One iteration above the ceiling is refused; the ceiling is honoured. This
    // costs one real derivation at the limit — the only honest way to say the
    // boundary is where the constant says it is.
    await expect(km.unwrapKey(withHeader(wrapped, { iterations: MAX_DERIVATION_ITERATIONS }))).rejects.toThrow(
      /failed to unwrap/,
    );
  }, 60_000);

  it('75.17 the salt range includes both of its ends', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey(withHeader(wrapped, { salt: Buffer.alloc(MIN_SALT_BYTES) }))).rejects.toThrow(
      /failed to unwrap/,
    );
    await expect(km.unwrapKey(withHeader(wrapped, { salt: Buffer.alloc(MAX_SALT_BYTES) }))).rejects.toThrow(
      /failed to unwrap/,
    );
  });

  it('75.18 the refusals say what they refused and what the range is', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey(withHeader(wrapped, { iterations: MAX_DERIVATION_ITERATIONS + 1 }))).rejects.toThrow(
      `KeyManager: refusing a work factor of ${MAX_DERIVATION_ITERATIONS + 1} PBKDF2 iterations ` +
        `(allowed 1–${MAX_DERIVATION_ITERATIONS})`,
    );
    await expect(km.unwrapKey(withHeader(wrapped, { salt: Buffer.alloc(4) }))).rejects.toThrow(
      `KeyManager: refusing a 4-byte salt in a wrapped key (allowed ${MIN_SALT_BYTES}–${MAX_SALT_BYTES})`,
    );
  });

  it('75.19 a header with no salt at all is refused as a salt, not as a crash', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey(withHeader(wrapped, { salt: undefined as unknown as Buffer }))).rejects.toThrow(/salt/);
  });

  it('75.20 the cache holds exactly its limit, not one less', async () => {
    const km = manager();
    for (let i = 0; i < MAX_CACHED_KEKS + 1; i++) {
      const foreign = withHeader(await km.generateKey(), { salt: crypto.randomBytes(32) });
      await expect(km.unwrapKey(foreign)).rejects.toThrow(/failed to unwrap/);
    }

    // Residency is exactly the limit: `size > limit` and `size >= limit` differ by
    // one, and that one is the whole of the bound. The number of derivations is not
    // asserted exactly — evicting the manager's own salt makes the next wrap derive
    // it again, and that cost is the point of a bound rather than a bug in it.
    expect(km.kekCacheSize).toBe(MAX_CACHED_KEKS);
    expect(km.keyDerivationCount).toBeGreaterThan(MAX_CACHED_KEKS);
  });

  it('75.21 an unusable hash algorithm surfaces from the mint, not as silence', async () => {
    const km = new KeyManager({ masterSecret: 'ac75-hash', iterations: FAST, hashAlgorithm: 'not-a-digest' });

    await expect(km.generateKey()).rejects.toThrow();
    expect(km.versionCount).toBe(0);
  });
});
