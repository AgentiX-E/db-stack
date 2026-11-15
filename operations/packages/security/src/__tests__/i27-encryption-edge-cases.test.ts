/**
 * I27 — encryption lifecycle edge cases.
 *
 * These cases exercise inputs the product accepts but the default happy-path
 * tests never reach: a blob that names a key version the provider does not
 * hold, a key manager configured with only a master secret, an envelope
 * provider told not to auto-generate a DEK, and an encryption manager used
 * before initialization.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { AES256GCMEncryptionProvider } from '../impl/AES256GCMEncryptionProvider.js';
import { KeyManager } from '../impl/KeyManager.js';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';
import { InMemoryEncryptionManager } from '../impl/InMemoryEncryptionManager.js';

const ENCRYPTION_CONFIG = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' } as const;

function makeEnvelope(autoGenerateKey: boolean): EnvelopeEncryptionProvider {
  return new EnvelopeEncryptionProvider({
    keyManager: { masterSecret: 'edge-envelope-secret', iterations: 1_000, keyLength: 32 },
    encryption: ENCRYPTION_CONFIG,
    autoGenerateKey,
  });
}

describe('AES256GCM — key version integrity', () => {
  it('refuses a blob whose header names a key version the provider does not hold', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(ENCRYPTION_CONFIG);

    const ciphertext = await provider.encrypt(Buffer.from('version-bound payload'));
    // The version prefix is caller-visible metadata, not ciphertext. Relabel it
    // as v99: no such key exists, so the blob must be rejected instead of being
    // decrypted with the current key.
    const relabelled = Buffer.from(ciphertext);
    relabelled.writeUInt32BE(99, 0);

    await expect(provider.decrypt(relabelled)).rejects.toThrow('unknown key version 99');
    expect(provider.hasKeyVersion(99)).toBe(false);
  });

  it('refuses a blob relabelled from an older version to the current one', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(ENCRYPTION_CONFIG);
    const v1 = await provider.encrypt(Buffer.from('encrypted under v1'));
    await provider.rotateKey();

    // v2 has its own key, so claiming a v1 blob is v2 must fail authentication
    // rather than silently decrypt under the wrong key.
    const relabelled = Buffer.from(v1);
    relabelled.writeUInt32BE(provider.getCurrentKeyVersion(), 0);

    await expect(provider.decrypt(relabelled)).rejects.toThrow('decryption failed');
  });

  it('still decrypts the untouched blob after rejecting a relabelled copy', async () => {
    const provider = new AES256GCMEncryptionProvider();
    await provider.initialize(ENCRYPTION_CONFIG);

    const plaintext = Buffer.from('original payload');
    const ciphertext = await provider.encrypt(plaintext);
    const relabelled = Buffer.from(ciphertext);
    relabelled.writeUInt32BE(42, 0);

    await expect(provider.decrypt(relabelled)).rejects.toThrow('unknown key version');
    expect((await provider.decrypt(ciphertext)).equals(plaintext)).toBe(true);
  });
});

describe('KeyManager — configuration defaults and errors', () => {
  it('applies the documented defaults when only a master secret is supplied', async () => {
    const km = new KeyManager({ masterSecret: 'only-the-secret' });

    const wrapped = await km.generateKey();

    expect(wrapped.iterations).toBe(600_000);
    expect(wrapped.salt).toHaveLength(32);
    expect(wrapped.encryptedKey).toHaveLength(32);
    expect(km.getCurrentKey()).toHaveLength(32);

    const unwrapped = await km.unwrapKey(wrapped);
    expect(unwrapped.equals(km.getCurrentKey()!)).toBe(true);
  });

  it('loadKey with lazy loading requested still yields a usable key', async () => {
    // Lazy unwrapping is not implemented; the flag must not make loadKey a
    // silent no-op, because callers then believe the key is available.
    const source = new KeyManager({ masterSecret: 'lazy-secret', iterations: 1_000 });
    const wrapped = await source.generateKey();
    const exported = await source.exportWrappedKeys();

    const target = new KeyManager({ masterSecret: 'lazy-secret', iterations: 1_000 });
    const version = await target.loadKey(exported[0]!, false);

    expect(version).toBe(wrapped.version);
    expect(target.getKey(version)!.equals(source.getKey(wrapped.version)!)).toBe(true);
  });

  it('rejects an unsupported PBKDF2 digest with the derivation error', async () => {
    const km = new KeyManager({
      masterSecret: 'digest-secret',
      iterations: 1_000,
      hashAlgorithm: 'not-a-real-digest',
    });

    await expect(km.generateKey()).rejects.toThrow(/digest|not supported/i);
    expect(km.versionCount).toBe(0);
  });

  it('uses a distinct random salt per instance when none is configured', async () => {
    const a = new KeyManager({ masterSecret: 'same-secret', iterations: 1_000 });
    const b = new KeyManager({ masterSecret: 'same-secret', iterations: 1_000 });

    const [wa, wb] = await Promise.all([a.generateKey(), b.generateKey()]);

    expect(wa.salt.equals(wb.salt)).toBe(false);
    expect(wa.salt).toHaveLength(32);
  });
});

describe('EnvelopeEncryptionProvider — DEK lifecycle', () => {
  it('refuses to encrypt when configured without an auto-generated DEK', async () => {
    const provider = makeEnvelope(false);
    await provider.initialize(ENCRYPTION_CONFIG);

    expect(provider.isEnabled()).toBe(true);
    expect(provider.getCurrentKeyVersion()).toBe(0);
    await expect(provider.encrypt(Buffer.from('no dek'))).rejects.toThrow('no DEK available');
  });

  it('encrypts after an explicit rotation supplies the first DEK', async () => {
    const provider = makeEnvelope(false);
    await provider.initialize(ENCRYPTION_CONFIG);

    await provider.rotateKey();
    const ciphertext = await provider.encrypt(Buffer.from('after rotation'));

    expect(provider.getCurrentKeyVersion()).toBe(1);
    expect((await provider.decrypt(ciphertext)).toString('utf-8')).toBe('after rotation');
  });

  it('rejects a blob shorter than the 4-byte header prefix', async () => {
    const provider = makeEnvelope(true);
    await provider.initialize(ENCRYPTION_CONFIG);

    await expect(provider.decrypt(Buffer.from([0x00, 0x01]))).rejects.toThrow('ciphertext too short (2B)');
  });

  it('reports the number of retained key versions after rotations', async () => {
    const provider = makeEnvelope(true);
    await provider.initialize(ENCRYPTION_CONFIG);
    expect(provider.getKeyVersionCount()).toBe(1);

    await provider.rotateKey();
    await provider.rotateKey();

    expect(provider.getKeyVersionCount()).toBe(3);
    expect(provider.getCurrentKeyVersion()).toBe(3);
  });

  it('keeps ciphertexts from a retired version decryptable through the header', async () => {
    const provider = makeEnvelope(true);
    await provider.initialize(ENCRYPTION_CONFIG);

    const plaintext = crypto.randomBytes(64);
    const v1 = await provider.encrypt(plaintext);
    await provider.rotateKey();
    await provider.encrypt(Buffer.from('forces v2 stream'));

    expect((await provider.decrypt(v1)).equals(plaintext)).toBe(true);
  });
});

describe('InMemoryEncryptionManager — use before initialization', () => {
  it('refuses to decrypt before initialize', async () => {
    const manager = new InMemoryEncryptionManager();

    await expect(manager.decrypt(Buffer.from('opaque'))).rejects.toThrow('not initialized');
    expect(manager.isEnabled()).toBe(false);
    expect(manager.getKeyVersion()).toBe(0);
  });
});
