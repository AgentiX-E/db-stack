/**
 * AC 82 — group commit: one sync acknowledges a turn's worth of appends.
 *
 * The write path acknowledged one line per `fsync`, which is correct and, under
 * concurrency, wasteful: a file sync covers *everything appended before it*, so ten
 * callers that arrive in the same turn were paying ten round trips to the medium for
 * one file's worth of data. Measurement put a serial writer at ~96 acknowledged
 * entries per second on a disk with a 10 ms flush — a number that describes the disk,
 * not the store.
 *
 * The append stays synchronous (it is cheap, and `O_APPEND` puts the line where the
 * caller wrote it). Only the sync moved: it runs once per turn, in the check phase,
 * and every append made before it is acknowledged by it. What has to be true, and is
 * asserted here, is that an acknowledgement never runs ahead of the sync that covers
 * the line it acknowledges — a batch is defined by the moment the flush starts, not
 * by the file's contents, and a line appended while the flush was running belongs to
 * the next one.
 *
 * What each case is for:
 *
 *   GC.1  a burst of concurrent writes pays one file sync and one directory sync
 *   GC.2  a resolved write has been appended and synced — never only appended
 *   GC.3  a line appended during a flush is not covered by it
 *   GC.4  a burst spanning a rotation syncs both segments, once each
 *   GC.5  a sync that fails half way acknowledges only what was durable
 *   GC.6  a failed directory sync leaves the bytes on disk and the write rejected
 *   GC.7  a rejected batch does not poison the store
 *   GC.8  a serial caller is unchanged: one sync per write
 *   GC.9  close() drains an acknowledgement the caller never awaited
 *   GC.10 the real filesystem: 200 concurrent writes, one sync, 200 entries
 *   GC.11 concurrent writes under continuous rotation lose nothing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAuditStore } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';

// ── A filesystem that counts what was asked of it ───────────

type Operation = 'append' | 'syncFile' | 'syncDirectory';

interface Call {
  op: Operation;
  path: string;
  bytes: number;
}

/**
 * Delegates to the real implementation and records the sequence.
 *
 * Delegating rather than faking on purpose: what has to be true is that the bytes
 * reach a real file in an order that survives a power cut, so the recorder adds
 * observation without replacing the thing observed. `failOn` says which call, by
 * operation and occurrence, must refuse — one index rather than a switch, because
 * the interesting failure is the second sync of a batch and not the first.
 */
class CountingFileSystem implements DurableFileSystem {
  readonly calls: Call[] = [];
  failOn: { op: Operation; nth: number } | null = null;

  /** Runs after a file sync succeeds — the window in which a flush is in flight. */
  afterSyncFile: (() => void) | null = null;

  append(path: string, data: string): void {
    this.#maybeFail('append');
    nodeDurableFileSystem.append(path, data);
    this.calls.push({ op: 'append', path, bytes: Buffer.byteLength(data) });
  }

  syncFile(path: string): void {
    this.#maybeFail('syncFile');
    nodeDurableFileSystem.syncFile(path);
    this.calls.push({ op: 'syncFile', path, bytes: 0 });
    this.afterSyncFile?.();
  }

  syncDirectory(path: string): void {
    this.#maybeFail('syncDirectory');
    nodeDurableFileSystem.syncDirectory(path);
    this.calls.push({ op: 'syncDirectory', path, bytes: 0 });
  }

  needsSeparator(path: string): boolean {
    return nodeDurableFileSystem.needsSeparator(path);
  }

  count(op: Operation): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  ops(): Operation[] {
    return this.calls.map((call) => call.op);
  }

  appendPaths(): string[] {
    return this.calls.filter((call) => call.op === 'append').map((call) => call.path);
  }

  bytesAppended(): number {
    return this.calls.reduce((total, call) => total + call.bytes, 0);
  }

  #maybeFail(op: Operation): void {
    if (!this.failOn || this.failOn.op !== op) return;
    if (this.count(op) + 1 !== this.failOn.nth) return;
    this.failOn = null;
    const error = new Error(`${op}: injected failure`) as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  }
}

// ── Fixture ─────────────────────────────────────────────────

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ac82-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeWrite(operation: string) {
  return { operation, actor: 'auditor', resource: '/db/orders', result: 'success' as const };
}

/** Issue `count` writes without awaiting, keeping the promises in order. */
function burst(store: FileAuditStore, count: number, label: string): Promise<string>[] {
  return Array.from({ length: count }, (_, i) => store.write(makeWrite(`${label}-${i}`)));
}

// ── The batching ────────────────────────────────────────────

describe('AC 82 — group commit', () => {
  it('GC.1: a burst of concurrent writes pays one file sync and one directory sync', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    const ids = await Promise.all(burst(store, 100, 'OP'));

    // One hundred lines, one sync of each kind. The check phase is where the flush
    // runs, so everything written in this turn is one batch — and a file sync covers
    // every byte appended before it, which is exactly what makes the batch sound.
    expect(fs.count('append')).toBe(100);
    expect(fs.count('syncFile')).toBe(1);
    expect(fs.count('syncDirectory')).toBe(1);

    // An acknowledgement is still a promise about an entry: all hundred are there.
    expect(new Set(ids).size).toBe(100);
    expect(await store.count()).toBe(100);
  });

  it('GC.2: a resolved write has been appended and synced, never only appended', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    const seen: { ops: Operation[]; bytesOnDisk: number }[] = [];
    const writes = burst(store, 5, 'OP').map((promise) =>
      promise.then(() => {
        seen.push({
          ops: [...fs.ops()],
          bytesOnDisk: readFileSync(fs.appendPaths()[0]!, 'utf-8').length,
        });
      }),
    );
    await Promise.all(writes);

    for (const observation of seen) {
      // The last thing that happened before an acknowledgement was a sync, and the
      // bytes of the line were in the file before that. A write resolved straight
      // after its append would show neither.
      expect(observation.ops.at(-1)).toBe('syncDirectory');
      expect(observation.ops).toContain('append');
      expect(observation.bytesOnDisk).toBeGreaterThan(0);
    }

    // Stronger, and structural: every acknowledged write's own line is inside the
    // bytes that were appended before it was acknowledged.
    expect(fs.bytesAppended()).toBe(readFileSync(fs.appendPaths()[0]!, 'utf-8').length);
  });

  it('GC.3: a line appended during a flush is not covered by it', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    // The append happens *inside* the flush, after the file sync returned and before
    // the batch is acknowledged. It cannot be covered by a sync that already
    // happened, so it must wait for the next one — and it must not be acknowledged
    // early because it happened to arrive while a flush was running.
    let during: Promise<string> | null = null;
    fs.afterSyncFile = () => {
      during ??= store.write(makeWrite('DURING'));
    };

    await store.write(makeWrite('FIRST'));
    expect(during).not.toBeNull();

    let resolved = false;
    void during!.then(() => {
      resolved = true;
    });

    // The second line's promise is settled on a later turn, not as a side effect of
    // the first flush finishing.
    await Promise.resolve();
    expect(resolved).toBe(false);

    await during!;
    expect(fs.count('syncFile')).toBe(2);
    expect(fs.count('syncDirectory')).toBe(1);
    expect(await store.count()).toBe(2);
  });

  it('GC.4: a burst spanning a rotation syncs both segments, once each', async () => {
    const fs = new CountingFileSystem();
    // Small enough that the second write of the burst rotates: the batch then holds
    // two segments, and the flush must sync each of them rather than the active one.
    const store = new FileAuditStore({ dataDir, fileSystem: fs, maxFileSize: 1 });

    await Promise.all(burst(store, 3, 'OP'));

    const segments = new Set(fs.appendPaths());
    expect(segments.size).toBeGreaterThan(1);
    expect(fs.count('syncFile')).toBe(segments.size);

    // One directory sync, because it covers every name created before it — not one
    // per segment, which would make a burst of rotations as expensive as a burst of
    // writes used to be.
    expect(fs.count('syncDirectory')).toBe(1);
    expect(await store.count()).toBe(3);
  });

  it('GC.5: a sync that fails half way acknowledges only what was durable', async () => {
    const fs = new CountingFileSystem();
    // Large enough for one more line, small enough that the second write rotates:
    // the batch then holds the warm segment's last line and a brand-new one. The
    // budget is in bytes and a chained line is ~405 of them (the hash link costs
    // about 170), so 600 is "one line fits, two do not" — a literal tuned to the
    // pre-chain format would rotate on the warm line and change the batch shape.
    const store = new FileAuditStore({ dataDir, fileSystem: fs, maxFileSize: 600 });

    // A warm segment: its name is already on the medium, so a line appended to it
    // can be acknowledged even if a later segment in the same batch cannot.
    await store.write(makeWrite('WARM'));
    expect(fs.count('syncDirectory')).toBe(1);

    // The next two writes go to different segments (the second rotates), so the
    // batch syncs two files — and the second sync is the one that fails.
    fs.failOn = { op: 'syncFile', nth: fs.count('syncFile') + 2 };
    const [kept, lost] = burst(store, 2, 'OP');

    // Asymmetric on purpose. Rejecting a line that is durable invites the caller to
    // write it twice, and an audit report that counts an entry twice is wrong in the
    // same way as one that lost it; acknowledging one that is not durable is the lie
    // this whole path exists to avoid.
    await expect(kept).resolves.toBeTypeOf('string');
    await expect(lost).rejects.toThrow(/syncFile: injected failure/);

    expect(fs.count('append')).toBe(3);
    // The rejected line's bytes are in the new segment and stay there: truncating
    // after a failed sync is a second write with its own failure mode. The trail is
    // therefore at-least-once across a failure — three lines on disk, two
    // acknowledged — and the caller retries with a fresh id rather than assuming the
    // write did not happen.
    expect(await store.count()).toBe(3);
    expect(await store.count({ operation: 'WARM' })).toBe(1);
  });

  it('GC.6: a failed directory sync leaves the bytes on disk and the write rejected', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    fs.failOn = { op: 'syncDirectory', nth: 1 };
    const writes = burst(store, 3, 'OP');

    // Every line was appended and the file was synced — the bytes are on the medium.
    // The *name* is not, so a power cut leaves data no reader can reach: an
    // acknowledgement here would be a promise about a file that may not exist after
    // the crash it is supposed to survive.
    await expect(Promise.allSettled(writes)).resolves.toSatisfy((results: PromiseSettledResult<string>[]) =>
      results.every((result) => result.status === 'rejected'),
    );
    expect(fs.count('syncFile')).toBe(1);
    expect(fs.bytesAppended()).toBeGreaterThan(0);
  });

  it('GC.7: a rejected batch does not poison the store', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    fs.failOn = { op: 'syncFile', nth: 1 };
    await expect(store.write(makeWrite('LOST'))).rejects.toThrow(/syncFile/);

    // The next write pays for the directory sync the failed batch never did: the
    // number that records "this name is on the medium" is only advanced by a sync
    // that succeeded, so the claim is retried rather than assumed.
    await store.write(makeWrite('KEPT'));

    expect(fs.count('syncDirectory')).toBe(1);
    expect(await store.count({ operation: 'KEPT' })).toBe(1);
    // And the rejected line is in the file, because the append happened: a rejection
    // says "not durable", not "not written".
    expect(await store.count({ operation: 'LOST' })).toBe(1);
  });

  it('GC.8: a serial caller is unchanged — one sync per write', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    for (let i = 0; i < 5; i++) {
      await store.write(makeWrite(`OP-${i}`));
    }

    // Batching must not quietly change what a caller who waits for each write pays
    // for: the acknowledgement is still one sync away, and the previous iteration's
    // measurement of a serial writer therefore still holds. This is the case the
    // optimisation is *not* allowed to improve, because improving it would mean
    // acknowledging before the sync.
    expect(fs.count('syncFile')).toBe(5);
    expect(fs.count('syncDirectory')).toBe(1);
  });

  it('GC.9: close() drains an acknowledgement the caller never awaited', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    // The caller fired and forgot — `write()` returns a promise precisely so that
    // this is a mistake the caller makes, not one the store makes. `close()` is the
    // promise that what was appended is on the medium, so it flushes what is queued
    // instead of leaving it to a `setImmediate` nobody is waiting for.
    void store.write(makeWrite('FORGOTTEN'));
    await store.close();

    expect(fs.count('syncFile')).toBe(1);
    expect(await store.count()).toBe(1);
  });

  it('GC.10: 200 concurrent writes cost one sync and all 200 entries are readable', async () => {
    const fs = new CountingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs, maxFileSize: 1024 * 1024 });

    const ids = await Promise.all(burst(store, 200, 'OP'));

    expect(fs.count('syncFile')).toBe(1);
    expect(fs.count('syncDirectory')).toBe(1);
    expect(ids).toHaveLength(200);
    expect(await store.count()).toBe(200);

    // Readable from a second store, so the batching wrote real lines and not a
    // buffer that happens to satisfy this instance's own reader.
    const reader = new FileAuditStore({ dataDir });
    expect(await reader.count()).toBe(200);
    expect(await reader.get(ids[199]!)).toMatchObject({ operation: 'OP-199' });
  });

  it('GC.11: concurrent writes under continuous rotation lose nothing', async () => {
    const fs = new CountingFileSystem();
    // 150 bytes per segment: a burst of twenty rotates several times mid-batch.
    const store = new FileAuditStore({ dataDir, fileSystem: fs, maxFileSize: 150 });

    const ids = await Promise.all(burst(store, 20, 'OP'));
    await store.close();

    expect(await store.count()).toBe(20);
    for (const id of ids) {
      expect(await store.get(id)).not.toBeNull();
    }

    // Every segment in the batch was synced, and the number of syncs is bounded by
    // the number of segments rather than by the number of lines.
    const segments = new Set(fs.appendPaths());
    expect(segments.size).toBeGreaterThan(1);
    expect(fs.count('syncFile')).toBeLessThanOrEqual(segments.size);

    // And the lines are intact where they landed: a rotation inside a batch must not
    // produce a segment whose first line is glued to the previous segment's last.
    for (const name of readdirSync(dataDir).filter((f) => f.endsWith('.ndjson'))) {
      const text = readFileSync(join(dataDir, name), 'utf-8');
      for (const line of text.split('\n').slice(0, -1)) {
        expect(line.length).toBeGreaterThan(0);
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
