/**
 * BackupVerifier 测试 — 覆盖 checksum 计算、完整性验证、流验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { BackupVerifier } from '../impl/BackupVerifier.js';

describe('BackupVerifier', () => {
  let verifier: BackupVerifier;

  beforeEach(() => {
    verifier = new BackupVerifier();
  });

  // ── SHA-256 计算 ────────────────────────────────────────────────

  it('calculateChecksum 返回正确的 SHA-256', () => {
    const data = Buffer.from('hello world');
    const checksum = verifier.calculateChecksum(data);
    const expected = crypto.createHash('sha256').update('hello world').digest('hex');
    expect(checksum).toBe(expected);
  });

  it('相同数据产生相同 checksum', () => {
    const d1 = Buffer.from('same data');
    const d2 = Buffer.from('same data');
    expect(verifier.calculateChecksum(d1)).toBe(verifier.calculateChecksum(d2));
  });

  it('不同数据产生不同 checksum（抗碰撞）', () => {
    const d1 = Buffer.from('data-1');
    const d2 = Buffer.from('data-2');
    expect(verifier.calculateChecksum(d1)).not.toBe(verifier.calculateChecksum(d2));
  });

  it('空 buffer 产生正确的 SHA-256', () => {
    const checksum = verifier.calculateChecksum(Buffer.alloc(0));
    expect(checksum).toBe(crypto.createHash('sha256').digest('hex'));
  });

  it('大 buffer (1MB) 高效计算', () => {
    const data = Buffer.alloc(1024 * 1024, 'x');
    const start = performance.now();
    const checksum = verifier.calculateChecksum(data);
    const elapsed = performance.now() - start;
    
    expect(checksum).toHaveLength(64);
    expect(elapsed).toBeLessThan(500); // 1MB 应在 500ms 内完成
  });

  // ── verify (完整校验) ───────────────────────────────────────────

  it('verify 通过正确数据', async () => {
    const data = Buffer.from('backup content');
    const checksum = verifier.calculateChecksum(data);

    const result = await verifier.verify('backup-001', data, {
      expectedChecksum: checksum,
    });

    expect(result.valid).toBe(true);
    expect(result.computedChecksum).toBe(checksum);
    expect(result.totalSize).toBe(data.length);
    expect(result.error).toBeUndefined();
  });

  it('verify 检测到 checksum 不匹配', async () => {
    const data = Buffer.from('original content');
    const wrongChecksum = crypto.createHash('sha256').update('tampered').digest('hex');

    const result = await verifier.verify('backup-002', data, {
      expectedChecksum: wrongChecksum,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
  });

  it('verify 记录耗时', async () => {
    const data = Buffer.alloc(1024);
    const result = await verifier.verify('bp-1', data);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── 大文件分块验证 ──────────────────────────────────────────────

  it('超过 chunkSize 时触发分块验证', async () => {
    const data = Buffer.alloc(200 * 1024); // 大于默认 64KB chunkSize
    const result = await verifier.verify('large-bp', data);

    expect(result.valid).toBe(true);
    expect(result.totalSize).toBe(200 * 1024);
    expect(result.chunkCount).toBe(4);
  });

  // ── 存储 checksum ───────────────────────────────────────────────

  it('验证后存储 checksum 供后续比较', async () => {
    const data = Buffer.from('my backup');
    await verifier.verify('bp-stored', data);
    expect(verifier.getStoredChecksum('bp-stored')).toBe(verifier.calculateChecksum(data));
  });

  it('未验证的 backupId 返回 undefined', () => {
    expect(verifier.getStoredChecksum('unknown')).toBeUndefined();
  });

  // ── verifyStream ────────────────────────────────────────────────

  it('verifyStream 从异步迭代器验证', async () => {
    async function* generateChunks(): AsyncIterable<Buffer> {
      yield Buffer.from('chunk1-');
      yield Buffer.from('chunk2-');
      yield Buffer.from('chunk3');
    }

    const fullData = Buffer.from('chunk1-chunk2-chunk3');
    const expectedChecksum = verifier.calculateChecksum(fullData);

    const result = await verifier.verifyStream(generateChunks(), {
      expectedChecksum,
    });

    expect(result.valid).toBe(true);
    expect(result.totalSize).toBe(20);
  });

  it('verifyStream 检测校验和不匹配', async () => {
    async function* generateChunks(): AsyncIterable<Buffer> {
      yield Buffer.from('tampered data');
    }

    const wrongChecksum = crypto.createHash('sha256').update('different').digest('hex');
    const result = await verifier.verifyStream(generateChunks(), {
      expectedChecksum: wrongChecksum,
    });

    expect(result.valid).toBe(false);
  });

  // ── Edge cases ──────────────────────────────────────────────────

  it('verify 单个字节也能正常处理', async () => {
    const data = Buffer.from([0x42]);
    const result = await verifier.verify('single-byte', data);
    expect(result.valid).toBe(true);
    expect(result.totalSize).toBe(1);
  });

  it('verify 不传 expectedChecksum 时直接通过', async () => {
    const data = Buffer.from('anything');
    const result = await verifier.verify('no-check', data);
    expect(result.valid).toBe(true);
    expect(result.expectedChecksum).toBeUndefined();
  });

  // ── Precise durationMs (kills the `-`→`+` elapsed-time mutant) ──

  it('verify reports the exact elapsed milliseconds', async () => {
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)   // start
      .mockReturnValueOnce(1_234);  // end
    const data = Buffer.from('x');
    const result = await verifier.verify('bp-dur', data);
    expect(result.durationMs).toBe(234);
    spy.mockRestore();
  });

  it('verifyStream reports the exact elapsed milliseconds', async () => {
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(5_150);
    async function* gen(): AsyncIterable<Buffer> { yield Buffer.from('a'); }
    const result = await verifier.verifyStream(gen());
    expect(result.durationMs).toBe(150);
    spy.mockRestore();
  });
});
