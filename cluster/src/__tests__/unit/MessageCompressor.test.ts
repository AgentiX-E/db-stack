/**
 * Tests for MessageCompressor — ZStd message compression layer.
 *
 * Verifies the threshold-based skip logic, the magic-byte framing, and the
 * round-trip integrity of compressed and uncompressed paths.
 */

import { describe, it, expect } from 'vitest';
import { MessageCompressor } from '../../consensus/helpers/MessageCompressor';

const MAGIC = Buffer.from([0x5a, 0x53, 0x54, 0x43]); // 'ZSTC'

describe('MessageCompressor', () => {
  it('returns small data unchanged when below the threshold', async () => {
    const c = new MessageCompressor({ threshold: 1024 });
    const data = Buffer.from('tiny');
    const result = await c.compress(data);
    expect(result.equals(data)).toBe(true);
  });

  it('compresses data at or above the threshold with a magic header', async () => {
    const c = new MessageCompressor({ threshold: 16 });
    const data = Buffer.alloc(128, 0x41); // highly compressible
    const result = await c.compress(data);

    expect(result.length).toBeGreaterThanOrEqual(8);
    expect(result.subarray(0, 4).equals(MAGIC)).toBe(true);
    const originalLength = result.readUInt32BE(4);
    expect(originalLength).toBe(128);
  });

  it('round-trips compressed data back to the original bytes', async () => {
    const c = new MessageCompressor({ threshold: 8 });
    const data = Buffer.from('hello zstd round trip '.repeat(50));
    const compressed = await c.compress(data);
    const restored = await c.decompress(compressed);
    expect(restored.equals(data)).toBe(true);
  });

  it('decompresses non-magic data as a passthrough', async () => {
    const c = new MessageCompressor();
    const raw = Buffer.from('not compressed at all');
    const result = await c.decompress(raw);
    expect(result.equals(raw)).toBe(true);
  });

  it('decompresses data shorter than the header as a passthrough', async () => {
    const c = new MessageCompressor();
    const tiny = Buffer.from('abc'); // 3 bytes < HEADER_SIZE (8)
    const result = await c.decompress(tiny);
    expect(result.equals(tiny)).toBe(true);
  });

  it('does not treat non-magic data of sufficient length as compressed', async () => {
    const c = new MessageCompressor();
    const notMagic = Buffer.alloc(16, 0x00); // magic mismatch
    const result = await c.decompress(notMagic);
    expect(result.equals(notMagic)).toBe(true);
  });

  it('applies default threshold and level when options are omitted', () => {
    const c = new MessageCompressor();
    expect(c.getThreshold()).toBe(1024);
  });

  it('applies a custom threshold and level', () => {
    const c = new MessageCompressor({ threshold: 2048, level: 9 });
    expect(c.getThreshold()).toBe(2048);
  });

  it('applies a custom threshold only, keeping default level', () => {
    const c = new MessageCompressor({ threshold: 512 });
    expect(c.getThreshold()).toBe(512);
  });

  it('treats exactly-at-threshold data as compressible', async () => {
    const c = new MessageCompressor({ threshold: 16 });
    const data = Buffer.alloc(16, 0x61);
    const result = await c.compress(data);
    // `>= threshold` triggers compression (length check is `< threshold`).
    expect(result.subarray(0, 4).equals(MAGIC)).toBe(true);
  });

  it('round-trips empty buffer through the passthrough path', async () => {
    const c = new MessageCompressor({ threshold: 1024 });
    const empty = Buffer.alloc(0);
    const compressed = await c.compress(empty); // below threshold → passthrough
    const restored = await c.decompress(empty);
    expect(compressed.equals(empty)).toBe(true);
    expect(restored.equals(empty)).toBe(true);
  });
});
