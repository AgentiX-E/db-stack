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

import crypto from "crypto";
import type { IEncryptionManager, EncryptionConfig } from "../interfaces/index.js";

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

  // Key version history for rotation
  private keyHistory = new Map<number, Buffer>();

  // ── Lifecycle ─────────────────────────────────────────────

  async initialize(config: EncryptionConfig): Promise<void> {
    this.config = config;
    this.masterKey = crypto.randomBytes(AES_KEY_LENGTH);
    this.keyVersion = 1;
    this.keyHistory.set(1, this.masterKey);
    this.enabled = true;
  }

  // ── Encrypt ──────────────────────────────────────────────

  async encrypt(plaintext: Buffer, context?: string): Promise<Buffer> {
    this._ensureInitialized();

    const iv = crypto.randomBytes(IV_LENGTH);
    const aad = this._buildAAD(context);

    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv, {
      authTagLength: TAG_LENGTH,
    });

    if (aad) {
      cipher.setAAD(aad);
    }

    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
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

    // Resolve key for the version
    const key = this.keyHistory.get(version) ?? this.masterKey;
    if (!key || key.length === 0) {
      throw new Error(`AES256GCM: unknown key version ${version}`);
    }

    const aad = this._buildAAD(context);

    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_LENGTH,
      });

      decipher.setAuthTag(tag);
      if (aad) {
        decipher.setAAD(aad);
      }

      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
      throw new Error(
        `AES256GCM: decryption failed — tag mismatch or corrupted data: ${String(error)}`,
      );
    }
  }

  // ── Key Rotation ─────────────────────────────────────────

  async rotateKey(): Promise<void> {
    this._ensureInitialized();

    // Preserve old key in history (needed for decrypting old blobs)
    const newKey = crypto.randomBytes(AES_KEY_LENGTH);
    this.keyVersion++;
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
    return Buffer.from(context, "utf-8");
  }

  private _ensureInitialized(): void {
    if (!this.enabled || !this.masterKey || this.masterKey.length === 0) {
      throw new Error("AES256GCM: not initialized. Call initialize() first.");
    }
  }
}
