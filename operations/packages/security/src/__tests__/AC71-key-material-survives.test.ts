/**
 * AC 71 — `KeyManager`: what happens to key material.
 *
 * The module decides which key protects which data and for how long, so every
 * case here is about material rather than about plumbing: how long a key is,
 * who may hold it, whether a version number can be handed out twice, and what a
 * failure leaves behind. `KeyManager` carried `// @ts-nocheck` (so no compiler
 * ever looked at it) and was covered by tests that only walked the happy path.
 */
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { KeyManager, type WrappedKey } from '../impl/KeyManager.js';

/** 1 000 iterations: enough to be a real PBKDF2 run, fast enough to assert on. */
function manager(overrides: Partial<ConstructorParameters<typeof KeyManager>[0]> = {}): KeyManager {
  return new KeyManager({ masterSecret: 'unit-secret', iterations: 1_000, ...overrides });
}

describe('AC 71 — key length is a property of the data key', () => {
  it('71.1 wraps a 16-byte data key', async () => {
    // `keyLength` used to size the key-encryption key as well, and AES-256-GCM
    // refuses a 16-byte key: a caller asking for 128-bit data keys got
    // `Invalid key length` from every `generateKey()` instead.
    const km = manager({ keyLength: 16 });
    const wrapped = await km.generateKey();

    expect(km.getCurrentKey()).toHaveLength(16);
    expect(wrapped.encryptedKey).toHaveLength(16);
    expect((await km.unwrapKey(wrapped)).equals(km.getCurrentKey()!)).toBe(true);
  });

  it('71.2 wraps a 24-byte data key', async () => {
    const km = manager({ keyLength: 24 });
    const wrapped = await km.generateKey();

    expect(km.getCurrentKey()).toHaveLength(24);
    expect((await km.unwrapKey(wrapped)).equals(km.getCurrentKey()!)).toBe(true);
  });

  it('71.3 refuses a data key length no AES variant accepts', () => {
    for (const keyLength of [0, 15, 20, 31, 33, 64]) {
      expect(() => manager({ keyLength }), `keyLength ${keyLength}`).toThrow(/keyLength/);
    }
  });

  it('71.4 refuses to derive a key-encryption key from an empty secret', () => {
    // An empty secret is not a weak password, it is no password: PBKDF2 will
    // happily derive 256 bits from it and every instance would share the result.
    expect(() => manager({ masterSecret: '' })).toThrow(/masterSecret/);
    expect(() => new KeyManager({ masterSecret: '   ' })).toThrow(/masterSecret/);
  });

  it('71.5 refuses an iteration count that derives nothing', () => {
    for (const iterations of [0, -1, 1.5, Number.NaN]) {
      expect(() => manager({ iterations }), `iterations ${iterations}`).toThrow(/iterations/);
    }
  });
});

describe('AC 71 — the manager owns its key material', () => {
  it('71.6 hands out a copy of the current key, not the key', async () => {
    const km = manager();
    await km.generateKey();
    const handedOut = km.getCurrentKey()!;
    const expected = Buffer.from(handedOut);

    handedOut.fill(0);

    // Zeroizing what you were given must not zeroize what the manager holds, or
    // one caller's hygiene destroys the key for every other caller.
    expect(km.getCurrentKey()!.equals(expected)).toBe(true);
  });

  it('71.7 hands out a copy from getKey as well', async () => {
    const km = manager();
    await km.generateKey();
    const expected = Buffer.from(km.getKey(1)!);

    km.getKey(1)!.fill(0xff);

    expect(km.getKey(1)!.equals(expected)).toBe(true);
  });

  it('71.8 refuses to re-point an existing version at different material', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    const other = manager();
    const foreign: WrappedKey = await other.generateKey();

    // Same version number, different key: accepting it would make v1 mean two
    // things at once, and every blob already written under the first v1
    // undecryptable without any error being raised at load time.
    await expect(km.loadKey({ ...foreign, version: wrapped.version })).rejects.toThrow(/version 1/);

    expect(km.getCurrentKey()!.equals(await km.unwrapKey(wrapped))).toBe(true);
    expect(km.versionCount).toBe(1);
  });

  it('71.9 accepts the same material twice', async () => {
    const km = manager();
    const wrapped = await km.generateKey();

    await expect(km.loadKey(wrapped)).resolves.toBe(1);
    expect(km.versionCount).toBe(1);
  });

  it('71.10 zeroize drops every key and the current version', async () => {
    const km = manager();
    await km.generateKey();
    await km.generateKey();

    km.zeroize();

    expect(km.version).toBe(0);
    expect(km.versionCount).toBe(0);
    expect(km.getCurrentKey()).toBeNull();
    expect(km.getKey(1)).toBeNull();
    expect(km.hasKeyVersion(2)).toBe(false);
  });

  it('71.11 does not reissue a version number after zeroize', async () => {
    const km = manager();
    await km.generateKey(); // v1
    await km.generateKey(); // v2
    const firstKey = Buffer.from(km.getCurrentKey()!);

    km.zeroize();
    const rewrapped = await km.generateKey();

    // A version is a name for one key. Restarting at 1 made the new key share a
    // name with material that is still on disk, exported or already written into
    // ciphertext headers.
    expect(rewrapped.version).toBe(3);
    expect(km.version).toBe(3);
    expect(km.getCurrentKey()!.equals(firstKey)).toBe(false);
  });

  it('71.12 loadKey only moves the current version forward', async () => {
    const km = manager();
    await km.generateKey();
    await km.generateKey();
    await km.generateKey();
    const older = await km.exportWrappedKeys();

    await km.loadKey(older[0]!);

    expect(km.version).toBe(3);
    expect(km.versionCount).toBe(3);
  });
});

describe('AC 71 — export is a transfer format', () => {
  it('71.13 exports in version order, whatever order keys were loaded in', async () => {
    const km = manager();
    await km.generateKey();
    await km.generateKey();
    await km.generateKey();
    const [v1, v2, v3] = await km.exportWrappedKeys();

    const fresh = manager();
    await fresh.loadKey(v3!);
    await fresh.loadKey(v1!);
    await fresh.loadKey(v2!);

    const versionsOf = async (km: KeyManager): Promise<number[]> =>
      (await km.exportWrappedKeys()).map((key) => key.version);

    expect(await versionsOf(fresh)).toEqual([1, 2, 3]);
    expect(await versionsOf(km)).toEqual([1, 2, 3]);
  });

  it('71.14 exports a wrapping the destination can open with its own salt', async () => {
    const source = manager({ salt: crypto.randomBytes(32) });
    await source.generateKey();
    const [wrapped] = await source.exportWrappedKeys();

    const destination = manager({ salt: crypto.randomBytes(32) });
    const version = await destination.loadKey(wrapped!);

    expect(version).toBe(1);
    expect(destination.getCurrentKey()!.equals(source.getCurrentKey()!)).toBe(true);
  });

  it('71.15 never exports the same nonce twice', async () => {
    const km = manager();
    await km.generateKey();
    const first = await km.exportWrappedKeys();
    const second = await km.exportWrappedKeys();

    // AES-GCM nonce reuse under one key is a total break of the wrapping, not a
    // style problem: re-exporting a key has to wrap it again from scratch.
    expect(first[0]!.iv.equals(second[0]!.iv)).toBe(false);
    expect(first[0]!.authTag.equals(second[0]!.authTag)).toBe(false);
  });

  it('71.16 dates the key once', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    const exported = (await km.exportWrappedKeys())[0]!;

    // Two `Date.now()` calls for one event can disagree by a millisecond, which
    // then shows up as a migration that reports a different birthday for a key
    // than the key itself did.
    expect(exported.createdAt).toBe(wrapped.createdAt);
  });

  it('71.17 exports nothing when there is nothing', async () => {
    expect(await manager().exportWrappedKeys()).toEqual([]);
  });

  it('71.18 records the iteration count it used', async () => {
    const km = manager({ iterations: 2_000 });
    const wrapped = await km.generateKey();

    expect(wrapped.iterations).toBe(2_000);
    // The wrapped key carries its own salt and iteration count, so a destination
    // configured differently must still open it.
    await expect(manager({ iterations: 1_000 }).unwrapKey(wrapped)).resolves.toHaveLength(32);
  });
});

describe('AC 71 — a failure leaves nothing behind', () => {
  it('71.19 a wrap that fails consumes no version', async () => {
    const km = manager({ hashAlgorithm: 'not-a-digest' });

    await expect(km.generateKey()).rejects.toThrow();

    expect(km.version).toBe(0);
    expect(km.versionCount).toBe(0);
  });

  it('71.20 a load that fails changes nothing', async () => {
    const km = manager();
    const wrapped = await km.generateKey();
    const tampered: WrappedKey = {
      ...wrapped,
      authTag: Buffer.from(wrapped.authTag).fill(0),
    };

    await expect(km.loadKey(tampered)).rejects.toThrow(/v1/);

    expect(km.version).toBe(1);
    expect(km.versionCount).toBe(1);
    expect(km.getCurrentKey()!.equals(await km.unwrapKey(wrapped))).toBe(true);
  });

  it('71.21 a wrong secret is reported against the version it failed on', async () => {
    const wrapped = await manager({ masterSecret: 'right' }).generateKey();

    await expect(manager({ masterSecret: 'wrong' }).unwrapKey(wrapped)).rejects.toThrow(/failed to unwrap key v1/);
  });

  it('71.22 a tampered iteration count is caught by the tag, not trusted', async () => {
    const km = manager({ iterations: 1_000 });
    const wrapped = await km.generateKey();

    await expect(km.unwrapKey({ ...wrapped, iterations: 2_000 })).rejects.toThrow();
  });

  it('71.23 a loaded key is usable the moment loadKey resolves', async () => {
    // `loadKey(wrapped, unwrapNow)` documented a lazy mode whose "lazy" branch
    // was a copy of the eager one. Loading is eager, and the parameter that said
    // otherwise is gone — so the observable contract is that there is no second
    // step and no wrapped-but-unusable state to be in.
    const source = manager();
    const wrapped = await source.generateKey();
    const destination = manager();

    await destination.loadKey(wrapped);

    expect(destination.getCurrentKey()).not.toBeNull();
    expect(destination.getCurrentKey()!.equals(source.getCurrentKey()!)).toBe(true);
    expect(destination.getKey(wrapped.version)!.equals(await destination.unwrapKey(wrapped))).toBe(true);
  });

  it('71.24 versions are positive integers only', async () => {
    const km = manager();
    await km.generateKey();

    expect(km.getKey(0)).toBeNull();
    expect(km.getKey(-1)).toBeNull();
    expect(km.hasKeyVersion(1.5)).toBe(false);
  });
});
