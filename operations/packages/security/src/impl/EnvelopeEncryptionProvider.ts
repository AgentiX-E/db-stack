/**
 * I27 — E1 Envelope Encryption Provider.
 *
 * Implements envelope encryption using the KeyManager + AES-256-GCM.
 *
 * Envelope pattern:
 *   1. A Data Encryption Key (DEK) is generated per encryption session
 *   2. The DEK is wrapped (encrypted) with the Key Encryption Key (KEK)
 *      derived from the master secret via PBKDF2
 *   3. The wrapped DEK is prepended to each ciphertext blob
 *   4. Decryption: unwrap DEK using KEK → decrypt payload
 *
 * This allows key rotation without re-encrypting all data:
 * just rotate the KEK and re-wrap the DEKs.
 *
 * Wire format (envelope mode):
 * ┌──────────┬───────────────┬───────────────┐
 * │ wrapped  │   ciphertext  │     total     │
 * │  DEK     │   (AES-GCM)   │     blob      │
 * │ (varies) │   (REST)      │               │
 * └──────────┴───────────────┴───────────────┘
 */

import { AES256GCMEncryptionProvider } from './AES256GCMEncryptionProvider.js';
import { KeyManager, type WrappedKey, type KeyManagerConfig } from './KeyManager.js';
import type { IEncryptionManager, EncryptionConfig } from '../interfaces/index.js';
import crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────

export interface EnvelopeEncryptionConfig {
  /** Key manager configuration */
  keyManager: KeyManagerConfig;
  /** Encryption provider configuration */
  encryption: EncryptionConfig;
  /** Whether to auto-generate a DEK on init. Default: true */
  autoGenerateKey?: boolean;
}

// ── Header format ───────────────────────────────────────────
//
// [wrappedKeyLength(4B BE)] [wrappedKey JSON] [IV(12B)] [ciphertext] [tag(16B)]
//
// The wrapped key is serialized as JSON to keep it self-describing.
// This pattern is used by AWS KMS, GCP KMS, and Vault Transit Engine.
//

const HEADER_PREFIX_LENGTH = 4; // uint32 BE: wrapped key length

// ── EnvelopeEncryptionProvider ──────────────────────────────

export class EnvelopeEncryptionProvider implements IEncryptionManager {
  private keyManager: KeyManager;
  private encProvider: AES256GCMEncryptionProvider;
  private enabled = false;
  private config: EnvelopeEncryptionConfig | null = null;
  private currentDek: Buffer | null = null;

  /** Bytes of data key the configured cipher requires. */
  private static readonly KEY_BYTES_BY_ALGORITHM: Record<EncryptionConfig['algorithm'], number> = {
    'aes-256-gcm': 32,
    'chacha20-poly1305': 32,
  };

  constructor(config: EnvelopeEncryptionConfig) {
    this.config = config;

    // The cipher is fixed by configuration, so the data key length is not a
    // preference: the key manager allows 16/24/32 because wrapping does not care,
    // while the payload cipher does. Naming the mismatch here beats
    // `Invalid key length` thrown from `crypto` on the first write.
    const required = EnvelopeEncryptionProvider.KEY_BYTES_BY_ALGORITHM[config.encryption.algorithm];
    const configured = config.keyManager.keyLength ?? 32;
    if (configured !== required) {
      throw new Error(
        `EnvelopeEncryption: encryption.algorithm is ${config.encryption.algorithm}, which needs a ` +
          `${required}-byte data key; keyManager.keyLength is ${configured}`,
      );
    }

    this.keyManager = new KeyManager(config.keyManager);
    this.encProvider = new AES256GCMEncryptionProvider();
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async initialize(encConfig: EncryptionConfig): Promise<void> {
    await this.encProvider.initialize(encConfig);

    // No key is minted here. Initializing is not writing: a provider that spends
    // v1 on startup cannot then accept a restored v1, because a version number
    // names one key and the backup's key is the one the archived blobs were
    // sealed with. The first `encrypt()` mints the version instead.
    this.enabled = true;
  }

  // ── Encrypt ──────────────────────────────────────────────

  async encrypt(plaintext: Buffer, context?: string): Promise<Buffer> {
    // No `_ensureInitialized()` call here: the only way to get a data key is
    // through `rotateKey()`/`_activeDek()`, which refuse on an uninitialized
    // provider, so a second guard in front of them was a statement no run could
    // distinguish from its absence.
    // Encrypt with current DEK
    const dek = await this._activeDek();
    const encrypted = await this._encryptWithDEK(dek, plaintext, context);

    // Get the wrapped form of the current DEK
    const wrappedKey = await this.keyManager.wrapKey(dek, this.keyManager.version);

    // Serialize wrapped key (convert Buffers to arrays for JSON)
    const serializableWrappedKey = {
      ...wrappedKey,
      iv: Array.from(wrappedKey.iv),
      encryptedKey: Array.from(wrappedKey.encryptedKey),
      authTag: Array.from(wrappedKey.authTag),
      salt: Array.from(wrappedKey.salt),
    };
    const wrappedKeyJson = JSON.stringify(serializableWrappedKey);
    const wrappedKeyBuf = Buffer.from(wrappedKeyJson, 'utf-8');
    const lenBuf = Buffer.alloc(HEADER_PREFIX_LENGTH);
    lenBuf.writeUInt32BE(wrappedKeyBuf.length, 0);

    return Buffer.concat([lenBuf, wrappedKeyBuf, encrypted]);
  }

  // ── Decrypt ──────────────────────────────────────────────

  async decrypt(ciphertext: Buffer, context?: string): Promise<Buffer> {
    this._ensureInitialized();

    if (ciphertext.length < HEADER_PREFIX_LENGTH) {
      throw new Error(`EnvelopeEncryption: ciphertext too short (${ciphertext.length}B)`);
    }

    // Parse header
    let offset = 0;
    const wrappedKeyLen = ciphertext.readUInt32BE(offset);
    offset += HEADER_PREFIX_LENGTH;

    if (ciphertext.length < HEADER_PREFIX_LENGTH + wrappedKeyLen + 12) {
      throw new Error(`EnvelopeEncryption: incomplete header (wrapped key length: ${wrappedKeyLen})`);
    }

    const wrappedKeyJson = ciphertext.subarray(offset, offset + wrappedKeyLen).toString('utf-8');
    offset += wrappedKeyLen;

    const encrypted = ciphertext.subarray(offset);

    // Parse wrapped key
    let wrappedKey: WrappedKey;
    try {
      wrappedKey = JSON.parse(wrappedKeyJson) as WrappedKey;
      // JSON.parse converts Buffers to plain objects — revive them
      wrappedKey = {
        ...wrappedKey,
        iv: Buffer.from(wrappedKey.iv),
        encryptedKey: Buffer.from(wrappedKey.encryptedKey),
        authTag: Buffer.from(wrappedKey.authTag),
        salt: Buffer.from(wrappedKey.salt),
      };
    } catch {
      throw new Error('EnvelopeEncryption: invalid wrapped key JSON in header');
    }

    // Unwrap DEK
    const dek = await this.keyManager.unwrapKey(wrappedKey);

    try {
      // Decrypt with unwrapped DEK
      return await this._encryptWithDEK(dek, encrypted, context, true);
    } finally {
      // Zeroize the unwrapped DEK
      dek.fill(0);
    }
  }

  // ── Key Rotation ─────────────────────────────────────────

  async rotateKey(): Promise<void> {
    this._ensureInitialized();

    // Generate new DEK
    const wrapped = await this.keyManager.generateKey();
    this.currentDek = this.keyManager.getCurrentKey();
  }

  // ── Status ───────────────────────────────────────────────

  isEnabled(): boolean {
    return this.enabled;
  }

  getCurrentKeyVersion(): number {
    return this.keyManager.version;
  }

  getKeyVersionCount(): number {
    return this.keyManager.versionCount;
  }

  /**
   * Test whether a blobs encrypted with a specific key version can be decrypted.
   */
  canDecryptVersion(version: number): boolean {
    // Only the key history answers this. It used to be
    // `hasKeyVersion(v) || encProvider.isEnabled()`, and since the cipher is
    // enabled for the whole life of the provider, every version number — including
    // ones that never existed — was reported decryptable.
    return this.keyManager.hasKeyVersion(version);
  }

  /**
   * Export all wrapped DEKs (for backup / key escrow).
   */
  async exportKeys(): Promise<WrappedKey[]> {
    return this.keyManager.exportWrappedKeys();
  }

  /**
   * Load a previously exported wrapped key.
   */
  async importKey(wrapped: WrappedKey): Promise<number> {
    return this.keyManager.loadKey(wrapped);
  }

  /**
   * Zeroize all key material. Irreversible.
   */
  zeroize(): void {
    this.keyManager.zeroize();
    this.currentDek = null;
    this.enabled = false;
  }

  // ── Internal: AES-GCM with a specific DEK ──────────────────

  private async _encryptWithDEK(dek: Buffer, data: Buffer, context?: string, decrypt = false): Promise<Buffer> {
    const iv = crypto.randomBytes(12);
    const aad = context ? Buffer.from(context, 'utf-8') : undefined;

    if (decrypt) {
      // Parsing: [IV(12B)] [ciphertext] [tag(16B)]
      if (data.length < 12 + 16) {
        throw new Error(`EnvelopeEncryption: data too short for AES-GCM (${data.length}B)`);
      }

      const msgIV = data.subarray(0, 12);
      const tag = data.subarray(data.length - 16);
      const encrypted = data.subarray(12, data.length - 16);

      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', dek, msgIV, {
          authTagLength: 16,
        });
        decipher.setAuthTag(tag);
        if (aad) decipher.setAAD(aad);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch (error) {
        throw new Error(`EnvelopeEncryption: AES-GCM decryption failed: ${String(error)}`);
      }
    } else {
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, {
        authTagLength: 16,
      });
      if (aad) cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();

      return Buffer.concat([iv, encrypted, tag]);
    }
  }

  /**
   * The key to encrypt with: the current one, minted on first use when the
   * configuration allows it.
   */
  private async _activeDek(): Promise<Buffer> {
    if (this.currentDek) return this.currentDek;

    if (this.config?.autoGenerateKey === false) {
      throw new Error('EnvelopeEncryption: no DEK available. Call initialize() first.');
    }

    await this.rotateKey();
    return this.currentDek!;
  }

  private _ensureInitialized(): void {
    if (!this.enabled) {
      throw new Error('EnvelopeEncryption: not initialized. Call initialize() first.');
    }
  }
}
