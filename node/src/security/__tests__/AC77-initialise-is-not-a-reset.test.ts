/**
 * AC77 — Initialising a cipher twice is not a way to lose the first key.
 *
 * `AES256GCMEncryptionProvider.initialize()` minted a fresh master key, set
 * `keyVersion = 1`, and stored it under version 1. Called a second time on the same
 * instance — a re-connect, a config reload, a supervisor restart inside the same
 * process — it replaced v1 with a different key under the same name. Everything
 * sealed before that call was then undecryptable while the header still said "v1",
 * which is the worst of both: the data is gone and the record of how it was sealed
 * points at a key that no longer means what it meant.
 *
 * Iteration 31 fixed exactly this rule one layer down (`KeyManager`), with the
 * envelope provider reading its keys through it. This class is the other
 * implementation of `IEncryptionManager` and had the same defect: the rule was
 * fixed where it was noticed, not where it was stated.
 *
 * Three cases follow from stating it here:
 *
 *   1. Initialising an already-initialised provider keeps its keys. A second call
 *      is the same as the first once the cipher is running.
 *   2. A second call that asks for a *different* algorithm is refused, because the
 *      blobs on disk were sealed with the first one and there is no re-encryption
 *      step in this class.
 *   3. `zeroize()` retires the key material and the *names* with it: the next
 *      `initialize()` mints version 2, so a blob sealed under the old v1 is
 *      reported as an unknown version rather than silently decrypted with a new key
 *      that happens to share its name.
 */

import { describe, it, expect } from 'vitest';
import { AES256GCMEncryptionProvider } from '../impl/AES256GCMEncryptionProvider.js';
import type { EncryptionConfig } from '../interfaces/index.js';

const AES: EncryptionConfig = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' };

// ── 77.1–77.6: a second initialise is not a reset ──────────

describe('AC77.1–77.6: initialising twice keeps the key that is already in use', () => {
  it('77.1 a blob sealed before the second call still decrypts after it', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const sealed = await provider.encrypt(Buffer.from('written-before-reload'));

    await provider.initialize(AES);

    expect((await provider.decrypt(sealed)).toString()).toBe('written-before-reload');
  });

  it('77.2 the version is neither renumbered nor duplicated', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    await provider.initialize(AES);
    await provider.initialize(AES);

    expect(provider.getCurrentKeyVersion()).toBe(1);
    expect(provider.getKeyVersionCount()).toBe(1);
    expect(provider.hasKeyVersion(1)).toBe(true);
  });

  it('77.3 a second call with a different algorithm is refused', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);

    await expect(provider.initialize({ algorithm: 'chacha20-poly1305', keyDerivation: 'pbkdf2' })).rejects.toThrow(
      'AES256GCM: cannot switch algorithm from aes-256-gcm to chacha20-poly1305 while keys are in use — ' +
        'existing blobs were sealed with the first',
    );
    expect(provider.getCurrentKeyVersion()).toBe(1);
  });

  it('77.4 the refusal leaves the provider working', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const sealed = await provider.encrypt(Buffer.from('still-here'));

    await expect(provider.initialize({ algorithm: 'chacha20-poly1305', keyDerivation: 'pbkdf2' })).rejects.toThrow();

    expect((await provider.decrypt(sealed)).toString()).toBe('still-here');
    expect(provider.isEnabled()).toBe(true);
  });

  it('77.5 rotating and then re-initialising keeps every version', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const v1 = await provider.encrypt(Buffer.from('v1'));
    await provider.rotateKey();
    const v2 = await provider.encrypt(Buffer.from('v2'));

    await provider.initialize(AES);

    expect(provider.getKeyVersionCount()).toBe(2);
    expect((await provider.decrypt(v1)).toString()).toBe('v1');
    expect((await provider.decrypt(v2)).toString()).toBe('v2');
  });

  it('77.6 a fresh instance still mints version 1', async () => {
    const provider = new AES256GCMEncryptionProvider();
    expect(provider.isEnabled()).toBe(false);
    await provider.initialize(AES);

    expect(provider.isEnabled()).toBe(true);
    expect(provider.getCurrentKeyVersion()).toBe(1);
    expect(provider.getKeyVersionCount()).toBe(1);
  });
});

// ── 77.7–77.12: a wipe retires the names too ───────────────

describe('AC77.7–77.12: zeroize retires the key and its name', () => {
  it('77.7 zeroize removes the material and stops the provider', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    await provider.encrypt(Buffer.from('x'));

    provider.zeroize();

    expect(provider.isEnabled()).toBe(false);
    expect(provider.getKeyVersionCount()).toBe(0);
    expect(provider.getCurrentKeyVersion()).toBe(0);
    expect(provider.hasKeyVersion(1)).toBe(false);
  });

  it('77.8 a zeroized provider refuses to seal or open', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const sealed = await provider.encrypt(Buffer.from('x'));
    provider.zeroize();

    await expect(provider.encrypt(Buffer.from('y'))).rejects.toThrow(/not initialized/);
    await expect(provider.decrypt(sealed)).rejects.toThrow(/not initialized/);
  });

  it('77.9 the version after a wipe is new, not the retired one', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    provider.zeroize();

    await provider.initialize(AES);

    expect(provider.getCurrentKeyVersion()).toBe(2);
    expect(provider.getKeyVersionCount()).toBe(1);
  });

  it('77.10 a blob sealed before the wipe is reported as an unknown version, not decrypted', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const sealed = await provider.encrypt(Buffer.from('gone'));
    provider.zeroize();
    await provider.initialize(AES);

    // Version 1 is spent. Decrypting with the new key would be a lie dressed as a
    // success, and AES-GCM's tag would refuse it anyway — the point is that the
    // provider says which of the two reasons it is.
    await expect(provider.decrypt(sealed)).rejects.toThrow(/unknown key version 1/);
  });

  it('77.11 the post-wipe key really is a new key', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    const sealed = await provider.encrypt(Buffer.from('payload'));
    provider.zeroize();
    await provider.initialize(AES);
    const fresh = await provider.encrypt(Buffer.from('payload'));

    // Same plaintext, different key: the ciphertexts cannot coincide.
    expect(sealed.equals(fresh)).toBe(false);
  });

  it('77.12 zeroize is idempotent', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    provider.zeroize();
    provider.zeroize();

    expect(provider.isEnabled()).toBe(false);
    expect(provider.getKeyVersionCount()).toBe(0);
  });
});

// ── 77.13–77.15: rotation and the uninitialised state ──────

describe('AC77.13–77.15: rotation without a cipher', () => {
  it('77.13 rotating before initialize is refused instead of minting', async () => {
    const provider = new AES256GCMEncryptionProvider();

    // `rotateKey()` called `_ensureInitialized()`; the call is what makes a
    // disabled provider refuse rather than quietly create a key nobody enabled.
    await expect(provider.rotateKey()).rejects.toThrow('AES256GCM: not initialized. Call initialize() first.');
    expect(provider.getKeyVersionCount()).toBe(0);
    expect(provider.getCurrentKeyVersion()).toBe(0);
  });

  it('77.14 rotating after zeroize is refused as well', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    provider.zeroize();

    await expect(provider.rotateKey()).rejects.toThrow(/not initialized/);
    expect(provider.getKeyVersionCount()).toBe(0);
  });

  it('77.15 a version number is never reused across a wipe and a reload', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(AES);
    await provider.rotateKey();
    await provider.rotateKey();
    const before = provider.getCurrentKeyVersion();

    provider.zeroize();
    await provider.initialize(AES);

    // Three versions were issued; the fourth name is the next one, not v1.
    expect(provider.getCurrentKeyVersion()).toBe(before + 1);
    expect(provider.getKeyVersionCount()).toBe(1);
  });
});
