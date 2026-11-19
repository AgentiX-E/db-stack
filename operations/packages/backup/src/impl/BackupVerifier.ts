/**
 * BackupVerifier — backup integrity verifier.
 *
 * Computes SHA-256 checksums and verifies backup integrity:
 * - computes the backup checksum
 * - verifies integrity bit-exactly
 * - streams a backup through the digest without holding it in memory
 *
 * Two fields of this type used to describe work that did not happen, and both
 * are now true or gone:
 *
 * `VerifyOptions.cleanup` ("whether temporary data is deleted after
 * verification") was read by nothing, because nothing here creates temporary
 * data. It is deleted rather than documented: a configuration flag that no
 * branch reads is a promise the caller can set and cannot observe.
 *
 * `VerifyOptions.chunkSize` sized a `chunkCount` that was computed as
 * `ceil(length / chunkSize)` while the digest was updated with the whole buffer
 * in one call — a number describing pieces that were never taken. `verify` now
 * walks the buffer in pieces of that size, so the count is a fact, and
 * `verifyStream` counts the pieces it is actually handed instead of reporting
 * zero.
 *
 * @module backup
 */

import crypto from 'crypto';

/** The piece size the digest is updated with when a caller names none. */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

// ── Types ──────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Expected SHA-256 hash (hex); compared bit-exactly when supplied */
  expectedChecksum?: string;
  /**
   * Size of the pieces the digest is updated with, in bytes (default: 64 KB).
   *
   * It changes how many `hash.update` calls a verification makes, not the digest:
   * SHA-256 over a byte sequence does not depend on where the sequence was cut.
   * The count it produces is reported as `chunkCount`, which is what makes the
   * option observable.
   */
  chunkSize?: number;
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
  /** Number of pieces the digest was updated with (`0` for empty input) */
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

    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error(`chunkSize must be a positive integer, got ${String(options.chunkSize)}`);
    }

    // Pieces, not one call. `chunkCount` used to be `ceil(length / chunkSize)`
    // beside a single `update(buffer)` — a count of pieces that were never taken.
    const hash = crypto.createHash('sha256');
    let chunkCount = 0;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      hash.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
      chunkCount++;
    }
    const computedChecksum = hash.digest('hex');
    const durationMs = Date.now() - start;

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
   *
   * `chunkCount` counts the pieces the iterable produced: this is the path that
   * never holds the backup in memory, and a caller tracking throughput wants to
   * know how many round trips it paid. It used to report `0` beside a comment
   * saying streaming "does not count chunks" — a field whose documented meaning
   * and whose value disagreed.
   */
  async verifyStream(data: AsyncIterable<Buffer>, options: VerifyOptions = {}): Promise<VerifyResult> {
    const start = Date.now();
    const hash = crypto.createHash('sha256');
    let totalSize = 0;
    let chunkCount = 0;

    for await (const chunk of data) {
      hash.update(chunk);
      totalSize += chunk.length;
      chunkCount++;
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
      chunkCount,
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
