/**
 * SqliteKeyValueEngine — a second, deliberately different implementation of
 * {@link IStorageEngine}, used to prove that the SPI is engine-agnostic.
 *
 * It shares nothing with `MemoryStorageEngine`: durable file-backed storage, an
 * SQL schema, a NUL-delimited command encoding instead of JSON, and synchronous
 * driver calls wrapped in promises. If the conformance suite passes for both, the
 * contract is not an artefact of one implementation.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineApplyContext, IStorageEngine } from '../../interfaces/IStorageEngine';

type Op = 'put' | 'del' | 'get' | 'keys' | 'size';
interface Request {
  op: Op;
  key?: string;
  value?: string;
}

/**
 * NUL-delimited wire format: `op\0key\0value`.
 *
 * Chosen because it is nothing like the reference engine's JSON, which is the
 * point — the middleware must not care what the bytes mean.
 */
function decode(buffer: Buffer): Request {
  const parts = buffer.toString('utf8').split('\0');
  const op = parts[0] as Op;
  switch (op) {
    case 'put':
      if (parts.length !== 3) throw new Error('SqliteKeyValueEngine: put needs op\\0key\\0value');
      return { op, key: parts[1]!, value: parts[2]! };
    case 'del':
    case 'get':
      if (parts.length !== 2) throw new Error(`SqliteKeyValueEngine: ${op} needs op\\0key`);
      return { op, key: parts[1]! };
    case 'keys':
    case 'size':
      return { op };
    default:
      throw new Error(`SqliteKeyValueEngine: unknown op "${String(parts[0])}"`);
  }
}

function encode(request: Request): Buffer {
  const parts = [request.op];
  if (request.key !== undefined) parts.push(request.key);
  if (request.value !== undefined) parts.push(request.value);
  return Buffer.from(parts.join('\0'), 'utf8');
}

export class SqliteKeyValueEngine implements IStorageEngine {
  readonly name = 'sqlite-kv';

  private readonly db: Database.Database;
  private readonly file: string;
  private readonly ownsFile: boolean;
  private closed = false;

  constructor(file?: string) {
    this.ownsFile = file === undefined;
    this.file = file ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-engine-')), 'engine.db');
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async apply(context: EngineApplyContext, payload: Buffer): Promise<void> {
    // One database file per shard, so the shard id is not part of the key. A real
    // multi-shard engine would fold `context.shardId` into the primary key; the
    // fixture keeps the schema small on purpose.
    void context;
    const request = decode(payload);
    switch (request.op) {
      case 'put':
        this.db
          .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(request.key!, request.value!);
        return;
      case 'del':
        this.db.prepare('DELETE FROM kv WHERE key = ?').run(request.key!);
        return;
      default:
        throw new Error(`SqliteKeyValueEngine: "${request.op}" is not a command`);
    }
  }

  async query(request: Buffer): Promise<Buffer> {
    const parsed = decode(request);
    switch (parsed.op) {
      case 'get': {
        const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(parsed.key!) as
          { value: string } | undefined;
        // JSON here, NUL-delimited everywhere else: unlike a delimited field, JSON
        // can tell "absent" from "present but empty", and a storage engine must.
        return Buffer.from(JSON.stringify({ v: row?.value ?? null }), 'utf8');
      }
      case 'keys': {
        const rows = this.db.prepare('SELECT key FROM kv ORDER BY key').all() as Array<{ key: string }>;
        return Buffer.from(`keys\0${rows.map((r) => r.key).join('\0')}`, 'utf8');
      }
      case 'size':
        return Buffer.from(
          String(
            (
              this.db.prepare('SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS n FROM kv').get() as {
                n: number;
              }
            ).n,
          ),
          'utf8',
        );
      default:
        throw new Error(`SqliteKeyValueEngine: "${parsed.op}" is not a query`);
    }
  }

  async snapshot(): Promise<Buffer> {
    const rows = this.db.prepare('SELECT key, value FROM kv ORDER BY key').all() as Array<{
      key: string;
      value: string;
    }>;
    // NUL-delimited rows, NUL-NUL between records: deterministic for a given state.
    return Buffer.from(rows.map((r) => `${r.key}\0${r.value}`).join('\0\0'), 'utf8');
  }

  async restore(snapshot: Buffer): Promise<void> {
    const text = snapshot.toString('utf8');
    const records = text.length === 0 ? [] : text.split('\0\0');
    const parsed = records.map((record) => {
      const [key, value] = record.split('\0');
      if (key === undefined || value === undefined) throw new Error('SqliteKeyValueEngine: malformed snapshot record');
      return { key, value };
    });
    // Validate everything before touching the table: a bad snapshot must leave the
    // current state intact.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM kv').run();
      const insert = this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
      for (const row of parsed) insert.run(row.key, row.value);
    })();
  }

  async sizeInBytes(): Promise<number> {
    const row = this.db.prepare('SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS n FROM kv').get() as {
      n: number;
    };
    return row.n;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (this.ownsFile) fs.rmSync(path.dirname(this.file), { recursive: true, force: true });
  }
}

/** Codec that adapts the standard key/value workload to the NUL-delimited format. */
export const sqliteCodec = {
  put: (key: string, value: string) => encode({ op: 'put', key, value }),
  del: (key: string) => encode({ op: 'del', key }),
  get: (key: string) => encode({ op: 'get', key }),
  keys: () => encode({ op: 'keys' }),
  decodeGet: (response: Buffer): string | null => (JSON.parse(response.toString('utf8')) as { v: string | null }).v,
  decodeKeys: (response: Buffer): string[] => {
    const parts = response.toString('utf8').split('\0').slice(1);
    return parts.filter((part) => part.length > 0);
  },
};
