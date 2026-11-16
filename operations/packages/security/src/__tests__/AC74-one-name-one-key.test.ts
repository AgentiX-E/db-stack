/**
 * AC74 — A version number is a name for one key, even when writers arrive at once.
 *
 * Iteration 31 established the rule for the sequential case: `loadKey` refuses to
 * replace a version with different material, and `zeroize()` keeps `highestVersion`
 * so a spent name is never reissued. Both rules were written for a caller that
 * waits. This suite is the caller that does not.
 *
 * What was broken
 * ---------------
 * `generateKey()` read `highestVersion`, awaited `_wrapKeyAt()` (a PBKDF2
 * derivation), and only then committed the version. Two concurrent calls both read
 * `0`, both minted a key, and both committed to `version 1`. The map kept the last
 * one; the first key was gone from the history and remained alive in the wrapped
 * key the caller was handed. Measured before the fix:
 *
 *     KeyManager#generateKey() x2 concurrently
 *       w1.version = 1, w2.version = 1, versionCount = 1
 *       unwrap(w1) equals getKey(1)?  false
 *       exportWrappedKeys().length    1     (two keys existed)
 *
 * So a blob sealed under w1's data key named a version whose key was a different
 * key. That is the one failure mode this class exists to prevent, and it was
 * reachable by a database writing two blobs at once.
 *
 * The same shape appeared one level up: eight concurrent first writes called
 * `_activeDek()` before any of them had installed a key, so eight keys were minted
 * for one provider, and which one became active depended on the order PBKDF2
 * callbacks fired.
 *
 * What these cases pin down
 * -------------------------
 *   1. Version allocation is serialised: concurrent mints get distinct names.
 *   2. The name resolves to the material the wrapped key was made from — the
 *      identity rule, asserted through `unwrapKey` rather than through fields.
 *   3. A rejected operation does not wedge the queue behind it.
 *   4. Key activation in the envelope provider is single-flight: one key for
 *      eight writers, and every blob decrypts to what was sealed.
 *   5. A wipe that lands while a key is being minted leaves nothing: no key in
 *      the history, no key active, and the mint reports why it was discarded.
 */

import { describe, it, expect } from 'vitest';
import { KeyManager, type WrappedKey } from '../impl/KeyManager.js';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';

// ── Helpers ─────────────────────────────────────────────────

/** Fast enough to run hundreds of times, slow enough that every call yields. */
const FAST = 1_000;

function manager(masterSecret = 'ac74-master', iterations = FAST): KeyManager {
  return new KeyManager({ masterSecret, iterations });
}

function envelope(overrides: { autoGenerateKey?: boolean; iterations?: number } = {}): EnvelopeEncryptionProvider {
  return new EnvelopeEncryptionProvider({
    keyManager: { masterSecret: 'ac74-envelope', iterations: overrides.iterations ?? FAST },
    encryption: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' },
    ...(overrides.autoGenerateKey === undefined ? {} : { autoGenerateKey: overrides.autoGenerateKey }),
  });
}

/** The material a wrapped key was made from, as the manager itself would unwrap it. */
async function materialOf(km: KeyManager, wrapped: WrappedKey): Promise<Buffer> {
  const dek = await km.unwrapKey(wrapped);
  try {
    return Buffer.from(dek);
  } finally {
    dek.fill(0);
  }
}

// ── 74.1–74.9: version allocation is serialised ─────────────

describe('AC74.1–74.9: concurrent key generation names each key once', () => {
  it('74.1 two concurrent mints get two versions, not one version twice', async () => {
    const km = manager();
    const [a, b] = await Promise.all([km.generateKey(), km.generateKey()]);

    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(km.versionCount).toBe(2);
    expect(km.version).toBe(2);
  });

  it('74.2 the first of two concurrent mints still names material v1 holds', async () => {
    const km = manager();
    const [a] = await Promise.all([km.generateKey(), km.generateKey()]);

    // The bug: this was `false`, because v1 had been overwritten by the second
    // mint and the first wrapped key pointed at a key the manager no longer held.
    expect((await materialOf(km, a)).equals(km.getKey(1)!)).toBe(true);
  });

  it('74.3 eight concurrent mints produce eight distinct versions', async () => {
    const km = manager();
    const wrapped = await Promise.all(Array.from({ length: 8 }, () => km.generateKey()));

    const versions = wrapped.map((w) => w.version).sort((x, y) => x - y);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(km.versionCount).toBe(8);
  });

  it('74.4 every one of eight concurrent mints resolves to its own material', async () => {
    const km = manager();
    const wrapped = await Promise.all(Array.from({ length: 8 }, () => km.generateKey()));

    const seen = new Set<string>();
    for (const w of wrapped) {
      const material = await materialOf(km, w);
      expect(material.equals(km.getKey(w.version)!)).toBe(true);
      seen.add(material.toString('hex'));
    }
    // Eight names, eight keys: no two wrapped keys describe the same material.
    expect(seen.size).toBe(8);
  });

  it('74.5 an export taken after concurrent minting carries every version', async () => {
    const km = manager();
    await Promise.all(Array.from({ length: 6 }, () => km.generateKey()));

    const exported = await km.exportWrappedKeys();
    expect(exported.map((w) => w.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('74.6 an exported key re-imports into a fresh manager as the same name and material', async () => {
    const source = manager();
    await Promise.all(Array.from({ length: 3 }, () => source.generateKey()));
    const exported = await source.exportWrappedKeys();

    const destination = manager();
    for (const wrapped of exported) {
      expect(await destination.loadKey(wrapped)).toBe(wrapped.version);
    }

    expect(destination.versionCount).toBe(3);
    for (const wrapped of exported) {
      expect((await materialOf(destination, wrapped)).equals(source.getKey(wrapped.version)!)).toBe(true);
    }
  });

  it('74.7 concurrent loads of one wrapped key are idempotent', async () => {
    const source = manager();
    const [wrapped] = [await source.generateKey()];

    const destination = manager();
    const versions = await Promise.all(Array.from({ length: 4 }, () => destination.loadKey(wrapped)));

    expect(versions).toEqual([1, 1, 1, 1]);
    expect(destination.versionCount).toBe(1);
  });

  it('74.8 a rejected load does not wedge the mint queued behind it', async () => {
    const km = manager();
    await km.generateKey(); // v1

    // Same master secret, different material: v1 is already spoken for.
    const foreign = await manager().generateKey();
    const results = await Promise.allSettled([km.loadKey(foreign), km.generateKey()]);

    expect(results[0].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/different key material/);

    expect(results[1].status).toBe('fulfilled');
    expect((results[1] as PromiseFulfilledResult<WrappedKey>).value.version).toBe(2);
    expect(km.versionCount).toBe(2);
  });

  it('74.9 a mint that uses no version leaves the next one unspent', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    km.zeroize();

    // The name was spent, so the next key is not v1 again.
    const reopened = await km.generateKey();
    expect(reopened.version).toBe(2);
    expect(km.hasKeyVersion(1)).toBe(false);
    expect(km.hasKeyVersion(2)).toBe(true);
    expect(wrapped.version).toBe(1);
  });
});

// ── 74.10–74.16: key activation is single-flight ────────────

describe('AC74.10–74.16: one provider, eight first writes, one key', () => {
  it('74.10 eight concurrent first writes mint exactly one key', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const blobs = await Promise.all(Array.from({ length: 8 }, (_, i) => provider.encrypt(Buffer.from(`blob-${i}`))));

    expect(provider.getKeyVersionCount()).toBe(1);
    expect(provider.getCurrentKeyVersion()).toBe(1);
    expect(blobs).toHaveLength(8);
  });

  it('74.11 every concurrently sealed blob decrypts to what was sealed', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const plaintexts = Array.from({ length: 8 }, (_, i) => Buffer.from(`payload-${i}`));
    const blobs = await Promise.all(plaintexts.map((p) => provider.encrypt(p)));

    for (let i = 0; i < plaintexts.length; i++) {
      expect((await provider.decrypt(blobs[i]!)).equals(plaintexts[i]!)).toBe(true);
    }
  });

  it('74.12 a write after the first mints nothing', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    await provider.encrypt(Buffer.from('first'));
    await provider.encrypt(Buffer.from('second'));
    await Promise.all([provider.encrypt(Buffer.from('third')), provider.encrypt(Buffer.from('fourth'))]);

    expect(provider.getKeyVersionCount()).toBe(1);
  });

  it('74.13 autoGenerateKey: false still refuses to invent a key', async () => {
    const provider = envelope({ autoGenerateKey: false });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    await expect(provider.encrypt(Buffer.from('x'))).rejects.toThrow(/no DEK available/);
    expect(provider.getKeyVersionCount()).toBe(0);
  });

  it('74.14 an imported key becomes the one a concurrent first write uses', async () => {
    const source = envelope();
    await source.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    const archived = await source.encrypt(Buffer.from('archived-before-restore'));
    const exported = await source.exportKeys();

    const restored = envelope({ autoGenerateKey: false });
    await restored.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    await restored.importKey(exported[0]!);

    // The restored process reads the archive before it ever writes.
    expect((await restored.decrypt(archived)).toString()).toBe('archived-before-restore');
    expect(restored.getKeyVersionCount()).toBe(1);
    expect(restored.getCurrentKeyVersion()).toBe(1);
  });

  it('74.15 rotation under concurrent writers keeps every blob readable', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    const before = await provider.encrypt(Buffer.from('before'));

    const during = await Promise.all([
      provider.rotateKey().then(() => provider.encrypt(Buffer.from('during-a'))),
      provider.encrypt(Buffer.from('during-b')),
    ]);
    const after = await provider.encrypt(Buffer.from('after'));

    expect((await provider.decrypt(before)).toString()).toBe('before');
    expect((await provider.decrypt(during[0])).toString()).toBe('during-a');
    expect((await provider.decrypt(during[1])).toString()).toBe('during-b');
    expect((await provider.decrypt(after)).toString()).toBe('after');
  });

  it('74.16 a version is decryptable exactly while it is held', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    await provider.encrypt(Buffer.from('seal'));
    await provider.rotateKey();

    expect(provider.canDecryptVersion(1)).toBe(true);
    expect(provider.canDecryptVersion(2)).toBe(true);
    expect(provider.canDecryptVersion(3)).toBe(false);
  });
});

// ── 74.17–74.22: a wipe during a mint leaves nothing ────────

describe('AC74.17–74.22: a wipe that lands during a mint', () => {
  it('74.17 the write that was minting is refused rather than served', async () => {
    // Default iteration count: the mint is certainly still in flight below.
    const provider = envelope({ iterations: 600_000 });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const inFlight = provider.encrypt(Buffer.from('write-during-wipe'));
    provider.zeroize();

    await expect(inFlight).rejects.toThrow(/zeroized while a data key was being minted/);
  });

  it('74.18 after that wipe no key exists and the provider is off', async () => {
    const provider = envelope({ iterations: 600_000 });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const inFlight = provider.encrypt(Buffer.from('x'));
    provider.zeroize();
    await expect(inFlight).rejects.toThrow();

    expect(provider.isEnabled()).toBe(false);
    expect(provider.getKeyVersionCount()).toBe(0);
    expect(provider.getCurrentKeyVersion()).toBe(0);
    expect(provider.canDecryptVersion(1)).toBe(false);
  });

  it('74.19 a later write is refused, not silently re-keyed', async () => {
    const provider = envelope({ iterations: 600_000 });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const inFlight = provider.encrypt(Buffer.from('x'));
    provider.zeroize();
    await expect(inFlight).rejects.toThrow();

    await expect(provider.encrypt(Buffer.from('y'))).rejects.toThrow(/not initialized/);
  });

  it('74.20 re-initialising after the wipe works and does not reuse the spent name', async () => {
    const provider = envelope({ iterations: 600_000 });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const inFlight = provider.encrypt(Buffer.from('x'));
    provider.zeroize();
    await expect(inFlight).rejects.toThrow();

    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    const blob = await provider.encrypt(Buffer.from('after-restart'));

    // v1 was spent, even though it was wiped before it was ever used.
    expect(provider.getCurrentKeyVersion()).toBe(2);
    expect((await provider.decrypt(blob)).toString()).toBe('after-restart');
  });

  it('74.21 a wipe with nothing in flight is a clean slate', async () => {
    const provider = envelope();
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
    await provider.encrypt(Buffer.from('settled'));

    provider.zeroize();

    expect(provider.getKeyVersionCount()).toBe(0);
    await expect(provider.exportKeys()).resolves.toEqual([]);
  });

  it('74.22 the key manager alone keeps its identity rule under a wipe', async () => {
    const km = manager();
    const [a, b] = await Promise.all([km.generateKey(), km.generateKey()]);
    const materialA = await materialOf(km, a);
    const materialB = await materialOf(km, b);

    km.zeroize();
    // Both materials are gone from the manager, and the names are not reissued.
    expect(await km.unwrapKey(a)).toBeInstanceOf(Buffer);
    expect(km.getKey(a.version)).toBeNull();
    expect(km.versionCount).toBe(0);

    const c = await km.generateKey();
    expect(c.version).toBe(3);
    expect(materialA.equals(materialB)).toBe(false);
  });
});

// ── 74.23–74.25: the cursors only move forward ─────────────

describe('AC74.23–74.25: loading an old name does not move the present backwards', () => {
  it('74.23 loading v1 into a manager holding v3 leaves the current version at 3', async () => {
    const source = manager();
    const wrapped = [];
    for (let i = 0; i < 3; i++) wrapped.push(await source.generateKey());
    const exported = await source.exportWrappedKeys();

    const destination = manager();
    await destination.loadKey(exported[2]!); // v3 first
    await destination.loadKey(exported[0]!); // then an older name

    expect(destination.version).toBe(3);
    expect(await destination.generateKey()).toMatchObject({ version: 4 });
  });

  it('74.24 the highest name issued is the highest ever loaded or minted', async () => {
    const source = manager();
    await source.generateKey();
    await source.generateKey();
    const [, second] = await source.exportWrappedKeys();

    const destination = manager();
    await destination.loadKey(second!); // v2 only

    // v2 was the highest name seen, so the next mint is v3 even though v1 is absent.
    expect((await destination.generateKey()).version).toBe(3);
  });

  it('74.25 a load after a wipe continues the numbering it remembered', async () => {
    const source = manager();
    const wrapped = await source.generateKey();
    source.zeroize();

    expect(await source.loadKey(wrapped)).toBe(1);
    expect(source.version).toBe(1);
    expect((await source.generateKey()).version).toBe(2);
  });
});
