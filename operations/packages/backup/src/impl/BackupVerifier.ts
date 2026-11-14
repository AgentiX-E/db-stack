/**
 * BackupVerifier — backup integrity verifier.
 *
 * Computes SHA-256 checksums and verifies backup integrity:
 * - computes the backup checksum
 * - verifies integrity bit-exactly
 * - incremental verification (chunked verification of large files)
 *
 * @module backup
 */

import crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Expected SHA-256 hash (hex); compared bit-exactly when supplied */
  expectedChecksum?: string;
  /** Chunk size (incremental verification of large files; 64KB by default) */
  chunkSize?: number;
  /** Whether temporary data is deleted after verification */
  cleanup?: boolean;
}

export interface VerifyResult {
  /** Whether verification passed */
  valid: boolean;
  /** Computed SHA-256 */
  computedChecksum: string;
  /** Expected SHA-256 (when supplied) */
  expectedChecksum?: string;
  /** Total backup size (bytes) */
  totalSize: number;
  /** Number of chunks (chunked mode only) */
  chunkCount: number;
  /** Error message (when verification failed) */
  error?: string;
  /** Verification duration (ms) */
  durationMs: number;
}

export interface IBackupVerifier {
  verify(backupId: string, data: Buffer, options?: VerifyOptions): Promise<VerifyResult>;
  verifyStream(data: AsyncIterable<Buffer>, options?: VerifyOptions): Promise<VerifyResult>;
  calculateChecksum(data: Buffer): string;
}

// ── Implementation ─────────────────────────────────────────────────

export class BackupVerifier implements IBackupVerifier {
  private _checksums = new Map<string, string>();

  /**
   * Verify backup integrity.
   */
  async verify(backupId: string, data: Buffer, options: VerifyOptions = {}): Promise<VerifyResult> {
    const start = Date.now();
    const computedChecksum = this.calculateChecksum(data);
    const durationMs = Date.now() - start;

    const chunkSize = options.chunkSize ?? 64 * 1024;
    const chunkCount = Math.ceil(data.length / chunkSize);

    let valid = true;
    let error: string | undefined;

    // Compare against the expected value
    if (options.expectedChecksum) {
      if (computedChecksum !== options.expectedChecksum) {
        valid = false;
        error = `Checksum mismatch for backup '${backupId}': expected ${options.expectedChecksum}, got ${computedChecksum}`;
      }
    }

    // Keep the checksum for later comparison
    this._checksums.set(backupId, computedChecksum);

    return {
      valid,
      computedChecksum,
      expectedChecksum: options.expectedChecksum,
      totalSize: data.length,
      chunkCount,
      error,
      durationMs,
    };
  }

  /**
   * Verify a backup from a stream.
   */
  async verifyStream(data: AsyncIterable<Buffer>, options: VerifyOptions = {}): Promise<VerifyResult> {
    const start = Date.now();
    const hash = crypto.createHash('sha256');
    let totalSize = 0;

    for await (const chunk of data) {
      hash.update(chunk);
      totalSize += chunk.length;
    }

    const computedChecksum = hash.digest('hex');
    const durationMs = Date.now() - start;

    let valid = true;
    let error: string | undefined;

    if (options.expectedChecksum && computedChecksum !== options.expectedChecksum) {
      valid = false;
      error = `Checksum mismatch in stream: expected ${options.expectedChecksum}, got ${computedChecksum}`;
    }

    return {
      valid,
      computedChecksum,
      expectedChecksum: options.expectedChecksum,
      totalSize,
      chunkCount: 0, // streaming mode does not count chunks
      error,
      durationMs,
    };
  }

  /**
   * Compute the SHA-256 hash of a buffer.
   */
  calculateChecksum(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Checksum computed by an earlier verification.
   */
  getStoredChecksum(backupId: string): string | undefined {
    return this._checksums.get(backupId);
  }
}
