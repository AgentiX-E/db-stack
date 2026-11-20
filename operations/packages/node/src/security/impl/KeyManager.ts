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

/**
 * Highest PBKDF2 work factor this manager will honour from a *wrapped key*.
 *
 * The salt and the iteration count travel inside the wrapped key, which travels
 * inside the ciphertext. So the work the reader pays is chosen by the data it is
 * reading, and a one-line edit to a header turned a 100 ms read into an unbounded
 * one. This is the ceiling, and it is deliberately ~16× the OWASP 2024 default so
 * a deployment can raise its own cost without hitting it.
 */
export const MAX_DERIVATION_ITERATIONS = 10_000_000;

/** Bounds on the salt a wrapped key may carry. */
export const MIN_SALT_BYTES = 16;
export const MAX_SALT_BYTES = 64;

/**
 * How many derived key-encryption keys stay resident.
 *
 * The cache key contains a salt taken from a header, so it is sized: a caller who
 * feeds the process blobs with 200 distinct salts should pay 200 derivations, not
 * hold 200 wrapping keys. FIFO is enough — the working set of a real deployment is
 * one salt per key generation, and eviction only costs a re-derivation.
 */
export const MAX_CACHED_KEKS = 64;

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

  /**
   * Derived key-encryption keys, keyed by the parameters that produced them.
   *
   * A wrap used to cost a full PBKDF2 derivation — 600 000 iterations, ~100 ms —
   * so every write paid it again for a key the process had derived a moment
   * earlier. The cache removes that without changing a byte on disk: only the
   * *derivation* is reused, never the wrapped blob, because reusing a wrapped key
   * would put the same key and the same IV in every ciphertext header.
   *
   * Ownership: the cache owns these buffers. `_wrapKeyAt` and `unwrapKey` use them
   * and must not wipe them; `zeroize()` is the only owner that clears them.
   */
  private readonly kekCache = new Map<string, Buffer>();

  /** Number of PBKDF2 derivations performed. A write path that grows this is paying KDF cost per write. */
  private derivations = 0;

  /**
   * Serialises operations that allocate or install a version number.
   *
   * `generateKey()` reads `highestVersion`, awaits the wrap, and then commits. Two
   * concurrent calls both read the same value, both minted a key, and both
   * committed to the same version — the map kept the second and the first key
   * disappeared while the wrapped form the caller held still pointed at it. The
   * queue is the smallest thing that makes the read and the commit one step.
   */
  private minting: Promise<unknown> = Promise.resolve();

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
    return this._serial(async () => {
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
    });
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
    // Through the same queue as `generateKey`: an import that lands between a
    // mint's version read and its commit would otherwise be able to claim the
    // name the mint is about to take.
    return this._serial(() => this._loadKey(wrapped));
  }

  private async _loadKey(wrapped: WrappedKey): Promise<number> {
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
    // Monotonic, expressed as such: `if (version > x) x = version` and the same
    // line with `>=` assign identically, which is a mutant no test can tell from
    // its replacement. `Math.max` says "the higher of the two" once, and its own
    // mutants (`Math.min`) change the answer.
    this.highestVersion = Math.max(this.highestVersion, version);
    this.currentVersion = Math.max(this.currentVersion, version);

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

    // No `finally { kek.fill(0) }` here any more: `kek` is the cache's buffer, and
    // wiping it on the way out of one wrap would leave the cache holding 32 zero
    // bytes — a wrap that silently seals with a key derived from nothing. The
    // cache's owner wipes it, and that owner is `zeroize()`.
    // No `authTagLength`: 16 is GCM's default and the length the wire format
    // carries, so naming it here only offered a mutant that said `{}`.
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);

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
  }

  /**
   * Unwrap a DEK from a WrappedKey using the KEK.
   *
   * The salt and iteration count come out of the wrapped key, which comes out of
   * the blob, so both are validated before they are used: the range is a policy,
   * not a preference, because "how much CPU the reader spends" is not a decision
   * the writer of a file gets to make.
   */
  async unwrapKey(wrapped: WrappedKey): Promise<Buffer> {
    this._validateWrapParameters(wrapped);
    const kek = await this._deriveKEK(wrapped.salt, wrapped.iterations);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', kek, wrapped.iv);

      decipher.setAuthTag(wrapped.authTag);
      return Buffer.concat([decipher.update(wrapped.encryptedKey), decipher.final()]);
    } catch (error) {
      throw new Error(`KeyManager: failed to unwrap key v${wrapped.version}: ${String(error)}`);
    }
  }

  /** Refuse a wrapped key whose derivation parameters are outside the documented range. */
  private _validateWrapParameters(wrapped: WrappedKey): void {
    const iterations = wrapped.iterations;
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_DERIVATION_ITERATIONS) {
      throw new Error(
        `KeyManager: refusing a work factor of ${iterations} PBKDF2 iterations ` +
          `(allowed 1–${MAX_DERIVATION_ITERATIONS})`,
      );
    }
    const saltBytes = wrapped.salt?.length ?? 0;
    if (saltBytes < MIN_SALT_BYTES || saltBytes > MAX_SALT_BYTES) {
      throw new Error(
        `KeyManager: refusing a ${saltBytes}-byte salt in a wrapped key ` +
          `(allowed ${MIN_SALT_BYTES}–${MAX_SALT_BYTES})`,
      );
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
    // The cached wrapping keys are key material by any reading of the word: a
    // `zeroize()` that left them resident would mean the wipe could be undone by
    // the next `unwrapKey` without ever touching the master secret.
    for (const kek of this.kekCache.values()) {
      kek.fill(0);
    }
    this.kekCache.clear();
    this.currentVersion = 0;
    // `highestVersion` deliberately survives: see its declaration.
  }

  /** How many PBKDF2 derivations this manager has performed. */
  get keyDerivationCount(): number {
    return this.derivations;
  }

  /** How many derived key-encryption keys are resident. */
  get kekCacheSize(): number {
    return this.kekCache.size;
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Run `op` after every previously queued operation has settled.
   *
   * A rejected operation does not poison the queue: the tail is built from a
   * promise that cannot reject, while the caller still sees the real outcome.
   */
  private _serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.minting.then(op, op);
    // The tail is `run` itself. `then(op, op)` installs the next operation as
    // *both* handlers, so a rejected tail still runs it — the chain never has to
    // be "repaired", and an extra `then(() => {}, () => {})` here was two
    // statements whose removal no run could observe.
    this.minting = run;
    return run;
  }

  private async _deriveKEK(salt?: Buffer, iterations?: number): Promise<Buffer> {
    const effectiveSalt = salt ?? this.config.salt;
    const effectiveIterations = iterations ?? this.config.iterations;

    // Both inputs are fixed by configuration on the wrap path and come from a
    // header on the unwrap path, which is why the stored buffer is bounded in
    // number and never handed out for wiping.
    const cacheKey = `${effectiveSalt.toString('hex')}:${effectiveIterations}`;
    const cached = this.kekCache.get(cacheKey);
    if (cached) return cached;

    const derived = await new Promise<Buffer>((resolve, reject) => {
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

    this.derivations++;
    this.kekCache.set(cacheKey, derived);
    // FIFO: `Map` iterates in insertion order, and the oldest entry is the one a
    // working set is least likely to ask for again.
    while (this.kekCache.size > MAX_CACHED_KEKS) {
      const oldest = this.kekCache.keys().next().value as string;
      this.kekCache.get(oldest)?.fill(0);
      this.kekCache.delete(oldest);
    }

    return derived;
  }
}
