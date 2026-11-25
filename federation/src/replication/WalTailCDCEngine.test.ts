/**
 * WalTailCDCEngine — the engine whose events were written by somebody else.
 *
 * The simulator's events come from `appendChange()`; these come from a file a
 * separate writer handle appended to, read back through `IChangeLogReader`.
 *
 *   AC 94.1  every record in the log is emitted once, in LSN order
 *   AC 94.2  startAfterLsn resumes strictly after the consumer's checkpoint
 *   AC 94.3  a watch set filters delivery and does not hold the cursor back
 *   AC 94.4  an empty watch set delivers what the log holds
 *   AC 94.5  a read error is counted and reported, and the tail keeps trying
 *   AC 94.6  a detached listener stops receiving, and the others continue
 *   AC 94.7  two concurrent polls emit each record once
 *   AC 94.8  start() is idempotent; stop() ends the timer
 *   AC 94.9  HLC timestamps are strictly increasing at equal commit times
 *   AC 94.10 a checkpoint that is not an LSN is refused at construction
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeLogReader, FileChangeLogWriter } from './FileChangeLog';
import { WalTailCDCEngine } from './WalTailCDCEngine';
import type { ChangeLogRecord, IChangeLogReader } from '../interfaces/replication/IChangeLogReader';
import type { CDCChangeEvent } from '../interfaces/replication/ICDCManager';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeLog(): Promise<{ dir: string; writer: FileChangeLogWriter; reader: FileChangeLogReader }> {
  const dir = mkdtempSync(join(tmpdir(), 'waltail-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const writer = await FileChangeLogWriter.open({ dir });
  const reader = await FileChangeLogReader.open({ dir });
  cleanups.push(async () => {
    await writer.close();
    await reader.close();
  });
  return { dir, writer, reader };
}

const change = (table: string, id: number) => ({
  table,
  operation: 'insert' as const,
  newValues: { id },
  txId: `tx-${table}-${id}`,
});

function collect(engine: WalTailCDCEngine): CDCChangeEvent[] {
  const seen: CDCChangeEvent[] = [];
  engine.onChange((event) => seen.push(event));
  return seen;
}

describe('WalTailCDCEngine', () => {
  it('AC 94.1: every record in the log is emitted once, in LSN order', async () => {
    const { writer, reader } = await makeLog();
    for (let i = 1; i <= 4; i++) await writer.append(change('orders', i));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    const seen = collect(engine);
    await engine.start();
    await engine.poll();

    expect(seen.map((event) => event.lsn)).toEqual(['0/00000001', '0/00000002', '0/00000003', '0/00000004']);
    expect(seen.map((event) => event.tableName)).toEqual(['orders', 'orders', 'orders', 'orders']);
    expect(engine.getStatus()).toMatchObject({ emitted: 4, readErrors: 0, position: '0/00000004' });
    await engine.stop();
  });

  it('AC 94.2: startAfterLsn resumes strictly after the consumer checkpoint', async () => {
    const { writer, reader } = await makeLog();
    for (let i = 1; i <= 3; i++) await writer.append(change('orders', i));

    const engine = new WalTailCDCEngine({
      reader,
      nodeId: 'dc-east',
      startAfterLsn: '0/00000002',
    });
    const seen = collect(engine);
    await engine.start();

    expect(seen.map((event) => event.lsn)).toEqual(['0/00000003']);
    await engine.stop();
  });

  it('AC 94.3: a watch set filters delivery and does not hold the cursor back', async () => {
    const { writer, reader } = await makeLog();
    await writer.append(change('orders', 1));
    await writer.append(change('audit', 2));
    await writer.append(change('orders', 3));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    engine.watchTable('orders');
    const seen = collect(engine);
    await engine.start();

    expect(seen.map((event) => event.newValues)).toEqual([{ id: 1 }, { id: 3 }]);
    expect(engine.getStatus()).toMatchObject({
      skipped: 1,
      emitted: 2,
      // The audit record was consumed even though it was not delivered: a
      // cursor left behind it would re-read it on every poll, forever.
      position: '0/00000003',
    });

    engine.unwatchTable('orders');
    expect(engine.getWatchedTables()).toEqual([]);
    await engine.stop();
  });

  it('AC 94.4: an empty watch set delivers what the log holds', async () => {
    const { writer, reader } = await makeLog();
    await writer.append(change('orders', 1));
    await writer.append(change('audit', 2));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    const seen = collect(engine);
    await engine.start();

    expect(seen).toHaveLength(2);
    await engine.stop();
  });

  it('AC 94.5: a read error is counted and reported, and the tail keeps trying', async () => {
    const records: ChangeLogRecord[] = [
      {
        lsn: '0/00000001',
        table: 'orders',
        operation: 'insert',
        oldValues: null,
        newValues: { id: 1 },
        txId: 'tx-1',
        committedAt: 1,
      },
    ];
    let failures = 2;
    const errors: unknown[] = [];
    const reader: IChangeLogReader = {
      async readAfter(afterLsn) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('EACCES: the directory is not readable');
        }
        return records.filter((r) => afterLsn === null || r.lsn > afterLsn);
      },
      async head() {
        return '0/00000001';
      },
    };

    const engine = new WalTailCDCEngine({
      reader,
      nodeId: 'dc-east',
      onReadError: (error) => errors.push(error),
    });
    const seen = collect(engine);

    await engine.start();
    expect(seen).toEqual([]);
    expect(engine.getStatus()).toMatchObject({
      readErrors: 1,
      lastError: 'EACCES: the directory is not readable',
    });

    await engine.poll();
    expect(engine.getStatus().readErrors).toBe(2);

    await engine.poll();
    expect(seen.map((event) => event.lsn)).toEqual(['0/00000001']);
    expect(engine.getStatus().lastError).toBeNull();
    expect(errors).toHaveLength(2);
    await engine.stop();
  });

  it('AC 94.6: a detached listener stops receiving, and the others continue', async () => {
    const { writer, reader } = await makeLog();
    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    const first: CDCChangeEvent[] = [];
    const second: CDCChangeEvent[] = [];
    const detach = engine.onChange((event) => first.push(event));
    engine.onChange((event) => {
      second.push(event);
      throw new Error('a consumer that throws must not stop the stream');
    });

    // The two polls are driven by hand rather than through `start()`. The case is
    // about which listener saw which record, and `start()` polls once before it
    // resolves *and* leaves an interval behind: the answer then depended on where
    // those two ran relative to `detach()`, which is a property of how busy the
    // machine was rather than of the engine. Two explicit polls, no timer.
    await writer.append(change('orders', 1));
    await engine.poll();
    detach();
    await writer.append(change('orders', 2));
    await engine.poll();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    await engine.stop();
  });

  it('AC 94.7: two concurrent polls emit each record once', async () => {
    const { writer, reader } = await makeLog();
    for (let i = 1; i <= 3; i++) await writer.append(change('orders', i));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    const seen = collect(engine);
    await Promise.all([engine.poll(), engine.poll(), engine.poll()]);

    expect(seen.map((event) => event.lsn)).toEqual(['0/00000001', '0/00000002', '0/00000003']);
    await engine.stop();
  });

  it('AC 94.8: start() is idempotent and stop() ends the timer', async () => {
    const { writer, reader } = await makeLog();
    await writer.append(change('orders', 1));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east', pollIntervalMs: 5 });
    const seen = collect(engine);
    await engine.start();
    await engine.start();
    expect(engine.started).toBe(true);

    // The interval keeps finding new records without anybody calling poll().
    await writer.append(change('orders', 2));
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(2);

    await engine.stop();
    await engine.stop();
    expect(engine.started).toBe(false);

    await writer.append(change('orders', 3));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(2);

    // A stopped tail drops its listeners, like the simulator it replaces.
    expect(engine.getStatus().started).toBe(false);
  });

  it('AC 94.9: HLC timestamps are strictly increasing at equal commit times', async () => {
    const { writer, reader } = await makeLog();
    // One commit millisecond, three records: the log's order has to survive a
    // coarse clock, which is only possible if the logical counter carries it.
    for (let i = 1; i <= 3; i++) {
      await writer.append({ ...change('orders', i), committedAt: 1_700_000_000_000 });
    }

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    const seen = collect(engine);
    await engine.start();

    const walls = seen.map((event) => event.timestamp.wallTime);
    const logical = seen.map((event) => event.timestamp.logical);
    expect(walls).toEqual([1_700_000_000_000n, 1_700_000_000_000n, 1_700_000_000_000n]);
    expect(logical).toEqual([0, 1, 2]);
    expect(seen[0]!.timestamp.nodeId).toBe('dc-east');
    await engine.stop();
  });

  it('AC 94.11: currentPosition and started report the state of the tail', async () => {
    const { writer, reader } = await makeLog();
    await writer.append(change('orders', 1));

    const engine = new WalTailCDCEngine({ reader, nodeId: 'dc-east' });
    expect(engine.started).toBe(false);
    expect(engine.currentPosition).toBeNull();

    await engine.start();
    expect(engine.started).toBe(true);
    expect(engine.currentPosition).toBe('0/00000001');

    await engine.stop();
    expect(engine.started).toBe(false);
    expect(engine.currentPosition).toBe('0/00000001');
  });

  it('AC 94.10: a checkpoint that is not an LSN is refused at construction', async () => {
    const { reader } = await makeLog();
    expect(() => new WalTailCDCEngine({ reader, nodeId: 'dc-east', startAfterLsn: 'yesterday' })).toThrow(
      /high\/low form/,
    );
    expect(() => new WalTailCDCEngine({ reader, nodeId: '' })).toThrow(/nodeId/);
    expect(() => new WalTailCDCEngine({ reader: undefined as unknown as IChangeLogReader, nodeId: 'x' })).toThrow(
      /reader/,
    );
  });
});
