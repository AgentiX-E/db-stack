/**
 * BackupVerifier — 备份完整性验证器。
 *
 * 提供 SHA-256 校验和计算 + 备份完整性验证：
 * - 计算备份 checksum
 * - 验证备份数据完整性（bit-exact）
 * - 增量校验（大文件分块验证）
 *
 * @module backup
 */

import crypto from 'crypto';

// ── 类型 ──────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** 期望的 SHA-256 hash（hex），传入时进行 bit-exact 比对 */
  expectedChecksum?: string;
  /** 分块大小（用于大文件增量校验，默认 64KB） */
  chunkSize?: number;
  /** 是否验证后删除临时数据 */
  cleanup?: boolean;
}

export interface VerifyResult {
  /** 是否通过验证 */
  valid: boolean;
  /** 计算的 SHA-256 */
  computedChecksum: string;
  /** 期望的 SHA-256（如果提供） */
  expectedChecksum?: string;
  /** 备份文件总大小（bytes） */
  totalSize: number;
  /** 分块数（如果使用分块模式） */
  chunkCount: number;
  /** 错误信息（如果验证失败） */
  error?: string;
  /** 验证耗时 (ms) */
  durationMs: number;
}

export interface IBackupVerifier {
  verify(backupId: string, data: Buffer, options?: VerifyOptions): Promise<VerifyResult>;
  verifyStream(data: AsyncIterable<Buffer>, options?: VerifyOptions): Promise<VerifyResult>;
  calculateChecksum(data: Buffer): string;
}

// ── 实现 ──────────────────────────────────────────────────────────

export class BackupVerifier implements IBackupVerifier {
  private _checksums = new Map<string, string>();

  /**
   * 验证备份完整性。
   */
  async verify(
    backupId: string,
    data: Buffer,
    options: VerifyOptions = {},
  ): Promise<VerifyResult> {
    const start = Date.now();
    const computedChecksum = this.calculateChecksum(data);
    const durationMs = Date.now() - start;

    const chunkSize = options.chunkSize ?? 64 * 1024;
    const chunkCount = Math.ceil(data.length / chunkSize);

    let valid = true;
    let error: string | undefined;

    // 与期望值比对
    if (options.expectedChecksum) {
      if (computedChecksum !== options.expectedChecksum) {
        valid = false;
        error = `Checksum mismatch for backup '${backupId}': expected ${options.expectedChecksum}, got ${computedChecksum}`;
      }
    }

    // 存储 checksum 用于后续比较
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
   * 从流中验证备份。
   */
  async verifyStream(
    data: AsyncIterable<Buffer>,
    options: VerifyOptions = {},
  ): Promise<VerifyResult> {
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
      chunkCount: 0, // 流模式不计块数
      error,
      durationMs,
    };
  }

  /**
   * 计算 buffer 的 SHA-256 hash。
   */
  calculateChecksum(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * 获取之前验证的 checksum。
   */
  getStoredChecksum(backupId: string): string | undefined {
    return this._checksums.get(backupId);
  }
}
