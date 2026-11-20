/**
 * AC 72 — `EnvelopeEncryptionProvider`: who owns the first version number.
 *
 * The provider wraps a `KeyManager` and writes the wrapped data key into every
 * blob, so its version numbering is part of the on-disk format. The cases below
 * pin the two moments that used to be wrong: `initialize()` minting a version
 * before anything was encrypted (which then collided with a restored backup) and
 * `canDecryptVersion()` answering "yes" for versions it had never seen.
 */
import { describe, it, expect } from 'vitest';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';
import type { EncryptionConfig } from '../interfaces/index.js';

const CONFIG: EncryptionConfig = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' };

function provider(
  options: {
    secret?: string;
    autoGenerateKey?: boolean;
    keyLength?: number;
  } = {},
): EnvelopeEncryptionProvider {
  return new EnvelopeEncryptionProvider({
    keyManager: {
      masterSecret: options.secret ?? 'envelope-secret',
      iterations: 1_000,
      ...(options.keyLength === undefined ? {} : { keyLength: options.keyLength }),
    },
    encryption: CONFIG,
    ...(options.autoGenerateKey === undefined ? {} : { autoGenerateKey: options.autoGenerateKey }),
  });
}

describe('AC 72 — initialization does not spend a version', () => {
  it('72.1 holds no key and no version after initialize', async () => {
    const p = provider();
    await p.initialize(CONFIG);

    // `initialize()` used to mint v1 immediately. A deployment that restored a
    // backup into a fresh process then asked it to import v1 and was handed a
    // different key under the same name.
    expect(p.isEnabled()).toBe(true);
    expect(p.getCurrentKeyVersion()).toBe(0);
    expect(p.getKeyVersionCount()).toBe(0);
  });

  it('72.2 mints exactly one version on the first encrypt', async () => {
    const p = provider();
    await p.initialize(CONFIG);

    const first = await p.encrypt(Buffer.from('one'));
    const second = await p.encrypt(Buffer.from('two'));

    expect(p.getCurrentKeyVersion()).toBe(1);
    expect(p.getKeyVersionCount()).toBe(1);
    expect((await p.decrypt(first)).toString('utf-8')).toBe('one');
    expect((await p.decrypt(second)).toString('utf-8')).toBe('two');
  });

  it('72.3 imports a backup before any local key exists, then continues after it', async () => {
    const source = provider({ secret: 'restore-me' });
    await source.initialize(CONFIG);
    const archived = await source.encrypt(Buffer.from('archived'));
    const keys = await source.exportKeys();

    const restored = provider({ secret: 'restore-me' });
    await restored.initialize(CONFIG);
    for (const key of keys) {
      await restored.importKey(key);
    }

    // The archived blob is the whole point of the backup.
    expect((await restored.decrypt(archived)).toString('utf-8')).toBe('archived');
    // An import is not an activation: the next write gets its own version.
    await restored.encrypt(Buffer.from('new data'));
    expect(restored.getCurrentKeyVersion()).toBe(2);
    expect(restored.getKeyVersionCount()).toBe(2);
    expect((await restored.decrypt(archived)).toString('utf-8')).toBe('archived');
  });

  it('72.4 refuses to replace a held version with different material', async () => {
    const ours = provider({ secret: 'ours' });
    await ours.initialize(CONFIG);
    await ours.encrypt(Buffer.from('sealed'));
    const held = await ours.exportKeys();

    // Same master secret, so the import unwraps cleanly and only the material
    // differs — which is the case the version rule is about.
    const foreign = provider({ secret: 'ours' });
    await foreign.initialize(CONFIG);
    await foreign.encrypt(Buffer.from('sealed elsewhere'));
    const [theirs] = await foreign.exportKeys();

    await expect(ours.importKey({ ...theirs!, version: held[0]!.version })).rejects.toThrow(
      /version 1 already holds different key material/,
    );
  });

  it('72.5 keeps the documented refusal when no key may be generated', async () => {
    const p = provider({ autoGenerateKey: false });
    await p.initialize(CONFIG);

    await expect(p.encrypt(Buffer.from('x'))).rejects.toThrow('no DEK available');
    expect(p.getCurrentKeyVersion()).toBe(0);
  });
});

describe('AC 72 — canDecryptVersion answers about keys, not about the cipher', () => {
  it('72.6 says no to a version it has never held', async () => {
    const p = provider();
    await p.initialize(CONFIG);
    await p.encrypt(Buffer.from('x'));

    // The provider being initialized says the *cipher* works. It says nothing
    // about version 999999, whose key does not exist anywhere in this process —
    // `hasKeyVersion(v) || isEnabled()` answered "yes" to every number.
    expect(p.canDecryptVersion(999_999)).toBe(false);
    expect(p.canDecryptVersion(1)).toBe(true);
    expect(p.canDecryptVersion(2)).toBe(false);
  });

  it('72.7 says no for an imported-then-zeroized key', async () => {
    const p = provider();
    await p.initialize(CONFIG);
    await p.encrypt(Buffer.from('x'));
    expect(p.canDecryptVersion(1)).toBe(true);

    p.zeroize();

    expect(p.canDecryptVersion(1)).toBe(false);
  });
});

describe('AC 72 — the configured algorithm decides the key size', () => {
  it('72.8 refuses a data key the configured cipher cannot use', () => {
    // `keyLength: 16` is legitimate for the key manager, which only wraps and
    // unwraps. The envelope cipher is fixed by `algorithm`, so the combination
    // is a configuration error and has to be named as one rather than surfacing
    // as `Invalid key length` on the first write.
    expect(() => provider({ keyLength: 16 })).toThrow(/aes-256-gcm/);
    expect(() => provider({ keyLength: 16 })).toThrow(/32/);
    expect(() => provider({ keyLength: 24 })).toThrow(/aes-256-gcm/);
  });

  it('72.9 accepts the key size the algorithm asks for', () => {
    expect(() => provider({ keyLength: 32 })).not.toThrow();
    expect(() => provider()).not.toThrow();
  });
});
