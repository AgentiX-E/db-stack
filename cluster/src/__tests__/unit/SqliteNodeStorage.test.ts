/**
 * Tests for SqliteNodeStorage and all four sub-storage implementations.
 *
 * Verifies:
 *   1. SqliteMetaStorage: term/vote read/write
 *   2. SqliteLogStorage: append, read, range, truncate, compact, reset
 *   3. SqliteSnapshotStorage: save, load, metadata
 *   4. SqliteConfigStorage: read/write voters and learners
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from '../../consensus/storage/SqliteStorage';
import {
  SqliteNodeStorage,
  SqliteMetaStorage,
  SqliteLogStorage,
  SqliteSnapshotStorage,
  SqliteConfigStorage,
} from '../../consensus/storage/SqliteNodeStorage';
import { LogEntryType } from '@maboke123/raft-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tempDbPath(name: string): string {
  const dir = path.join(os.tmpdir(), `sqlite-nodestorage-test-${name}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'raft.db');
}

describe('SqliteMetaStorage', () => {
  let sqlite: SqliteStorage;
  let meta: SqliteMetaStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`meta-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
    meta = new SqliteMetaStorage(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return null when no data stored', async () => {
    const data = await meta.read();
    expect(data).toBeNull();
  });

  it('should write and read term/votedFor', async () => {
    await meta.write(5, 'node-2');
    const data = await meta.read();
    expect(data).not.toBeNull();
    expect(data!.term).toBe(5);
    expect(data!.votedFor).toBe('node-2');
  });

  it('should overwrite previous values', async () => {
    await meta.write(3, 'node-1');
    await meta.write(7, 'node-2');
    const data = await meta.read();
    expect(data!.term).toBe(7);
    expect(data!.votedFor).toBe('node-2');
  });

  it('should write null votedFor', async () => {
    await meta.write(10, null);
    const data = await meta.read();
    expect(data!.term).toBe(10);
    expect(data!.votedFor).toBeNull();
  });

  it('should report isOpen correctly', () => {
    expect(meta.isOpen()).toBe(true);
    sqlite.close();
    expect(meta.isOpen()).toBe(false);
  });
});

describe('SqliteLogStorage', () => {
  let sqlite: SqliteStorage;
  let log: SqliteLogStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`log-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
    log = new SqliteLogStorage(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return empty meta on fresh storage', async () => {
    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(0);
    expect(meta.snapshotTerm).toBe(0);
    expect(meta.lastIndex).toBe(0);
    expect(meta.lastTerm).toBe(0);
  });

  it('should append and read entries', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'set', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'set', payload: 'b' } },
    ]);

    const e1 = await log.getEntry(1);
    expect(e1).not.toBeNull();
    expect(e1!.index).toBe(1);
    expect(e1!.term).toBe(1);
    expect(e1!.command?.payload).toBe('a');

    const e2 = await log.getEntry(2);
    expect(e2).not.toBeNull();
    expect(e2!.command?.payload).toBe('b');
  });

  it('should read a range of entries', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'x' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'y' } },
      { index: 3, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'z' } },
    ]);

    const entries = await log.getEntries(1, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].index).toBe(1);
    expect(entries[1].index).toBe(2);
  });

  it('should truncate from a given index', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
      { index: 3, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'c' } },
    ]);

    await log.truncateFrom(2);

    const e1 = await log.getEntry(1);
    expect(e1).not.toBeNull();
    const e2 = await log.getEntry(2);
    expect(e2).toBeNull();
    const e3 = await log.getEntry(3);
    expect(e3).toBeNull();
  });

  it('should compact logs up to an index', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
      { index: 3, term: 2, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'c' } },
    ]);

    await log.compact(2, 1);

    // Entries <= 2 should be removed
    const e1 = await log.getEntry(1);
    expect(e1).toBeNull();
    const e3 = await log.getEntry(3);
    expect(e3).not.toBeNull();

    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(2);
    expect(meta.snapshotTerm).toBe(1);
  });

  it('should preserve lastIndex == snapshotIndex when compaction empties the log', async () => {
    // Regression: when compaction removes every on-disk row, a naive
    // getLastIndex() returns 0, corrupting the raft-core invariant that
    // lastIndex >= snapshotIndex. This caused the AppendEntries
    // LogInconsistencyError ("Entry index X does not match expected index 1").
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
      { index: 3, term: 2, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'c' } },
    ]);

    // Compaction covers the entire retained log, leaving the table empty.
    await log.compact(3, 2);

    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(3);
    expect(meta.snapshotTerm).toBe(2);
    expect(meta.lastIndex).toBe(3);
    expect(meta.lastTerm).toBe(2);
  });

  it('should preserve lastIndex == snapshotIndex when reset empties the log', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
    ]);

    await log.reset(5, 3);

    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(5);
    expect(meta.snapshotTerm).toBe(3);
    expect(meta.lastIndex).toBe(5);
    expect(meta.lastTerm).toBe(3);
  });

  it('should report lastIndex from surviving tail when not fully compacted', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
      { index: 3, term: 2, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'c' } },
    ]);

    // Partial compaction: index 3 survives, so lastIndex reflects it.
    await log.compact(2, 1);

    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(2);
    expect(meta.lastIndex).toBe(3);
    expect(meta.lastTerm).toBe(2);
  });

  it('should reset logs to snapshot boundary', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'a' } },
      { index: 2, term: 1, type: LogEntryType.COMMAND, command: { type: 'cmd', payload: 'b' } },
    ]);

    await log.reset(5, 3);

    const e1 = await log.getEntry(1);
    expect(e1).toBeNull();

    const meta = await log.readMeta();
    expect(meta.snapshotIndex).toBe(5);
    expect(meta.snapshotTerm).toBe(3);
  });

  it('should write NOOP and CONFIG entry types', async () => {
    await log.append([
      { index: 1, term: 1, type: LogEntryType.NOOP },
      {
        index: 2,
        term: 1,
        type: LogEntryType.CONFIG,
        config: { voters: [{ id: '1', address: 'addr1' }], learners: [] },
      },
    ]);

    const e1 = await log.getEntry(1);
    expect(e1!.type).toBe(LogEntryType.NOOP);

    const e2 = await log.getEntry(2);
    expect(e2!.type).toBe(LogEntryType.CONFIG);
  });
});

describe('SqliteSnapshotStorage', () => {
  let sqlite: SqliteStorage;
  let snap: SqliteSnapshotStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`snap-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
    snap = new SqliteSnapshotStorage(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return null when no snapshot exists', async () => {
    const meta = await snap.readMetadata();
    expect(meta).toBeNull();
  });

  it('should save and load a snapshot', async () => {
    await snap.save({
      lastIncludedIndex: 10,
      lastIncludedTerm: 3,
      data: Buffer.from('state-data'),
      config: { voters: [{ id: '1', address: 'node1:5001' }], learners: [] },
    });

    const loaded = await snap.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.lastIncludedIndex).toBe(10);
    expect(loaded!.lastIncludedTerm).toBe(3);
    expect(loaded!.data.toString()).toBe('state-data');
    expect(loaded!.config.voters).toHaveLength(1);
  });

  it('should overwrite existing snapshot', async () => {
    await snap.save({
      lastIncludedIndex: 5,
      lastIncludedTerm: 2,
      data: Buffer.from('old'),
      config: { voters: [], learners: [] },
    });

    await snap.save({
      lastIncludedIndex: 20,
      lastIncludedTerm: 4,
      data: Buffer.from('new'),
      config: { voters: [{ id: '2', address: 'node2:5002' }], learners: [] },
    });

    const loaded = await snap.load();
    expect(loaded!.lastIncludedIndex).toBe(20);
    expect(loaded!.data.toString()).toBe('new');
  });

  it('should read metadata correctly', async () => {
    await snap.save({
      lastIncludedIndex: 15,
      lastIncludedTerm: 5,
      data: Buffer.from('data'),
      config: { voters: [], learners: [] },
    });

    const meta = await snap.readMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.lastIncludedIndex).toBe(15);
    expect(meta!.lastIncludedTerm).toBe(5);
  });
});

describe('SqliteConfigStorage', () => {
  let sqlite: SqliteStorage;
  let config: SqliteConfigStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`config-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
    config = new SqliteConfigStorage(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return null when no config stored', async () => {
    const data = await config.read();
    expect(data).toBeNull();
  });

  it('should write and read voters and learners', async () => {
    await config.write(
      [
        { id: '1', address: 'node1:5001' },
        { id: '2', address: 'node2:5002' },
      ],
      [{ id: '3', address: 'node3:5003' }],
    );

    const data = await config.read();
    expect(data).not.toBeNull();
    expect(data!.voters).toHaveLength(2);
    expect(data!.learners).toHaveLength(1);
    expect(data!.voters[0].id).toBe('1');
    expect(data!.learners[0].id).toBe('3');
  });

  it('should overwrite previously stored config', async () => {
    await config.write([{ id: 'old', address: 'old:5001' }], []);
    await config.write([{ id: 'new', address: 'new:5001' }], []);

    const data = await config.read();
    expect(data!.voters).toHaveLength(1);
    expect(data!.voters[0].id).toBe('new');
  });
});

describe('SqliteNodeStorage (aggregate)', () => {
  let sqlite: SqliteStorage;
  let nodeStorage: SqliteNodeStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`node-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
    nodeStorage = new SqliteNodeStorage(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should expose all four sub-storages', () => {
    expect(nodeStorage.meta).toBeInstanceOf(SqliteMetaStorage);
    expect(nodeStorage.log).toBeInstanceOf(SqliteLogStorage);
    expect(nodeStorage.snapshot).toBeInstanceOf(SqliteSnapshotStorage);
    expect(nodeStorage.config).toBeInstanceOf(SqliteConfigStorage);
  });

  it('should report isOpen correctly', () => {
    expect(nodeStorage.isOpen()).toBe(true);
    sqlite.close();
    expect(nodeStorage.isOpen()).toBe(false);
  });

  it('should support full round-trip: meta + log + snapshot + config', async () => {
    // Meta
    await nodeStorage.meta.write(10, 'leader-1');
    const meta = await nodeStorage.meta.read();
    expect(meta!.term).toBe(10);

    // Log
    await nodeStorage.log.append([
      { index: 1, term: 10, type: LogEntryType.COMMAND, command: { type: 'set', payload: 'value1' } },
      { index: 2, term: 10, type: LogEntryType.COMMAND, command: { type: 'set', payload: 'value2' } },
    ]);

    // Snapshot
    await nodeStorage.snapshot.save({
      lastIncludedIndex: 2,
      lastIncludedTerm: 10,
      data: Buffer.from('snap-data'),
      config: { voters: [{ id: '1', address: 'node1:5001' }], learners: [] },
    });

    // Config
    await nodeStorage.config.write(
      [
        { id: '1', address: 'node1:5001' },
        { id: '2', address: 'node2:5002' },
      ],
      [],
    );

    // Verify all
    const loadedSnap = await nodeStorage.snapshot.load();
    expect(loadedSnap!.lastIncludedIndex).toBe(2);

    const configData = await nodeStorage.config.read();
    expect(configData!.voters).toHaveLength(2);
  });
});

describe('SqliteNodeStorage — delegated open/close + defensive branches', () => {
  let sqlite: SqliteStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`deleg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('invokes each sub-storage open/close (no-op delegates)', async () => {
    const meta = new SqliteMetaStorage(sqlite);
    const log = new SqliteLogStorage(sqlite);
    const snap = new SqliteSnapshotStorage(sqlite);
    const config = new SqliteConfigStorage(sqlite);
    const node = new SqliteNodeStorage(sqlite);

    await meta.open();
    await meta.close();
    await log.open();
    await log.close();
    await snap.open();
    await snap.close();
    await config.open();
    await config.close();
    await node.open();
    await node.close();

    // isOpen reflects the underlying SqliteStorage db handle.
    expect(meta.isOpen()).toBe(true);
    expect(log.isOpen()).toBe(true);
    expect(snap.isOpen()).toBe(true);
    expect(config.isOpen()).toBe(true);
    expect(node.isOpen()).toBe(true);
  });

  it('meta.read returns null when term is not a number', async () => {
    const meta = new SqliteMetaStorage(sqlite);
    await meta.write(1, 'node-1');
    // Corrupt the term to a non-numeric string.
    sqlite.setKv('node_term', Buffer.from('not-a-number'));
    expect(await meta.read()).toBeNull();
  });

  it('meta.read treats empty votedFor as null', async () => {
    const meta = new SqliteMetaStorage(sqlite);
    await meta.write(3, null);
    const r = await meta.read();
    expect(r!.term).toBe(3);
    expect(r!.votedFor).toBeNull();
  });

  it('log.append is a no-op for an empty array', async () => {
    const log = new SqliteLogStorage(sqlite);
    await log.append([]);
    expect((await log.readMeta()).lastIndex).toBe(0);
  });

  it('log.getEntry falls back to raw utf-8 payload on invalid JSON', async () => {
    const log = new SqliteLogStorage(sqlite);
    // Insert a COMMAND row whose data is not valid JSON.
    sqlite.appendLogEntry(1, 1, 0, Buffer.from('corrupt-json'));
    const entry = await log.getEntry(1);
    expect(entry).not.toBeNull();
    expect(entry!.command!.type).toBe('command');
    expect(entry!.command!.payload).toBe('corrupt-json');
  });

  it('snapshot.load returns null when snapshot index is absent', async () => {
    const snap = new SqliteSnapshotStorage(sqlite);
    expect(await snap.load()).toBeNull();
  });

  it('snapshot.load returns null when snapshot index is non-positive', async () => {
    const snap = new SqliteSnapshotStorage(sqlite);
    sqlite.setKv('snapshot_index', Buffer.from('0'));
    expect(await snap.load()).toBeNull();
  });

  it('snapshot.load defaults data to an empty buffer when absent', async () => {
    const snap = new SqliteSnapshotStorage(sqlite);
    sqlite.setKv('snapshot_index', Buffer.from('5'));
    // No snap term, no data, no config → fall back to defaults.
    const s = await snap.load();
    expect(s).not.toBeNull();
    expect(s!.lastIncludedIndex).toBe(5);
    expect(s!.lastIncludedTerm).toBe(0);
    expect(s!.data.length).toBe(0);
  });

  it('snapshot.load uses an empty config when config JSON is corrupt', async () => {
    const snap = new SqliteSnapshotStorage(sqlite);
    sqlite.setKv('snapshot_index', Buffer.from('3'));
    sqlite.setKv('snapshot_config', Buffer.from('not-json'));
    const s = await snap.load();
    expect(s!.config).toEqual({ voters: [], learners: [] });
  });

  it('config.read returns null when voters buffer is absent', async () => {
    const config = new SqliteConfigStorage(sqlite);
    expect(await config.read()).toBeNull();
  });

  it('config.read falls back to empty voters/learners on corrupt JSON', async () => {
    const config = new SqliteConfigStorage(sqlite);
    sqlite.setKv('config_voters', Buffer.from('corrupt'));
    sqlite.setKv('config_learners', Buffer.from('also-corrupt'));
    const r = await config.read();
    expect(r).not.toBeNull();
    expect(r!.voters).toEqual([]);
    expect(r!.learners).toEqual([]);
  });
});

describe('SqliteNodeStorage — nullish/fallback branches', () => {
  let sqlite: SqliteStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`nullish-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 0 });
    sqlite.open();
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('snapshot.readMetadata defaults lastIncludedTerm to 0 when term absent', async () => {
    const snap = new SqliteSnapshotStorage(sqlite);
    sqlite.setKv('snapshot_index', Buffer.from('7'));
    // No snapshot_term → lastIncludedTerm falls back to 0.
    const meta = await snap.readMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.lastIncludedIndex).toBe(7);
    expect(meta!.lastIncludedTerm).toBe(0);
  });

  it('log.getEntry falls back to "command" when parsed type is absent', async () => {
    const log = new SqliteLogStorage(sqlite);
    // COMMAND row with valid JSON lacking a "type" field.
    const json = JSON.stringify({ payload: 'x' });
    sqlite.appendLogEntry(1, 1, 0, Buffer.from(json));
    const entry = await log.getEntry(1);
    expect(entry!.command!.type).toBe('command');
  });

  it('log.getEntry falls back to the whole object when payload is absent', async () => {
    const log = new SqliteLogStorage(sqlite);
    const json = JSON.stringify({ type: 'set' });
    sqlite.appendLogEntry(1, 1, 0, Buffer.from(json));
    const entry = await log.getEntry(1);
    // payload is missing → `parsed.payload ?? parsed` returns the full object.
    expect(entry!.command!.payload).toEqual({ type: 'set' });
  });
});
