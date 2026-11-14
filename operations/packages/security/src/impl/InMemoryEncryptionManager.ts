import type { IEncryptionManager, EncryptionConfig } from '../interfaces/index.js';
import crypto from 'crypto';

export class InMemoryEncryptionManager implements IEncryptionManager {
  private _config: EncryptionConfig | null = null;
  private _key: Buffer = Buffer.alloc(0);
  private _keyVersion: number = 0;

  async initialize(config: EncryptionConfig): Promise<void> {
    this._config = config;
    this._key = crypto.randomBytes(32);
    this._keyVersion = 1;
  }

  async encrypt(plaintext: Buffer, _context?: string): Promise<Buffer> {
    if (!this._key.length) {
      throw new Error('EncryptionManager: not initialized');
    }
    const result = Buffer.alloc(plaintext.length);
    const keyLen = this._key.length;
    for (let i = 0; i < plaintext.length; i++) {
      result[i] = plaintext[i]! ^ this._key[i % keyLen]!;
    }
    return result;
  }

  async decrypt(ciphertext: Buffer, _context?: string): Promise<Buffer> {
    if (!this._key.length) {
      throw new Error('EncryptionManager: not initialized');
    }
    // XOR is symmetric
    const result = Buffer.alloc(ciphertext.length);
    const keyLen = this._key.length;
    for (let i = 0; i < ciphertext.length; i++) {
      result[i] = ciphertext[i]! ^ this._key[i % keyLen]!;
    }
    return result;
  }

  async rotateKey(): Promise<void> {
    this._key = crypto.randomBytes(32);
    this._keyVersion++;
  }

  isEnabled(): boolean {
    return this._config !== null;
  }

  // Test helpers
  getKeyVersion(): number {
    return this._keyVersion;
  }

  getKey(): Buffer {
    return this._key;
  }
}
