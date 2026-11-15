/**
 * FileAuditStore — Production-grade file-based audit log storage.
 *
 * Features:
 *   - Writes audit entries as NDJSON lines (one JSON object per line)
 *   - Automatic log rotation by size or time
 *   - Crash-safe writes (write to .tmp, fsync, rename)
 *   - Compression (gzip) of rotated files
 *   - Query support via a bounded scan across active and compressed segments
 *     (`maxScanLines`), so rotation does not make the trail unreadable
 *   - Pruning deletes rotated files older than retention period
 *
 * @module @agentix-e/db-operations-audit/impl
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream,
  createReadStream,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { IAuditStore, WriteAuditEntryOptions, AuditQueryFilter } from '../interfaces/index.js';
import type { AuditEntry } from '@agentix-e/db-operations-core/types';

// ── Config ───────────────────────────────────────────────────────

export interface FileAuditStoreConfig {
  /** Directory to store audit log files. */
  dataDir: string;
  /** Maximum log file size in bytes before rotation (default: 50 MB). */
  maxFileSize?: number;
  /** Maximum age of a log file in ms before rotation (default: 24h). */
  maxAgeMs?: number;
  /** Keep rotated files for this many days (default: 90). */
  retentionDays?: number;
  /** Base filename prefix (default: 'audit'). */
  filePrefix?: string;
  /** Maximum number of lines to scan when querying (default: 10000). */
  maxScanLines?: number;
}

// ── Defaults ────────────────────────────────────────────────────

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_FILE_PREFIX = 'audit';
export const DEFAULT_MAX_SCAN_LINES = 10000;

// ── File identity helpers ───────────────────────────────────────

/** What identifies a specific file, so a later step can tell it from a namesake. */
export interface FileIdentity {
  size: number;
  ino: number;
}

/** Identity of `path`, or `null` when it does not exist. */
export function fileIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Delete `path` only if it is still the file described by `expected`.
 *
 * Rotation reuses segment names (`audit-YYYYMMDD-0001.ndjson`), so a background
 * compressor that outlives its directory will find *a* file at its old path — the
 * next test's or the next day's. Deleting that would be data loss caused by a
 * cleanup, so identity is checked first. A missing file is not an error: something
 * else already removed it.
 */
export function unlinkIfUnchanged(path: string, expected: FileIdentity): boolean {
  const actual = fileIdentity(path);
  if (!actual) return false;
  if (actual.ino !== expected.ino || actual.size !== expected.size) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
//  FileAuditStore
// ══════════════════════════════════════════════════════════════════

export class FileAuditStore implements IAuditStore {
  private readonly dataDir: string;
  private readonly maxFileSize: number;
  private readonly maxAgeMs: number;
  private readonly retentionDays: number;
  private readonly filePrefix: string;
  private readonly maxScanLines: number;

  /** Current active file path. */
  private activeFilePath: string;

  /** Current file stats (track size). */
  private currentSize = 0;
  private currentCreatedAt: number;

  /**
   * Rotated segments still being compressed in the background.
   *
   * Compression runs off the write path on purpose, but it must be awaitable:
   * without this a caller that shuts the store down (or a test that recreates the
   * directory) races a compressor that is holding a path into the old layout —
   * and since the next segment reuses the same name, the stale compressor deletes
   * a file it never read.
   */
  private readonly pendingCompressions = new Set<Promise<void>>();

  constructor(config: FileAuditStoreConfig) {
    this.dataDir = config.dataDir;
    this.maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.filePrefix = config.filePrefix ?? DEFAULT_FILE_PREFIX;
    this.maxScanLines = config.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;

    // Inverted until now: the directory was created only if it already existed, so
    // a store pointed at a fresh path failed on its first write with ENOENT.
    // A path that exists but is not a directory now fails here, at construction:
    // `resolveActiveFile` reads the directory without a fallback, because a store
    // that cannot list its own segments cannot safely choose one to append to.
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this.activeFilePath = this.resolveActiveFile();
    this.currentSize = existsSync(this.activeFilePath) ? statSync(this.activeFilePath).size : 0;
    this.currentCreatedAt = Date.now();
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Generate a new active file path based on timestamp + sequence. */
  private generateFilePath(timestamp?: number): string {
    const ts = timestamp ?? Date.now();
    const date = new Date(ts);
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = this.getNextSequence(dateStr);
    return join(this.dataDir, `${this.filePrefix}-${dateStr}-${String(seq).padStart(4, '0')}.ndjson`);
  }

  /** Get the next sequence number for a given date prefix. */
  private getNextSequence(datePrefix: string): number {
    let maxSeq = 0;
    try {
      const files = readdirSync(this.dataDir);
      for (const f of files) {
        const match = f.match(new RegExp(`^${this.filePrefix}-${datePrefix}-(\\d{4})\\.ndjson`));
        if (match) {
          maxSeq = Math.max(maxSeq, parseInt(match[1]!, 10));
        }
      }
    } catch {
      /* ignore */
    }
    return maxSeq + 1;
  }

  /** Find or create the active (current write) file. */
  private resolveActiveFile(): string {
    const files = readdirSync(this.dataDir);
    // Find the highest sequence .ndjson that is not compressed
    let active = '';
    let maxSeq = -1;
    for (const f of files) {
      const match = f.match(new RegExp(`^${this.filePrefix}-(\\d{8})-(\\d{4})\\.ndjson$`));
      if (match) {
        const seq = parseInt(match[2]!, 10);
        if (seq > maxSeq) {
          maxSeq = seq;
          active = join(this.dataDir, f);
        }
      }
    }
    return active || this.generateFilePath();
  }

  /** Check if rotation is needed. */
  private shouldRotate(): boolean {
    if (this.currentSize >= this.maxFileSize) return true;
    if (Date.now() - this.currentCreatedAt >= this.maxAgeMs) return true;
    return false;
  }

  /** Rotate: close current file, compress old, start new. */
  private rotate(): void {
    const oldPath = this.activeFilePath;
    this.activeFilePath = this.generateFilePath();
    this.currentSize = 0;
    this.currentCreatedAt = Date.now();

    // What is being compressed, captured now rather than trusted later: segment
    // names are reused after a directory is recreated, so "the file at oldPath" at
    // completion time is not necessarily the file that was read.
    const source = fileIdentity(oldPath);
    if (!source) return;

    // Compress the rotated file in background (non-blocking), but tracked.
    const job = new Promise<void>((resolve) => {
      setImmediate(() => {
        const gzPath = oldPath + '.gz';
        pipeline(createReadStream(oldPath), createGzip(), createWriteStream(gzPath))
          .then(() => {
            // Remove the original only if it is still the file that was compressed.
            unlinkIfUnchanged(oldPath, source);
          })
          .catch(() => {
            // Compression failed: keep the original, drop the partial archive.
            rmSync(gzPath, { force: true });
          })
          .finally(resolve);
      });
    });
    this.pendingCompressions.add(job);
    void job.finally(() => this.pendingCompressions.delete(job));
  }

  /**
   * Wait for a graceful stop: everything that was scheduled has finished.
   *
   * Call this before removing the data directory, or before asserting on its
   * contents — otherwise the assertion races a compressor.
   */
  async close(): Promise<void> {
    while (this.pendingCompressions.size > 0) {
      await Promise.allSettled([...this.pendingCompressions]);
    }
  }

  /**
   * Write a line safely: write to .tmp, fsync, rename (crash-safe).
   * Falls back to direct append if tmp/rename fails.
   */
  private writeLine(line: string): void {
    if (this.shouldRotate()) {
      this.rotate();
    }

    const tmpPath = this.activeFilePath + '.tmp';

    // Drain existing content + append new line
    const existing = existsSync(this.activeFilePath) ? readFileSync(this.activeFilePath) : Buffer.alloc(0);

    const fullContent = Buffer.concat([existing, Buffer.from(line + '\n')]);
    writeFileSync(tmpPath, fullContent);
    // fsync for crash-safety
    try {
      const fd = openSync(tmpPath, 'r');
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      /* fsync best-effort */
    }
    renameSync(tmpPath, this.activeFilePath);

    this.currentSize = fullContent.length;
  }

  // ── IAuditStore implementation ──────────────────────────────

  async write(options: WriteAuditEntryOptions): Promise<string> {
    const id = randomUUID();
    const entry: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      operation: options.operation,
      actor: options.actor,
      resource: options.resource,
      result: options.result,
      severity: options.severity ?? 'info',
      details: options.details,
      traceId: options.traceId,
    };

    this.writeLine(JSON.stringify(entry));
    return id;
  }

  async query(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const allEntries = this.scanEntries();
    const filtered = allEntries.filter((entry) => {
      if (filter.startTime && new Date(entry.timestamp) < filter.startTime) return false;
      if (filter.endTime && new Date(entry.timestamp) > filter.endTime) return false;
      if (filter.operation !== undefined && entry.operation !== filter.operation) return false;
      if (filter.actor !== undefined && entry.actor !== filter.actor) return false;
      if (filter.result !== undefined && entry.result !== filter.result) return false;
      if (filter.severity !== undefined && entry.severity !== filter.severity) return false;
      return true;
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return filtered.slice(offset, offset + limit);
  }

  async get(id: string): Promise<AuditEntry | null> {
    const scan = this.scanEntries();
    return scan.find((e) => e.id === id) ?? null;
  }

  async count(filter?: AuditQueryFilter): Promise<number> {
    return filter ? (await this.query(filter)).length : this.lineCount();
  }

  async pruneOlderThan(timestamp: Date): Promise<number> {
    let removed = 0;
    try {
      const files = readdirSync(this.dataDir);
      for (const f of files) {
        if (f.endsWith('.gz') || f.endsWith('.ndjson')) {
          const filePath = join(this.dataDir, f);
          const stats = statSync(filePath);
          if (stats.mtime < timestamp) {
            rmSync(filePath);
            removed++;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Read a segment, decompressing it when rotation has archived it.
   *
   * Returns `null` for a segment that cannot be read or decoded. One damaged
   * archive must not hide the entries in the segments after it, so the failure is
   * scoped to the file rather than to the scan.
   */
  private readSegment(path: string, compressed: boolean): string | null {
    try {
      const raw = readFileSync(path);
      return compressed ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
    } catch {
      return null;
    }
  }

  /**
   * The files worth reading, newest first, with an archived segment winning over
   * a namesake that is being removed.
   *
   * Rotation writes `X.ndjson.gz` and only then unlinks `X.ndjson`. Between the
   * two, both exist with the same entries in them, so a scan that reads both
   * reports every one of them twice — and a duplicate in an audit report is a
   * wrong number in a compliance statement. The archive is authoritative because
   * it is written last and completely.
   *
   * Newest first, because `maxScanLines` is a budget and a budget spent on old
   * segments hides the entries a caller is most likely asking about: once a store
   * held more than the budget, `query()` could not see anything written after it.
   *
   * Returns `null` when the directory cannot be listed.
   */
  private listReadableFiles(): string[] | null {
    let files: string[];
    try {
      files = readdirSync(this.dataDir).sort();
    } catch {
      // The directory is gone (unmounted, pruned). An audit read over a missing
      // store returns what exists — nothing — rather than throwing at the caller
      // who is already investigating an incident.
      return null;
    }

    const archived = new Set(files.filter((f) => f.endsWith('.ndjson.gz')).map((f) => f.slice(0, -3)));
    return files.filter((f) => !(f.endsWith('.ndjson') && archived.has(f))).reverse();
  }

  /** Scan all `.ndjson`, `.ndjson.gz` and `.json` files, returning parsed entries. */
  private scanEntries(): AuditEntry[] {
    // One block per file, in the order the lines appear inside it. Files are
    // visited newest-first so the budget protects recent history; the blocks are
    // put back in chronological order at the end. Reversing the flat list instead
    // would also reverse the entries *within* a segment, which is backwards.
    const blocks: AuditEntry[][] = [];
    let scanned = 0;

    const files = this.listReadableFiles();
    if (files === null) return [];

    for (const f of files) {
      if (scanned >= this.maxScanLines) break;
      const block: AuditEntry[] = [];
      blocks.push(block);

      if (f.endsWith('.json')) {
        // Single JSON array format
        try {
          const content = readFileSync(join(this.dataDir, f), 'utf-8');
          const entries = JSON.parse(content) as AuditEntry[];
          for (const e of entries) {
            if (scanned >= this.maxScanLines) break;
            block.push(e);
            scanned++;
          }
        } catch {
          /* ignore parse errors */
        }
      } else if (f.endsWith('.ndjson') || f.endsWith('.ndjson.gz')) {
        // NDJSON, compressed once rotation has archived the segment. Dropping the
        // compressed ones made the trail unreadable after the first rotation: the
        // entries were on disk and `query()`, `get()` and `count()` all reported
        // that they were not.
        const content = this.readSegment(join(this.dataDir, f), f.endsWith('.gz'));
        if (content === null) continue;

        for (const line of content.split('\n')) {
          if (scanned >= this.maxScanLines) break;
          if (line.trim().length === 0) continue;
          try {
            block.push(JSON.parse(line) as AuditEntry);
            scanned++;
          } catch {
            /* skip malformed lines, including a torn final line */
          }
        }
      }
    }

    return blocks.reverse().flat();
  }

  /** Count total lines across all NDJSON segments, compressed or not. */
  private lineCount(): number {
    const files = this.listReadableFiles();
    if (files === null) return 0;

    let count = 0;
    for (const f of files) {
      if (!f.endsWith('.ndjson') && !f.endsWith('.ndjson.gz')) continue;
      const content = this.readSegment(join(this.dataDir, f), f.endsWith('.gz'));
      if (content === null) continue;
      count += content.split('\n').filter((l) => l.trim().length > 0).length;
    }
    return count;
  }
}
