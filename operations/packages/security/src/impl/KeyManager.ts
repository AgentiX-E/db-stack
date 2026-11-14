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

import crypto from "crypto";

// ── Types ──────────────────────────────────────────────────

export interface KeyManagerConfig {
  /** Password or secret from which the KEK is derived. */
  masterSecret: string;
  /** Salt for PBKDF2 derivation (should be stored alongside wrapped key). */
  salt?: Buffer;
  /** PBKDF2 iterations. Default: 600_000 (OWASP 2024 recommendation). */
  iterations: number;
  /** Key length in bytes. Default: 32 (256-bit). */
  keyLength: number;
  /** Hash algorithm for PBKDF2. Default: "sha256". */
  hashAlgorithm: string;
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

const DEFAULT_CONFIG: Omit<KeyManagerConfig, "masterSecret"> = {
  iterations: 600_000,
  keyLength: 32,
  hashAlgorithm: "sha256",
};

// ── KeyManager ─────────────────────────────────────────────

export class KeyManager {
  private config: KeyManagerConfig;
  private keyHistory = new Map<number, KeyPair>();
  private currentVersion = 0;

  constructor(config: KeyManagerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.salt) {
      this.config.salt = crypto.randomBytes(32);
    }
  }

  // ── Key Generation ───────────────────────────────────────

  /**
   * Generate a new data encryption key (DEK), wrap it with the KEK,
   * and return a WrappedKey for persistent storage.
   */
  async generateKey(): Promise<WrappedKey> {
    this.currentVersion++;
    const dek = crypto.randomBytes(this.config.keyLength);
    const wrapped = await this.wrapKey(dek, this.currentVersion);

    // Store in key history
    this.keyHistory.set(this.currentVersion, {
      version: this.currentVersion,
      key: dek,
      createdAt: Date.now(),
    });

    return wrapped;
  }

  /**
   * Load a previously wrapped key into the key history.
   * The DEK is unwrapped on demand (lazy) or immediately if `unwrapNow` is true.
   */
  async loadKey(wrapped: WrappedKey, unwrapNow = true): Promise<number> {
    const version = wrapped.version;

    if (unwrapNow) {
      const dek = await this.unwrapKey(wrapped);
      this.keyHistory.set(version, { version, key: dek, createdAt: wrapped.createdAt });
    } else {
      // Lazy: store wrapped key for later unwrapping
      // (Not implemented here — for now always unwrap immediately)
      const dek = await this.unwrapKey(wrapped);
      this.keyHistory.set(version, { version, key: dek, createdAt: wrapped.createdAt });
    }

    if (version > this.currentVersion) {
      this.currentVersion = version;
    }

    return version;
  }

  // ── Key Wrapping / Unwrapping ─────────────────────────────

  /**
   * Wrap a DEK with the KEK using AES-256-GCM.
   */
  async wrapKey(dek: Buffer, version: number): Promise<WrappedKey> {
    const kek = await this._deriveKEK();
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv, {
      authTagLength: 16,
    });

    const encryptedKey = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Zeroize KEK from memory
    kek.fill(0);

    return {
      version,
      iv,
      encryptedKey,
      authTag,
      salt: this.config.salt!,
      iterations: this.config.iterations,
      createdAt: Date.now(),
    };
  }

  /**
   * Unwrap a DEK from a WrappedKey using the KEK.
   */
  async unwrapKey(wrapped: WrappedKey): Promise<Buffer> {
    const kek = await this._deriveKEK(wrapped.salt, wrapped.iterations);

    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", kek, wrapped.iv, {
        authTagLength: 16,
      });

      decipher.setAuthTag(wrapped.authTag);
      const dek = Buffer.concat([
        decipher.update(wrapped.encryptedKey),
        decipher.final(),
      ]);

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
    for (const pair of this.keyHistory.values()) {
      const wrapped = await this.wrapKey(pair.key, pair.version);
      // Restore original creation time
      wrapped.createdAt = pair.createdAt;
      results.push(wrapped);
    }
    return results;
  }

  // ── Key Access ───────────────────────────────────────────

  /**
   * Get the currently active DEK.
   */
  getCurrentKey(): Buffer | null {
    return this.keyHistory.get(this.currentVersion)?.key ?? null;
  }

  /**
   * Get a DEK by version.
   */
  getKey(version: number): Buffer | null {
    return this.keyHistory.get(version)?.key ?? null;
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
  }

  // ── Internal ─────────────────────────────────────────────

  private async _deriveKEK(
    salt?: Buffer,
    iterations?: number,
  ): Promise<Buffer> {
    const effectiveSalt = salt ?? this.config.salt!;
    const effectiveIterations = iterations ?? this.config.iterations;

    return new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(
        this.config.masterSecret,
        effectiveSalt,
        effectiveIterations,
        this.config.keyLength,
        this.config.hashAlgorithm,
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        },
      );
    });
  }
}
