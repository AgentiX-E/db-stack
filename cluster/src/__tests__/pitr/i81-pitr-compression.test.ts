/**
 * PITR — compression is a stream, not a flag.
 *
 * `compressSnapshots: true` set `compressed: true` on the checkpoint and passed
 * the bytes through unchanged: `compressSnapshot()` returned `Buffer.from(data)`
 * and `decompressSnapshot()` returned `data.toString()`. The pair was consistent,
 * so every round-trip test passed, and the only fact the setting produced was the
 * flag itself — a checkpoint that claimed to be compressed and occupied exactly
 * the space of the snapshot, which is the one thing an operator turns the setting
 * on to change.
 *
 *   PC.1  a compressed checkpoint is a gzip stream, and restore returns the snapshot
 *   PC.2  the ratio is measured, not asserted: compressed bytes over snapshot bytes
 *   PC.3  compression off stores the plain bytes and reports a ratio of 1
 *   PC.4  a checkpoint that claims compression without being gzip is refused by name
 *   PC.5  the ratio aggregates over the checkpoints a shard holds
 */

import { describe, expect, it } from 'vitest';
import { PITRManager } from '../../pitr/PITRManager';

/** A snapshot with enough repetition for gzip to have something to do. */
function compressible(lines: number): Buffer {
  const rows: string[] = [];
  for (let index = 0; index < lines; index++) {
    rows.push(`customer:${index}=active;region=eu-west;tier=standard`);
  }
  return Buffer.from(rows.join('\n'));
}

describe('PITR — compression', () => {
  it('PC.1: a compressed checkpoint is gzip, and restores the snapshot', async () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    const snapshot = compressible(500);

    const checkpoint = pitr.createCheckpoint('s1', 10, 1, snapshot);

    // The gzip magic: 0x1f 0x8b. A pass-through buffer starts with the first
    // byte of the snapshot, which is never that.
    expect(checkpoint.compressed).toBe(true);
    expect(checkpoint.snapshotData.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    const restored = await pitr.restore('s1', checkpoint.timestamp);
    expect(restored.restoredData).toBe(snapshot.toString());
    expect(restored.usedCheckpointId).toBe(checkpoint.checkpointId);
  });

  it('PC.2: the ratio is measured, and a compressible snapshot is smaller', () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    const snapshot = compressible(500);
    pitr.createCheckpoint('s1', 10, 1, snapshot);

    const stats = pitr.getCompressionStats('s1');
    expect(stats.checkpoints).toBe(1);
    expect(stats.uncompressedBytes).toBe(snapshot.length);
    expect(stats.compressedBytes).toBeLessThan(stats.uncompressedBytes);
    expect(stats.ratio).toBeCloseTo(stats.compressedBytes / stats.uncompressedBytes, 5);
    expect(stats.ratio).toBeLessThan(0.5);
  });

  it('PC.3: compression off stores the bytes and reports a ratio of 1', async () => {
    const pitr = new PITRManager();
    pitr.enable('s1');
    const snapshot = Buffer.from('k=v');

    const checkpoint = pitr.createCheckpoint('s1', 1, 1, snapshot);
    expect(checkpoint.compressed).toBe(false);
    expect(checkpoint.snapshotData).toEqual(snapshot);

    const stats = pitr.getCompressionStats('s1');
    expect(stats.ratio).toBe(1);
    expect(stats.compressedBytes).toBe(stats.uncompressedBytes);

    const restored = await pitr.restore('s1', checkpoint.timestamp);
    expect(restored.restoredData).toBe('k=v');
  });

  it('PC.4: a checkpoint that claims compression without being gzip is refused by name', async () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    const checkpoint = pitr.createCheckpoint('s1', 1, 1, Buffer.from('a=1'));

    // Corrupt the stream the way a truncated write would.
    checkpoint.snapshotData = checkpoint.snapshotData.subarray(0, 6);

    await expect(pitr.restore('s1', checkpoint.timestamp)).rejects.toThrow(
      /checkpoint .* is not a readable gzip stream/,
    );
  });

  it('PC.5: the ratio aggregates over the checkpoints a shard holds', () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    const a = compressible(200);
    const b = compressible(400);
    pitr.createCheckpoint('s1', 1, 1, a);
    pitr.createCheckpoint('s1', 2, 1, b);

    const stats = pitr.getCompressionStats('s1');
    expect(stats.checkpoints).toBe(2);
    expect(stats.uncompressedBytes).toBe(a.length + b.length);
    expect(stats.ratio).toBeLessThan(0.5);
  });

  it('PC.2: an empty snapshot has no ratio to compute, and says so', () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    pitr.createCheckpoint('s1', 1, 1, Buffer.alloc(0));

    // Zero bytes compressed to a non-zero gzip header: a ratio would be infinite,
    // so the honest answer is 1 with the counts still reported.
    const stats = pitr.getCompressionStats('s1');
    expect(stats.checkpoints).toBe(1);
    expect(stats.uncompressedBytes).toBe(0);
    expect(stats.ratio).toBe(1);
  });

  it('PC.1: a restore with no WAL recorded replays nothing and returns the snapshot', async () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    pitr.enable('s1');
    const snapshot = compressible(50);
    const checkpoint = pitr.createCheckpoint('s1', 10, 1, snapshot);

    // A process that restored its checkpoints from disk but has not replayed any
    // WAL yet: the map exists and holds nothing for the shard.
    (pitr as unknown as { walEntries: Map<string, unknown> }).walEntries.delete('s1');

    const restored = await pitr.restore('s1', checkpoint.timestamp);
    expect(restored.restoredData).toBe(snapshot.toString());
    expect(restored.walEntriesReplayed).toBe(0);
  });

  it('PC.5: a shard with no checkpoints has no ratio to report', () => {
    const pitr = new PITRManager({ compressSnapshots: true });
    expect(pitr.getCompressionStats('absent')).toEqual({
      checkpoints: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
      ratio: 1,
    });
  });
});
