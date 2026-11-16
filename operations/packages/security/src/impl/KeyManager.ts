/**
 * I27 — E1 Key Manager.
 *
 * Secure key lifecycle management for encryption providers.
 *
 * Features:
 *   - Key derivation: PBKDF2-HMAC-SHA256 with configurable iterations
 *   - Master key wrapping: encrypt the DEK with a KEK
 *   - Secure key export: encrypted key material serialization
 *   - Key rotation support: multi-version key history
 *   - Key zeroization: secure memory wipe of sensitive key material
 *
 * Architecture:
 *   Master Password / External KMS
 *          ↓ PBKDF2 / unwrap
 *   Key Encryption Key (KEK) → never stored, derived on demand
 *          ↓ AES-256-GCM wrap
 *   Data Encryption Key (DEK) → stored encrypted (wrapped)
 *          ↓
 *   Application data ← AES-256-GCM
 */

import crypto from 'crypto';

/** Length of the key-encryption key. AES-256-GCM accepts exactly 32 bytes. */
const KEK_BYTES = 32;

/** Data-key lengths the AES variants behind this manager can actually use. */
const DATA_KEY_BYTES = new Set([16, 24, 32]);

// ── Types ──────────────────────────────────────────────────

export interface KeyManagerConfig {
  /** Password or secret from which the KEK is derived. */
  masterSecret: string;
  /** Salt for PBKDF2 derivation (should be stored alongside wrapped key). Default: 32 random bytes. */
  salt?: Buffer;
  /** PBKDF2 iterations. Default: 600_000 (OWASP 2024 recommendation). */
  iterations?: number;
  /**
   * Length of the *data* key in bytes: 16, 24 or 32 (AES-128/192/256). Default: 32.
   * It does not size the key-encryption key, which is always 32 bytes because the
   * wrapping cipher is fixed.
   */
  keyLength?: number;
  /** Hash algorithm for PBKDF2. Default: "sha256". */
  hashAlgorithm?: string;
}

export interface WrappedKey {
  /** Key version number. */
  version: number;
  /** IV used for wrapping (96-bit). */
  iv: Buffer;
  /** Wrapped (encrypted) key data. */
  encryptedKey: Buffer;
  /** Authentication tag (128-bit). */
  authTag: Buffer;
  /** Salt used for KEK derivation. */
  salt: Buffer;
  /** PBKDF2 iteration count used. */
  iterations: number;
  /** Timestamp of key creation (epoch ms). */
  createdAt: number;
}

export interface KeyPair {
  version: number;
  key: Buffer;
  createdAt: number;
}

const DEFAULT_CONFIG: Omit<Required<KeyManagerConfig>, 'masterSecret' | 'salt'> = {
  iterations: 600_000,
  keyLength: 32,
  hashAlgorithm: 'sha256',
};

// ── KeyManager ─────────────────────────────────────────────

export class KeyManager {
  private config: Required<KeyManagerConfig>;
  private keyHistory = new Map<number, KeyPair>();
  /** Version of the key currently in use, or 0 when there is none. */
  private currentVersion = 0;
  /**
   * Highest version ever issued. Kept across `zeroize()` on purpose: a version
   * number is a name for one key, and reissuing it after a wipe would make the
   * new key share a name with material that may already be in ciphertext
   * headers, exports or backups.
   */
  private highestVersion = 0;

  constructor(config: KeyManagerConfig) {
    // Resolve documented defaults explicitly: a spread would let an explicit
    // `undefined` overwrite the default it is supposed to select.
    const resolved: Required<KeyManagerConfig> = {
      masterSecret: config.masterSecret,
      salt: config.salt ?? crypto.randomBytes(32),
      iterations: config.iterations ?? DEFAULT_CONFIG.iterations,
      keyLength: config.keyLength ?? DEFAULT_CONFIG.keyLength,
      hashAlgorithm: config.hashAlgorithm ?? DEFAULT_CONFIG.hashAlgorithm,
    };

    // Refuse a configuration that cannot produce the key it promises, at
    // construction: every one of these used to surface as a runtime error from
    // `crypto` at the first `generateKey()` — or, worse, not at all.
    if (resolved.masterSecret.trim().length === 0) {
      throw new Error('KeyManager: masterSecret must not be empty — PBKDF2 will derive a key from nothing');
    }
    if (!DATA_KEY_BYTES.has(resolved.keyLength)) {
      throw new Error(
        `KeyManager: keyLength must be one of ${[...DATA_KEY_BYTES].join(', ')} (got ${resolved.keyLength})`,
      );
    }
    if (!Number.isInteger(resolved.iterations) || resolved.iterations < 1) {
      throw new Error(`KeyManager: iterations must be a positive integer (got ${resolved.iterations})`);
    }

    this.config = resolved;
  }

  // ── Key Generation ───────────────────────────────────────

  /**
   * Generate a new data encryption key (DEK), wrap it with the KEK,
   * and return a WrappedKey for persistent storage.
   */
  async generateKey(): Promise<WrappedKey> {
    const version = this.highestVersion + 1;
    const dek = crypto.randomBytes(this.config.keyLength);
    // The wrap comes first: if the key-encryption key cannot be derived the
    // version is not consumed, so a retry still produces v1 and the history has
    // no hole where a key was supposed to be.
    const createdAt = Date.now();
    const wrapped = await this._wrapKeyAt(dek, version, createdAt);

    this.highestVersion = version;
    this.currentVersion = version;
    this.keyHistory.set(version, { version, key: dek, createdAt });

    return wrapped;
  }

  /**
   * Load a previously wrapped key into the key history.
   *
   * Loading always unwraps: there used to be an `unwrapNow` flag whose "lazy"
   * branch was a copy of the eager one, so the flag did nothing but promise a
   * behaviour that did not exist.
   *
   * A version identifies one key. Loading a version that is already present with
   * the *same* material is a no-op; with different material it throws, because
   * silently replacing it would make v1 mean two keys at once and every byte
   * already sealed under the first one undecryptable without an error.
   */
  async loadKey(wrapped: WrappedKey): Promise<number> {
    const version = wrapped.version;
    const dek = await this.unwrapKey(wrapped);
    const existing = this.keyHistory.get(version);

    if (existing) {
      // `Buffer.equals` compares the length as well, so a separate length test
      // here was a mutant no run could distinguish — and a reader could only
      // wonder whether it was load-bearing.
      const same = existing.key.equals(dek);
      dek.fill(0);
      if (!same) {
        throw new Error(`KeyManager: version ${version} already holds different key material; refusing to replace it`);
      }
      return version;
    }

    this.keyHistory.set(version, { version, key: dek, createdAt: wrapped.createdAt });
    if (version > this.highestVersion) this.highestVersion = version;
    if (version > this.currentVersion) this.currentVersion = version;

    return version;
  }

  // ── Key Wrapping / Unwrapping ─────────────────────────────

  /**
   * Wrap a DEK with the KEK using AES-256-GCM.
   */
  async wrapKey(dek: Buffer, version: number): Promise<WrappedKey> {
    return this._wrapKeyAt(dek, version, Date.now());
  }

  /**
   * `wrapKey` with the creation timestamp supplied by the caller, so that the
   * wrapped key and the history entry it becomes are dated by one clock read
   * rather than two. A millisecond of drift there is a key whose export reports
   * a different birthday from the key it was exported from.
   */
  private async _wrapKeyAt(dek: Buffer, version: number, createdAt: number): Promise<WrappedKey> {
    const kek = await this._deriveKEK();
    const iv = crypto.randomBytes(12);

    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv, {
        authTagLength: 16,
      });

      const encryptedKey = Buffer.concat([cipher.update(dek), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        version,
        iv,
        encryptedKey,
        authTag,
        salt: this.config.salt,
        iterations: this.config.iterations,
        createdAt,
      };
    } finally {
      // One exit for the key-encryption key: the `try` covers `createCipheriv`
      // as well, which throws before there is anything to return.
      kek.fill(0);
    }
  }

  /**
   * Unwrap a DEK from a WrappedKey using the KEK.
   */
  async unwrapKey(wrapped: WrappedKey): Promise<Buffer> {
    const kek = await this._deriveKEK(wrapped.salt, wrapped.iterations);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', kek, wrapped.iv, {
        authTagLength: 16,
      });

      decipher.setAuthTag(wrapped.authTag);
      const dek = Buffer.concat([decipher.update(wrapped.encryptedKey), decipher.final()]);

      // Zeroize KEK
      kek.fill(0);

      return dek;
    } catch (error) {
      kek.fill(0);
      throw new Error(`KeyManager: failed to unwrap key v${wrapped.version}: ${String(error)}`);
    }
  }

  /**
   * Export all keys as wrapped form (for backup/transfer).
   */
  async exportWrappedKeys(): Promise<WrappedKey[]> {
    const results: WrappedKey[] = [];
    // Ordered by version, not by the order keys happened to be loaded in: an
    // export is consumed by a destination that replays it, and `[3, 1, 2]` is a
    // sequence nobody expects to have to sort.
    const pairs = [...this.keyHistory.values()].sort((a, b) => a.version - b.version);
    for (const pair of pairs) {
      results.push(await this._wrapKeyAt(pair.key, pair.version, pair.createdAt));
    }
    return results;
  }

  // ── Key Access ───────────────────────────────────────────

  /**
   * Get the currently active DEK.
   */
  getCurrentKey(): Buffer | null {
    const key = this.keyHistory.get(this.currentVersion)?.key;
    // A copy: the caller is expected to zeroize what it was given, and handing
    // out the stored buffer means one caller's hygiene destroys the key for
    // every other one.
    return key ? Buffer.from(key) : null;
  }

  /**
   * Get a DEK by version.
   */
  getKey(version: number): Buffer | null {
    const key = this.keyHistory.get(version)?.key;
    return key ? Buffer.from(key) : null;
  }

  /**
   * Check if a key version is available.
   */
  hasKeyVersion(version: number): boolean {
    return this.keyHistory.has(version);
  }

  /**
   * Current key version.
   */
  get version(): number {
    return this.currentVersion;
  }

  /**
   * Number of managed key versions.
   */
  get versionCount(): number {
    return this.keyHistory.size;
  }

  /**
   * Zeroize all keys in memory.
   * After zeroization, decryption will fail.
   */
  zeroize(): void {
    for (const pair of this.keyHistory.values()) {
      pair.key.fill(0);
    }
    this.keyHistory.clear();
    this.currentVersion = 0;
    // `highestVersion` deliberately survives: see its declaration.
  }

  // ── Internal ─────────────────────────────────────────────

  private async _deriveKEK(salt?: Buffer, iterations?: number): Promise<Buffer> {
    const effectiveSalt = salt ?? this.config.salt;
    const effectiveIterations = iterations ?? this.config.iterations;

    return new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(
        this.config.masterSecret,
        effectiveSalt,
        effectiveIterations,
        // Always 32 bytes: this derives the key *wrapping* key, and the wrapping
        // cipher is fixed at AES-256-GCM. Deriving `keyLength` bytes here made
        // `keyLength: 16` fail every wrap with "Invalid key length".
        KEK_BYTES,
        this.config.hashAlgorithm,
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        },
      );
    });
  }
}
