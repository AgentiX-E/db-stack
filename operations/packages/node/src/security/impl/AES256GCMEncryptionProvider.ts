/**
 * I27 — E1 AES-256-GCM Encryption Provider.
 *
 * Production-grade authenticated encryption using AES-256-GCM.
 * Replaces the XOR stub with proper AEAD:
 *   - AES-256-GCM (NIST SP 800-38D) — authenticated encryption
 *   - Random 96-bit IV per encryption operation (NIST recommended)
 *   - 128-bit authentication tag
 *   - Associated data binding: binds encrypted blobs to a context string
 *     to prevent cross-context replay (tamper detection)
 *   - Key versioning: prepended to ciphertext for key rotation compatibility
 *   - Constant-time decryption: verifies tag before plaintext release
 */

import crypto from 'crypto';
import type { IEncryptionManager, EncryptionConfig } from '../interfaces/index.js';

// ── Constants ──────────────────────────────────────────────

const AES_KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (NIST recommended for GCM)
const TAG_LENGTH = 16; // 128 bits
const KEY_VERSION_PREFIX_LENGTH = 4; // uint32 BE

/** Wire format:
 * ┌─────────┬──────┬─────────┬────────────┐
 * │ version │  IV  │ cipher- │ auth tag   │
 * │ (4B BE) │(12B) │  text   │  (16B)     │
 * └─────────┴──────┴─────────┴────────────┘
 */

// ── AES256GCMEncryptionProvider ────────────────────────────

export class AES256GCMEncryptionProvider implements IEncryptionManager {
  private masterKey: Buffer = Buffer.alloc(0);
  private keyVersion = 0;
  private enabled = false;
  private config: EncryptionConfig | null = null;

  /**
   * Highest version ever issued. Survives `zeroize()` for the same reason it does
   * in `KeyManager`: a version number names one key, and reissuing a retired name
   * makes a new key share it with material that may still be in a blob header.
   */
  private highestVersion = 0;

  // Key version history for rotation
  private keyHistory = new Map<number, Buffer>();

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Start the cipher, or confirm the running one.
   *
   * A second call used to mint a fresh key into version 1, which overwrote the v1
   * every blob written so far named: the data became unreadable while the header
   * still claimed to record how it was sealed. Initialising is not a reset. Once
   * the cipher runs, the same configuration is a no-op and a different algorithm
   * is refused, because re-sealing what is on disk is not something this class can
   * do from here.
   */
  async initialize(config: EncryptionConfig): Promise<void> {
    if (this.enabled) {
      if (this.config && this.config.algorithm !== config.algorithm) {
        throw new Error(
          `AES256GCM: cannot switch algorithm from ${this.config.algorithm} to ${config.algorithm} ` +
            'while keys are in use — existing blobs were sealed with the first',
        );
      }
      return;
    }

    this.config = config;
    this.masterKey = crypto.randomBytes(AES_KEY_LENGTH);
    this.keyVersion = this.highestVersion + 1;
    this.highestVersion = this.keyVersion;
    this.keyHistory.set(this.keyVersion, this.masterKey);
    this.enabled = true;
  }

  /**
   * Wipe the key material and stop the provider.
   *
   * Not part of `IEncryptionManager` — the interface stops at rotation — but a
   * class that holds a master key forever with no way to drop it is a class that
   * cannot be shut down cleanly.
   */
  zeroize(): void {
    for (const key of this.keyHistory.values()) key.fill(0);
    this.keyHistory.clear();
    this.masterKey.fill(0);
    this.masterKey = Buffer.alloc(0);
    this.keyVersion = 0;
    this.enabled = false;
  }

  // ── Encrypt ──────────────────────────────────────────────

  async encrypt(plaintext: Buffer, context?: string): Promise<Buffer> {
    this._ensureInitialized();

    const iv = crypto.randomBytes(IV_LENGTH);
    const aad = this._buildAAD(context);

    // No `authTagLength` option: 16 bytes is GCM's own default and the length the
    // wire format slices, so naming it two ways only created a mutant that said
    // `{}` and meant the same thing.
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);

    if (aad) {
      cipher.setAAD(aad);
    }

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Assemble: [version(4B BE)] [IV(12B)] [ciphertext] [authTag(16B)]
    const versionBuf = Buffer.alloc(KEY_VERSION_PREFIX_LENGTH);
    versionBuf.writeUInt32BE(this.keyVersion, 0);

    return Buffer.concat([versionBuf, iv, encrypted, authTag]);
  }

  // ── Decrypt ──────────────────────────────────────────────

  async decrypt(ciphertext: Buffer, context?: string): Promise<Buffer> {
    this._ensureInitialized();

    if (ciphertext.length < KEY_VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH) {
      throw new Error(
        `AES256GCM: ciphertext too short (${ciphertext.length}B, minimum ${KEY_VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH}B)`,
      );
    }

    // Parse wire format
    let offset = 0;

    const version = ciphertext.readUInt32BE(offset);
    offset += KEY_VERSION_PREFIX_LENGTH;

    const iv = ciphertext.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
    const encrypted = ciphertext.subarray(offset, ciphertext.length - TAG_LENGTH);

    // Resolve the key for the version named in the header. There is deliberately
    // no fallback to the current key: the version prefix is not covered by the
    // AEAD tag, so accepting an unknown version would let anyone relabel a blob
    // with an arbitrary version number and still have it decrypt successfully.
    // That would also make a re-encryption audit unreliable, because the header
    // is the only record of which key a blob was written with.
    const key = this.keyHistory.get(version);
    if (!key) {
      throw new Error(`AES256GCM: unknown key version ${version}`);
    }

    const aad = this._buildAAD(context);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

      decipher.setAuthTag(tag);
      if (aad) {
        decipher.setAAD(aad);
      }

      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
      throw new Error(`AES256GCM: decryption failed — tag mismatch or corrupted data: ${String(error)}`);
    }
  }

  // ── Key Rotation ─────────────────────────────────────────

  async rotateKey(): Promise<void> {
    this._ensureInitialized();

    // Preserve old key in history (needed for decrypting old blobs)
    const newKey = crypto.randomBytes(AES_KEY_LENGTH);
    this.keyVersion = this.highestVersion + 1;
    // `highestVersion` until now was only advanced by `initialize()`, so a
    // rotation that came before a wipe was forgotten: the next `initialize()`
    // issued the name a retired key still answers to.
    this.highestVersion = this.keyVersion;
    this.keyHistory.set(this.keyVersion, newKey);
    this.masterKey = newKey;
  }

  // ── Status ───────────────────────────────────────────────

  isEnabled(): boolean {
    return this.enabled;
  }

  getCurrentKeyVersion(): number {
    return this.keyVersion;
  }

  getKeyVersionCount(): number {
    return this.keyHistory.size;
  }

  /** Check whether a specific key version is available for decryption. */
  hasKeyVersion(version: number): boolean {
    return this.keyHistory.has(version);
  }

  // ── Internal ─────────────────────────────────────────────

  private _buildAAD(context?: string): Buffer | undefined {
    if (!context) return undefined;
    return Buffer.from(context);
  }

  private _ensureInitialized(): void {
    // `enabled` is the whole state: it is false before the first `initialize()`,
    // false after `zeroize()`, and the only path that clears the key sets it.
    if (!this.enabled) {
      throw new Error('AES256GCM: not initialized. Call initialize() first.');
    }
  }
}
