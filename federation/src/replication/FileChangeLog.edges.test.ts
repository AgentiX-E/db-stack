/**
 * FileChangeLog — the edges, measured rather than assumed.
 *
 * The happy path is in `FileChangeLog.test.ts`. These are the paths a caller
 * reaches only when something is wrong, plus the ones a log of realistic size
 * reaches every day (a record longer than one read chunk) — each one is here
 * because leaving it to the coverage report is how a guard ends up never having
 * been executed:
 *
 *   AC 93.11  append refuses a closed writer, an unknown operation, an empty
 *             table and an empty transaction id
 *   AC 93.12  nextLsn refuses the last representable position
 *   AC 93.13  openFileChangeLog hands back a writer and a reader on one file
 *   AC 93.14  the reader refuses a record with no lsn, and one with an unknown
 *             operation, naming the byte offset
 *   AC 93.15  a record larger than one read chunk is read back whole
 *   AC 93.16  the reader's counters count what they say, and close is idempotent
 *   AC 93.17  a file of nothing but a torn record restarts at position one
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChangeLogCorruptError,
  FileChangeLogReader,
  FileChangeLogWriter,
  nextLsn,
  openFileChangeLog,
} from './FileChangeLog';
import { compareLsn, formatLsn, parseLsn, recordToChangeEvent } from '../interfaces/replication/IChangeLogReader';
import { HLC } from '../hlc/HLC';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-edge-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const record = (table: string, id: number) => ({
  table,
  operation: 'insert' as const,
  newValues: { id },
  txId: `tx-${id}`,
});

describe('FileChangeLog — edges', () => {
  it('AC 93.11: append refuses a closed writer, an unknown operation, an empty table and an empty txId', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir });
    await expect(writer.append({ ...record('orders', 1), operation: 'upsert' as never })).rejects.toThrow(
      /is not insert\|update\|delete/,
    );
    await expect(writer.append({ ...record('orders', 1), table: '' })).rejects.toThrow(
      /table must be a non-empty string/,
    );
    await expect(writer.append({ ...record('orders', 1), txId: '' })).rejects.toThrow(
      /txId must be a non-empty string/,
    );

    await writer.close();
    await expect(writer.append(record('orders', 1))).rejects.toThrow(/append after close/);
    // Closing twice is not an error: a shutdown path that runs in a `finally`
    // must not throw over the exception it was cleaning up after.
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('AC 93.12: nextLsn refuses the last representable position', () => {
    expect(nextLsn(0)).toBe('0/00000001');
    expect(nextLsn(0xfffffffe)).toBe('0/FFFFFFFF');
    expect(() => nextLsn(0xffffffff, '/var/log/changelog.jsonl')).toThrow(/\/var\/log\/changelog\.jsonl: the low word/);
  });

  it('AC 93.13: openFileChangeLog hands back a writer and a reader on one file', async () => {
    const dir = makeDir();
    const { writer, reader } = await openFileChangeLog({ dir });
    await writer.append(record('orders', 1));
    const [read] = await reader.readAfter(null, 5);
    expect(read?.lsn).toBe('0/00000001');
    await writer.close();
    await reader.close();
  });

  it('AC 93.14: the reader refuses a record with no lsn, and one with an unknown operation', async () => {
    const dirNoLsn = makeDir();
    writeFileSync(
      join(dirNoLsn, 'changelog.jsonl'),
      `${JSON.stringify({ table: 'orders', operation: 'insert', txId: 't' })}\n`,
    );
    const noLsn = await FileChangeLogReader.open({ dir: dirNoLsn });
    await expect(noLsn.readAfter(null, 1)).rejects.toThrow(/has no lsn/);
    await noLsn.close();

    const dirBadOp = makeDir();
    writeFileSync(
      join(dirBadOp, 'changelog.jsonl'),
      `${JSON.stringify({ lsn: '0/00000001', table: 'orders', operation: 'truncate', txId: 't' })}\n`,
    );
    const badOp = await FileChangeLogReader.open({ dir: dirBadOp });
    const failure = await badOp.readAfter(null, 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChangeLogCorruptError);
    expect((failure as ChangeLogCorruptError).message).toMatch(/operation "truncate"/);
    await badOp.close();
  });

  it('AC 93.15: a record larger than one read chunk is read back whole', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir });
    // 4 KiB of payload: `readLine` reads 1 KiB at a time, so this record is
    // reassembled from four chunks — the loop that a small record never enters.
    const payload = 'x'.repeat(4096);
    await writer.append({ ...record('orders', 1), newValues: { id: 1, payload } });
    await writer.close();

    const reader = await FileChangeLogReader.open({ dir });
    const [read] = await reader.readAfter(null, 1);
    expect(read?.newValues?.payload).toBe(payload);
    await reader.close();
  });

  it('AC 93.16: the reader counters count what they say, and close is idempotent', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir });
    for (let i = 1; i <= 3; i++) await writer.append(record('orders', i));
    await writer.close();

    const reader = await FileChangeLogReader.open({ dir });
    expect(reader.indexed).toBe(0);
    expect(reader.refreshCount).toBe(0);
    await reader.readAfter(null, 10);
    expect(reader.indexed).toBe(3);
    expect(reader.refreshCount).toBe(1);
    // A second read with nothing new still refreshes — the count is a count of
    // looks, not of changes.
    await reader.readAfter(null, 10);
    expect(reader.refreshCount).toBe(2);

    await reader.close();
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.readAfter(null, 10)).rejects.toThrow(/read after close/);
  });

  it('AC 93.17: a file of nothing but a torn record restarts at position one', async () => {
    const dir = makeDir();
    const path = join(dir, 'changelog.jsonl');
    writeFileSync(path, '{"lsn":"0/00000001","table":"ord');
    truncateSync(path, 33);

    const writer = await FileChangeLogWriter.open({ dir });
    expect(writer.length).toBe(0);
    expect(writer.lastLsn).toBeNull();
    expect(await writer.append(record('orders', 1))).toBe('0/00000001');
    await writer.close();
  });

  it('AC 93.21: a writer refuses to resume after a record that has no position', async () => {
    const dir = makeDir();
    // A complete line that is not a record: the writer cannot know where the
    // log ends, and guessing would reuse a position.
    writeFileSync(join(dir, 'changelog.jsonl'), '{"table":"orders"}\n');

    const { readdirSync } = await import('node:fs');
    const before = readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 20; i++) {
      await expect(FileChangeLogWriter.open({ dir })).rejects.toThrow(/has no lsn/);
    }
    // Twenty failed opens, twenty descriptors released: the handle is closed on
    // the way out rather than left to the garbage collector.
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before + 1);
  });

  it('AC 93.20: blank lines in a log are skipped, not counted as records', async () => {
    const dir = makeDir();
    // A log written by a tool that left a trailing newline per batch: the blank
    // lines are not records, and the writer's next position is not affected by
    // them either.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, 'changelog.jsonl'), '\n\n');
    const writer = await FileChangeLogWriter.open({ dir });
    expect(await writer.append(record('orders', 1))).toBe('0/00000001');
    await writer.close();

    const reader = await FileChangeLogReader.open({ dir });
    expect(await reader.readAfter(null, 10)).toHaveLength(1);
    await reader.close();
  });

  it('AC 93.18: a custom file name and fsync: false are honoured', async () => {
    const dir = makeDir();
    const writer = await FileChangeLogWriter.open({ dir, fileName: 'wal.jsonl', fsync: false });
    await writer.append(record('orders', 1));
    await writer.close();

    // The name is the caller's, not the default: a deployment that points at an
    // existing WAL must not create a second file beside it.
    const reader = await FileChangeLogReader.open({ dir, fileName: 'wal.jsonl' });
    const [read] = await reader.readAfter(null, 1);
    expect(read?.lsn).toBe('0/00000001');
    await reader.close();

    // And the default file was never created.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual(['wal.jsonl']);
  });

  it('AC 93.19: the pure helpers agree on the shapes they document', () => {
    expect(compareLsn('0/00000001', '0/00000002')).toBe(-1);
    expect(compareLsn('1/00000000', '0/FFFFFFFF')).toBe(1);
    expect(compareLsn('0/0000000A', '0/0000000A')).toBe(0);
    // No separator, an empty part, and a non-hex digit are three different
    // mistakes, and each names itself.
    expect(() => parseLsn('0')).toThrow(/high\/low form/);
    expect(() => parseLsn('/1')).toThrow(/high\/low form/);
    expect(() => parseLsn('0/')).toThrow(/high\/low form/);
    expect(() => parseLsn('0x/1')).toThrow(/not hexadecimal/);
    expect(() => parseLsn('0/0x')).toThrow(/not hexadecimal/);
    expect(() => formatLsn(1.5)).toThrow(/non-negative integer/);
    expect(formatLsn(0)).toBe('0/00000000');

    const event = recordToChangeEvent(
      {
        lsn: '0/00000001',
        table: 'orders',
        operation: 'delete',
        oldValues: { id: 1 },
        newValues: null,
        txId: 'tx-1',
        committedAt: 1_700_000_000_000,
      },
      new HLC('node'),
    );
    expect(event).toMatchObject({
      lsn: '0/00000001',
      tableName: 'orders',
      operation: 'delete',
      oldValues: { id: 1 },
      newValues: null,
      txId: 'tx-1',
    });
  });
});
