/**
 * FileChangeLog — the bytes the CDC path used to begin at.
 *
 * `CDCEngine.appendChange()` was the first link of every CDC claim in this
 * package, and it is a test hook. These cases measure the log that replaces it,
 * with real files, real descriptors and real `fsync`:
 *
 *   AC 93.1  a record one writer appended is readable through a separate reader
 *   AC 93.2  the writer assigns positions, and a reopened writer continues past
 *            the last one instead of reusing it
 *   AC 93.3  readAfter returns strictly later records, in order, up to the limit
 *   AC 93.4  a line with no newline yet is not delivered; it appears once the
 *            writer terminates it
 *   AC 93.5  a torn tail is truncated on reopen, so the next record is parseable
 *   AC 93.6  a file that shrank is refused by name rather than re-read
 *   AC 93.7  a non-JSON line is refused, with the byte offset it starts at
 *   AC 93.8  a record whose LSN does not advance is refused
 *   AC 93.9  head() is null for an empty log; a zero limit is refused
 *   AC 93.10 compareLsn orders positions past the eight-digit boundary
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeLogReader, FileChangeLogWriter, ChangeLogCorruptError } from './FileChangeLog';
import { compareLsn, formatLsn, parseLsn } from '../interfaces/replication/IChangeLogReader';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A test that could not clean up has already failed on its own terms.
    }
  }
});

const record = (table: string, id: number, op: 'insert' | 'update' | 'delete' = 'insert') => ({
  table,
  operation: op,
  newValues: { id },
  txId: `tx-${table}-${id}`,
});

describe('FileChangeLog', () => {
  it('AC 93.1: a record one writer appended is readable through a separate reader', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir });
    const reader = await FileChangeLogReader.open({ dir });

    const lsn = await writer.append(record('orders', 1));
    const [read] = await reader.readAfter(null, 10);

    expect(lsn).toBe('0/00000001');
    expect(read).toEqual({
      lsn: '0/00000001',
      table: 'orders',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1 },
      txId: 'tx-orders-1',
      committedAt: expect.any(Number),
    });

    await writer.close();
    await reader.close();
  });

  it('AC 93.2: a reopened writer continues past the last position instead of reusing it', async () => {
    const dir = makeDir();
    const first = await FileChangeLogWriter.open({ dir });
    await first.append(record('orders', 1));
    await first.append(record('orders', 2));
    expect(first.length).toBe(2);
    expect(first.lastLsn).toBe('0/00000002');
    await first.close();

    const second = await FileChangeLogWriter.open({ dir });
    expect(second.length).toBe(2);
    const third = await second.append(record('orders', 3));
    expect(third).toBe('0/00000003');
    await second.close();

    const reader = await FileChangeLogReader.open({ dir });
    const all = await reader.readAfter(null, 10);
    expect(all.map((r) => r.lsn)).toEqual(['0/00000001', '0/00000002', '0/00000003']);
    await reader.close();
  });

  it('AC 93.3: readAfter returns strictly later records, in order, up to the limit', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir });
    for (let i = 1; i <= 5; i++) await writer.append(record('orders', i));
    const reader = await FileChangeLogReader.open({ dir });

    expect((await reader.readAfter(null, 2)).map((r) => r.lsn)).toEqual(['0/00000001', '0/00000002']);
    expect((await reader.readAfter('0/00000002', 2)).map((r) => r.lsn)).toEqual(['0/00000003', '0/00000004']);
    // Past the end: an empty batch, not an error and not a replay.
    expect(await reader.readAfter('0/00000005', 2)).toEqual([]);
    // A position between two records is the same as the record before it.
    expect(await reader.head()).toBe('0/00000005');

    await writer.close();
    await reader.close();
  });

  it('AC 93.4: a line with no newline yet is not delivered until it is terminated', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    writeFileSync(path, '');
    const reader = await FileChangeLogReader.open({ dir });

    // Half a record: the shape a writer leaves behind between `write` and the
    // `fsync` that acknowledges it.
    appendFileSync(
      path,
      '{"lsn":"0/00000001","table":"orders","operation":"insert",' +
        '"oldValues":null,"newValues":{"id":1},"txId":"tx-1","committedAt":1}',
    );
    expect(await reader.readAfter(null, 10)).toEqual([]);

    appendFileSync(path, '\n');
    const [record] = await reader.readAfter(null, 10);
    expect(record?.lsn).toBe('0/00000001');

    await reader.close();
  });

  it('AC 93.5: a torn tail is truncated on reopen so the next record is parseable', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    const writer = await FileChangeLogWriter.open({ dir });
    await writer.append(record('orders', 1));
    await writer.close();

    // Simulate a process that died inside `write`: bytes of a second record,
    // no newline, and therefore never acknowledged to anyone.
    appendFileSync(path, '{"lsn":"0/00000002","table":"ord');

    const reopened = await FileChangeLogWriter.open({ dir });
    expect(reopened.length).toBe(1);
    const lsn = await reopened.append(record('orders', 3));
    expect(lsn).toBe('0/00000002');
    await reopened.close();

    const reader = await FileChangeLogReader.open({ dir });
    const all = await reader.readAfter(null, 10);
    expect(all.map((r) => r.newValues)).toEqual([{ id: 1 }, { id: 3 }]);
    await reader.close();
  });

  it('AC 93.6: a file that shrank is refused by name rather than re-read', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    const writer = await FileChangeLogWriter.open({ dir });
    for (let i = 1; i <= 3; i++) await writer.append(record('orders', i));
    await writer.close();

    const reader = await FileChangeLogReader.open({ dir });
    await reader.readAfter(null, 10);

    // Rotation without a new file: the reader would otherwise treat the
    // shorter content as "everything after position 3" and skip what the new
    // file holds.
    truncateSync(path, 10);
    await expect(reader.readAfter('0/00000003', 10)).rejects.toThrow(ChangeLogCorruptError);
    await expect(reader.readAfter('0/00000003', 10)).rejects.toThrow(/shrank/);

    await reader.close();
  });

  it('AC 93.7: a non-JSON line is refused, with the byte offset it starts at', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    const writer = await FileChangeLogWriter.open({ dir });
    await writer.append(record('orders', 1));
    await writer.close();

    appendFileSync(path, 'this is not json\n');

    const reader = await FileChangeLogReader.open({ dir });
    const failure = await reader.readAfter(null, 10).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChangeLogCorruptError);
    expect((failure as ChangeLogCorruptError).offset).toBeGreaterThan(0);

    await reader.close();
  });

  it('AC 93.8: a record whose LSN does not advance is refused', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    const line = (lsn: string, id: number) =>
      `${JSON.stringify({
        lsn,
        table: 'orders',
        operation: 'insert',
        oldValues: null,
        newValues: { id },
        txId: `tx-${id}`,
        committedAt: 1,
      })}\n`;
    writeFileSync(path, line('0/00000002', 1) + line('0/00000001', 2));

    const reader = await FileChangeLogReader.open({ dir });
    await expect(reader.readAfter(null, 10)).rejects.toThrow(/after 0\/00000002/);
    await reader.close();
  });

  it('AC 93.9: head() is null for an empty log, and a zero limit is refused', async () => {
    const dir = makeDir();
    const reader = await FileChangeLogReader.open({ dir });
    expect(await reader.head()).toBeNull();
    await expect(reader.readAfter(null, 0)).rejects.toThrow(/positive integer limit/);
    await expect(reader.readAfter(null, 1.5)).rejects.toThrow(/positive integer limit/);
    await reader.close();
  });

  it('AC 93.10: compareLsn orders positions past the eight-digit boundary', () => {
    // The order the string comparison in `advanceCheckpoint` used to get wrong:
    // "0/100000000" sorts before "0/A0000000" lexically and after it numerically.
    expect('0/100000000' < '0/A0000000').toBe(true);
    expect(compareLsn('0/100000000', '0/A0000000')).toBe(1);
    expect(compareLsn('0/0000000A', '0/0000000A')).toBe(0);
    expect(compareLsn('0/00000009', '0/0000000A')).toBe(-1);
    expect(compareLsn('1/00000000', '0/FFFFFFFF')).toBe(1);
    expect(parseLsn('0/0000001F')).toEqual({ high: 0n, low: 31n });
    expect(formatLsn(31)).toBe('0/0000001F');
    expect(() => compareLsn('nonsense', '0/00000001')).toThrow(/high\/low form/);
    expect(() => formatLsn(-1)).toThrow(/non-negative integer/);
  });
});
