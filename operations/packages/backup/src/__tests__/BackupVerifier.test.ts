/**
 * BackupVerifier tests — covers checksum computation, integrity verification and stream verification.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { BackupVerifier } from '../impl/BackupVerifier.js';

describe('BackupVerifier', () => {
  let verifier: BackupVerifier;

  beforeEach(() => {
    verifier = new BackupVerifier();
  });

  // ── SHA-256 computation ─────────────────────────────────────────

  it('calculateChecksum returns the correct SHA-256', () => {
    const data = Buffer.from('hello world');
    const checksum = verifier.calculateChecksum(data);
    const expected = crypto.createHash('sha256').update('hello world').digest('hex');
    expect(checksum).toBe(expected);
  });

  it('identical data produces an identical checksum', () => {
    const d1 = Buffer.from('same data');
    const d2 = Buffer.from('same data');
    expect(verifier.calculateChecksum(d1)).toBe(verifier.calculateChecksum(d2));
  });

  it('different data produces a different checksum (collision resistance)', () => {
    const d1 = Buffer.from('data-1');
    const d2 = Buffer.from('data-2');
    expect(verifier.calculateChecksum(d1)).not.toBe(verifier.calculateChecksum(d2));
  });

  it('an empty buffer produces the correct SHA-256', () => {
    const checksum = verifier.calculateChecksum(Buffer.alloc(0));
    expect(checksum).toBe(crypto.createHash('sha256').digest('hex'));
  });

  it('a large buffer (1MB) is checksummed efficiently', () => {
    const data = Buffer.alloc(1024 * 1024, 'x');
    const start = performance.now();
    const checksum = verifier.calculateChecksum(data);
    const elapsed = performance.now() - start;

    expect(checksum).toHaveLength(64);
    expect(elapsed).toBeLessThan(500); // 1MB should finish within 500ms
  });

  // ── verify (full check) ─────────────────────────────────────────

  it('verify accepts correct data', async () => {
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

  it('verify detects a checksum mismatch', async () => {
    const data = Buffer.from('original content');
    const wrongChecksum = crypto.createHash('sha256').update('tampered').digest('hex');

    const result = await verifier.verify('backup-002', data, {
      expectedChecksum: wrongChecksum,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
  });

  it('verify records the elapsed time', async () => {
    const data = Buffer.alloc(1024);
    const result = await verifier.verify('bp-1', data);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Large-file chunked verification ─────────────────────────────

  it('data above chunkSize is verified in chunks', async () => {
    const data = Buffer.alloc(200 * 1024); // larger than the default 64KB chunkSize
    const result = await verifier.verify('large-bp', data);

    expect(result.valid).toBe(true);
    expect(result.totalSize).toBe(200 * 1024);
    expect(result.chunkCount).toBe(4);
  });

  it('the piece size changes the count, never the digest', async () => {
    // The count used to be `ceil(length / chunkSize)` beside one `update(buffer)`
    // call — a number describing pieces that were never taken. Now the buffer is
    // walked in pieces, and the digest has to be identical to the one-shot hash
    // or the pieces are being cut wrong.
    const data = Buffer.from('the same bytes however they are cut');
    const oneShot = verifier.calculateChecksum(data);

    for (const chunkSize of [1, 3, 7, 1024]) {
      const result = await verifier.verify('pieces', data, { chunkSize });
      expect(result.computedChecksum, `chunkSize=${chunkSize}`).toBe(oneShot);
      expect(result.chunkCount).toBe(Math.ceil(data.length / chunkSize));
    }
  });

  it('a chunkSize that would loop forever is refused', async () => {
    for (const chunkSize of [0, -1, 1.5]) {
      await expect(verifier.verify('bad', Buffer.from('x'), { chunkSize })).rejects.toThrow(/positive integer/);
    }
  });

  // ── Stored checksum ─────────────────────────────────────────────

  it('the checksum is stored after verification for later comparison', async () => {
    const data = Buffer.from('my backup');
    await verifier.verify('bp-stored', data);
    expect(verifier.getStoredChecksum('bp-stored')).toBe(verifier.calculateChecksum(data));
  });

  it('an unverified backupId returns undefined', () => {
    expect(verifier.getStoredChecksum('unknown')).toBeUndefined();
  });

  // ── verifyStream ────────────────────────────────────────────────

  it('verifyStream verifies data from an async iterator', async () => {
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
    // Three chunks in, three counted. The field reported `0` for two years beside
    // a comment explaining that streaming "does not count chunks" — while this is
    // the only mode that has chunks to count.
    expect(result.chunkCount).toBe(3);
  });

  it('verifyStream detects a checksum mismatch', async () => {
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

  it('verify handles a single byte', async () => {
    const data = Buffer.from([0x42]);
    const result = await verifier.verify('single-byte', data);
    expect(result.valid).toBe(true);
    expect(result.totalSize).toBe(1);
  });

  it('verify passes when expectedChecksum is omitted', async () => {
    const data = Buffer.from('anything');
    const result = await verifier.verify('no-check', data);
    expect(result.valid).toBe(true);
    expect(result.expectedChecksum).toBeUndefined();
  });

  // ── Precise durationMs (kills the `-`→`+` elapsed-time mutant) ──

  it('verify reports the exact elapsed milliseconds', async () => {
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000) // start
      .mockReturnValueOnce(1_234); // end
    const data = Buffer.from('x');
    const result = await verifier.verify('bp-dur', data);
    expect(result.durationMs).toBe(234);
    spy.mockRestore();
  });

  it('verifyStream reports the exact elapsed milliseconds', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValueOnce(5_000).mockReturnValueOnce(5_150);
    async function* gen(): AsyncIterable<Buffer> {
      yield Buffer.from('a');
    }
    const result = await verifier.verifyStream(gen());
    expect(result.durationMs).toBe(150);
    spy.mockRestore();
  });
});
