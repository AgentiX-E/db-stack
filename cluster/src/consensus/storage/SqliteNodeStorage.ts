/**
 * SqliteNodeStorage — Adapter between @maboke123/raft-core NodeStorage and existing SqliteStorage
 *
 * Implements the four sub-storage interfaces (MetaStorage, LogStorage,
 * SnapshotStorage, ConfigStorage) by bridging to the existing SqliteStorage
 * key-value and raft_log tables.
 *
 * @module consensus/storage/SqliteNodeStorage
 */

import type {
  NodeStorage,
  MetaStorage,
  MetaData,
  LogStorage,
  LogStorageMeta,
  LogEntry,
  LogEntryType,
  SnapshotStorage,
  ConfigStorage,
  ConfigStorageData,
} from '@maboke123/raft-core';
import type { SnapshotMetaData, Snapshot } from './snapshotTypes';

import { LogEntryType as CoreLogEntryType } from '@maboke123/raft-core';
import { SqliteStorage } from './SqliteStorage';
import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';

const logger = pino({ level: resolveLogLevel() });

// ──────────────────────────────────────────
//  Constants (raft_kv keys)
// ──────────────────────────────────────────

const KV_META_TERM = 'node_term';
const KV_META_VOTEDFOR = 'node_voted_for';
const KV_SNAP_INDEX = 'snapshot_index';
const KV_SNAP_TERM = 'snapshot_term';
const KV_SNAP_DATA = 'snapshot_data';
const KV_SNAP_CONFIG = 'snapshot_config';
const KV_CONFIG_VOTERS = 'config_voters';
const KV_CONFIG_LEARNERS = 'config_learners';

// ──────────────────────────────────────────
//  SqliteMetaStorage
// ──────────────────────────────────────────

export class SqliteMetaStorage implements MetaStorage {
  constructor(private sqlite: SqliteStorage) {}

  async open(): Promise<void> {
    // Delegated to parent SqliteStorage
  }

  async close(): Promise<void> {
    // Delegated to parent SqliteStorage
  }

  isOpen(): boolean {
    return this.sqlite.getDb() !== null;
  }

  async read(): Promise<MetaData | null> {
    const termBuf = this.sqlite.getKv(KV_META_TERM);
    const voteBuf = this.sqlite.getKv(KV_META_VOTEDFOR);
    if (!termBuf) return null;

    const term = Number(termBuf.toString());
    if (isNaN(term)) return null;

    let votedFor: string | null = null;
    if (voteBuf) {
      const v = voteBuf.toString();
      votedFor = v.length > 0 ? v : null;
    }

    return { term, votedFor };
  }

  async write(term: number, votedFor: string | null): Promise<void> {
    this.sqlite.setKv(KV_META_TERM, Buffer.from(String(term)));
    this.sqlite.setKv(KV_META_VOTEDFOR, Buffer.from(votedFor ?? ''));
  }
}

// ──────────────────────────────────────────
//  SqliteLogStorage
// ──────────────────────────────────────────

export class SqliteLogStorage implements LogStorage {
  constructor(private sqlite: SqliteStorage) {}

  async open(): Promise<void> {
    // Delegated
  }

  async close(): Promise<void> {
    // Delegated
  }

  isOpen(): boolean {
    return this.sqlite.getDb() !== null;
  }

  async readMeta(): Promise<LogStorageMeta> {
    const snapshotIndex = this.sqlite.getSnapshotIndex();
    const snapTermBuf = this.sqlite.getKv(KV_SNAP_TERM);
    const snapshotTerm = snapTermBuf ? Number(snapTermBuf.toString()) : 0;

    // raft-core's LogStorage contract requires the invariant `lastIndex >=
    // snapshotIndex`: the snapshot covers everything up to `snapshotIndex`, so
    // the "last retained index" never drops below that boundary even when
    // compaction removed every on-disk row (leaving the raft_log table empty).
    // A bare `getLastIndex()` returns 0 on an empty table, which would corrupt
    // LogManager.lastIndex and later trip `Entry index X does not match expected
    // index 1` on the next AppendEntries. Clamp it to the snapshot boundary.
    const tableLastIndex = this.sqlite.getLastIndex();
    const lastIndex = Math.max(tableLastIndex, snapshotIndex);

    // When the log tail coincides with the snapshot boundary, the authoritative
    // term is the snapshot term (the on-disk row for that index was compacted
    // away); otherwise read the term of the surviving tail entry.
    const lastTerm =
      lastIndex > snapshotIndex ? this.sqlite.getTerm(lastIndex) : snapshotTerm;

    return { snapshotIndex, snapshotTerm, lastIndex, lastTerm };
  }

  async append(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    this.sqlite.beginBatch();
    try {
      for (const entry of entries) {
        const typeNum = this.entryTypeToNumber(entry.type);
        let data: Buffer | null = null;
        if (entry.command) {
          const payload = JSON.stringify({ ...entry.command });
          data = Buffer.from(payload, 'utf-8');
        }
        this.sqlite.appendLogEntry(entry.index, entry.term, typeNum, data);
      }
    } finally {
      this.sqlite.endBatch();
    }
  }

  async getEntry(index: number): Promise<LogEntry | null> {
    const row = this.sqlite.getLogEntry(index);
    if (!row) return null;

    return this.rowToLogEntry(row);
  }

  async getEntries(from: number, to: number): Promise<LogEntry[]> {
    const rows = this.sqlite.getLogEntries(from, to + 1); // SqliteStorage hi is exclusive, raft-core to is inclusive
    return rows.map((r) => this.rowToLogEntry(r));
  }

  async truncateFrom(index: number): Promise<void> {
    await this.sqlite.truncateLogsFrom(index);
  }

  async compact(upToIndex: number, term: number): Promise<void> {
    // Store snapshot term
    this.sqlite.setKv(KV_SNAP_TERM, Buffer.from(String(term)));
    await this.sqlite.compactLogs(upToIndex);
  }

  async reset(snapshotIndex: number, snapshotTerm: number): Promise<void> {
    await this.sqlite.truncateAllLogs();
    this.sqlite.setKv(KV_SNAP_INDEX, Buffer.from(String(snapshotIndex)));
    this.sqlite.setKv(KV_SNAP_TERM, Buffer.from(String(snapshotTerm)));
  }

  // ── Helpers ──

  private entryTypeToNumber(type: LogEntryType): number {
    if (type === CoreLogEntryType.COMMAND) return 0;
    if (type === CoreLogEntryType.CONFIG) return 1;
    return 2; // NOOP
  }

  private rowToLogEntry(row: { index: number; term: number; type: number; data: Buffer | null }): LogEntry {
    let logType: LogEntryType;
    if (row.type === 0) logType = CoreLogEntryType.COMMAND;
    else if (row.type === 1) logType = CoreLogEntryType.CONFIG;
    else logType = CoreLogEntryType.NOOP;

    let command: { type: string; payload: any } | undefined;
    if (row.data && row.type === 0) {
      try {
        const parsed = JSON.parse(row.data.toString('utf-8'));
        command = { type: parsed.type || 'command', payload: parsed.payload ?? parsed };
      } catch {
        command = { type: 'command', payload: row.data.toString('utf-8') };
      }
    }

    return {
      index: row.index,
      term: row.term,
      type: logType,
      command,
    };
  }
}

// ──────────────────────────────────────────
//  SqliteSnapshotStorage
// ──────────────────────────────────────────

export class SqliteSnapshotStorage implements SnapshotStorage {
  constructor(private sqlite: SqliteStorage) {}

  async open(): Promise<void> {
    // Delegated
  }

  async close(): Promise<void> {
    // Delegated
  }

  isOpen(): boolean {
    return this.sqlite.getDb() !== null;
  }

  async readMetadata(): Promise<SnapshotMetaData | null> {
    const snapIndex = this.sqlite.getSnapshotIndex();
    if (snapIndex <= 0) return null;

    const snapTermBuf = this.sqlite.getKv(KV_SNAP_TERM);
    const lastIncludedTerm = snapTermBuf ? Number(snapTermBuf.toString()) : 0;

    return { lastIncludedIndex: snapIndex, lastIncludedTerm };
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.sqlite.setKv(KV_SNAP_INDEX, Buffer.from(String(snapshot.lastIncludedIndex)));
    this.sqlite.setKv(KV_SNAP_TERM, Buffer.from(String(snapshot.lastIncludedTerm)));
    this.sqlite.setKv(KV_SNAP_DATA, snapshot.data);
    this.sqlite.setKv(
      KV_SNAP_CONFIG,
      Buffer.from(
        JSON.stringify({
          voters: snapshot.config.voters,
          learners: snapshot.config.learners,
        }),
      ),
    );
  }

  async load(): Promise<Snapshot | null> {
    const idxBuf = this.sqlite.getKv(KV_SNAP_INDEX);
    if (!idxBuf) return null;

    const lastIncludedIndex = Number(idxBuf.toString());
    if (lastIncludedIndex <= 0) return null;

    const lastIncludedTerm = Number((this.sqlite.getKv(KV_SNAP_TERM) ?? '0').toString());
    const data = this.sqlite.getKv(KV_SNAP_DATA);
    const configBuf = this.sqlite.getKv(KV_SNAP_CONFIG);

    let config = { voters: [], learners: [] };
    if (configBuf) {
      try {
        config = JSON.parse(configBuf.toString());
      } catch {
        // Use default
      }
    }

    return {
      lastIncludedIndex,
      lastIncludedTerm,
      data: data ?? Buffer.alloc(0),
      config: config as any,
    };
  }
}

// ──────────────────────────────────────────
//  SqliteConfigStorage
// ──────────────────────────────────────────

export class SqliteConfigStorage implements ConfigStorage {
  constructor(private sqlite: SqliteStorage) {}

  async open(): Promise<void> {
    // Delegated
  }

  async close(): Promise<void> {
    // Delegated
  }

  isOpen(): boolean {
    return this.sqlite.getDb() !== null;
  }

  async read(): Promise<ConfigStorageData | null> {
    const votersBuf = this.sqlite.getKv(KV_CONFIG_VOTERS);
    if (!votersBuf) return null;

    let voters: any[];
    try {
      voters = JSON.parse(votersBuf.toString());
    } catch {
      voters = [];
    }

    let learners: any[] = [];
    const learnersBuf = this.sqlite.getKv(KV_CONFIG_LEARNERS);
    if (learnersBuf) {
      try {
        learners = JSON.parse(learnersBuf.toString());
      } catch {
        learners = [];
      }
    }

    return { voters, learners };
  }

  async write(voters: any[], learners: any[]): Promise<void> {
    this.sqlite.setKv(KV_CONFIG_VOTERS, Buffer.from(JSON.stringify(voters)));
    this.sqlite.setKv(KV_CONFIG_LEARNERS, Buffer.from(JSON.stringify(learners)));
  }
}

// ──────────────────────────────────────────
//  SqliteNodeStorage
// ──────────────────────────────────────────

export class SqliteNodeStorage implements NodeStorage {
  readonly meta: MetaStorage;
  readonly log: LogStorage;
  readonly snapshot: SnapshotStorage;
  readonly config: ConfigStorage;

  constructor(private sqlite: SqliteStorage) {
    this.meta = new SqliteMetaStorage(sqlite);
    this.log = new SqliteLogStorage(sqlite);
    this.snapshot = new SqliteSnapshotStorage(sqlite);
    this.config = new SqliteConfigStorage(sqlite);
  }

  async open(): Promise<void> {
    // SqliteStorage is already opened by the caller
  }

  async close(): Promise<void> {
    // SqliteStorage close is managed externally
  }

  isOpen(): boolean {
    return this.sqlite.getDb() !== null;
  }
}
