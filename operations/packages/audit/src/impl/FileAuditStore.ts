/**
 * FileAuditStore — Production-grade file-based audit log storage.
 *
 * Features:
 *   - Writes audit entries as NDJSON lines (one JSON object per line)
 *   - Automatic log rotation by size or time
 *   - Durable writes: append, sync the file, sync the directory that names it
 *     (`DurableFileSystem`, injectable so the order is assertable)
 *   - Compression (gzip) of rotated files
 *   - Query support via a bounded scan across active and compressed segments
 *     (`maxScanLines`), so rotation does not make the trail unreadable
 *   - Expiry by segment age (`retentionDays`, swept on rotation) and by explicit
 *     `pruneOlderThan()`
 *
 * Two rules keep the numbers in this file true:
 *
 *   1. `maxScanLines` bounds what `query()` *returns*, because the budget exists
 *      to keep a grep-shaped read cheap. It does not bound what `get()` or
 *      `count()` *look up*: an audit store that cannot find an entry it holds, or
 *      that reports 100 matches because the page size defaults to 100, is wrong
 *      in the one place wrongness is not recoverable.
 *   2. Expiry never deletes the segment being appended to. The live segment is
 *      not a rotated file; deleting it would remove entries the retention window
 *      still covers, and the store would keep appending to a path it had just
 *      removed.
 *
 * @module @agentix-e/db-operations-audit/impl
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  createWriteStream,
  createReadStream,
  unlinkSync,
} from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { IAuditStore, WriteAuditEntryOptions, AuditQueryFilter } from '../interfaces/index.js';
import type { AuditEntry } from '@agentix-e/db-operations-core/types';
import { nodeDurableFileSystem } from './DurableFileSystem.js';
import type { DurableFileSystem } from './DurableFileSystem.js';

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
  /**
   * Read port for segment content.
   *
   * The store reads every entry it reports through this hook; the default reads
   * and, when the segment is archived, gunzips the local file. Supplying one lets
   * a deployment keep segments on a different medium (an object store, a cold
   * tier, a fixture) without giving up queries, and lets a caller account for the
   * I/O a scan performs — which is the promise `maxScanLines` makes.
   *
   * Return the segment's text, or `null` when it has none. Throwing is allowed and
   * means the same thing: a segment that cannot be read contributes no entries and
   * does not stop the scan.
   */
  segmentReader?: (path: string, compressed: boolean) => string | null;
  /**
   * Write port: the three steps that make a line survive, plus the one question
   * the recovery path asks.
   *
   * The default appends to the local filesystem with `O_APPEND` and syncs the
   * file and, once per segment, its directory. Supplying one lets a deployment
   * put the trail on a different medium, and lets a test state the order — which
   * is the only part of "crash-safe" that a test can observe without a crash.
   *
   * Whatever is supplied must be durable when it returns: the store acknowledges
   * an entry only after `syncFile` (and, for a new segment, `syncDirectory`)
   * returned.
   */
  fileSystem?: DurableFileSystem;
}

// ── Defaults ────────────────────────────────────────────────────

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_FILE_PREFIX = 'audit';
export const DEFAULT_MAX_SCAN_LINES = 10000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Segment naming ──────────────────────────────────────────────

/**
 * Escape a prefix for use inside a `RegExp`.
 *
 * `filePrefix` is caller input. Interpolating it raw means a prefix containing a
 * metacharacter — `billing.v2`, `audit(prod)` — changes which files the store
 * considers its own, and `billing.v2` would match `billingXv2` too. A configuration
 * value is a name, so it is quoted before it is used as a pattern.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A segment of this store: `<prefix>-<YYYYMMDD>-<NNNN>.ndjson`, optionally
 * archived as `.gz`.
 *
 * Archived names are matched too: a compressed segment still occupies its
 * sequence number, and reusing it would write new entries into a segment whose
 * archive already exists — where every read prefers the archive, so the new
 * entries would be invisible.
 */
export function segmentPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}-\\d{8}-\\d{4}\\.ndjson(\\.gz)?$`);
}

/**
 * Order names for reading: newest first, one name per segment.
 *
 * Exported and pure because this is the one place ordering is decided, and the
 * filesystem is the wrong place to find out whether it works: `readdir` returns
 * names in an order it does not promise, so a test that relied on it would be
 * testing the filesystem.
 *
 * Newest first, because `maxScanLines` is a budget and a budget spent on old
 * segments hides the entries a caller is most likely asking about.
 *
 * A name with an archive beats the plain file of the same segment. Rotation writes
 * `X.ndjson.gz` and only then unlinks `X.ndjson`; between the two, both hold the
 * same entries, and a scan that reads both reports every one of them twice — a
 * duplicate in an audit report is a wrong number in a compliance statement. The
 * archive wins because it is written last and completely.
 */
export function readableSegmentsNewestFirst(names: readonly string[]): string[] {
  // Membership, not a set of stripped names: `<name>.gz` is the archive of
  // `<name>`, and asking the list directly says so without building a second
  // collection that has to be kept in step with the first. Quadratic in the
  // number of segments in one directory, which is dozens, not millions.
  return [...names]
    .sort()
    .filter((name) => !names.includes(`${name}.gz`))
    .reverse();
}

/**
 * The segment new entries are appended to: the newest one that is not archived.
 *
 * Ordering is by the whole name, not by the sequence field. A name is
 * `<prefix>-<YYYYMMDD>-<NNNN>`, both parts zero-padded, so lexicographic order is
 * chronological order — and the sequence alone is not: it restarts at 0001 when
 * the date changes, so comparing sequences alone picks yesterday's `-0003` over
 * today's `-0001` and a restarted process keeps appending to yesterday's file.
 *
 * A segment with an archive is skipped for a sharper reason: reads prefer the
 * archive, so anything appended to the plain file after it was archived is
 * written and never read.
 *
 * Returned as a name, not a path, so the rule can be asserted on arrays instead of
 * on whatever `readdir` happens to hand back.
 */
export function newestOpenSegment(names: readonly string[], prefix: string): string {
  const segment = segmentPattern(prefix);
  let newest = '';
  for (const name of names) {
    if (!segment.test(name)) continue;
    if (name.endsWith('.gz')) continue;
    if (names.includes(`${name}.gz`)) continue;
    if (name > newest) newest = name;
  }
  return newest;
}

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
 * Whether an error means "the file is not there to delete", as opposed to
 * "something went wrong".
 *
 * Narrow on purpose. The catch this replaced took everything, so a `ReferenceError`
 * from a missing import — which is how it was found — reported itself as "the file
 * could not be deleted" and left five uncompressed segments behind. A predicate
 * rather than a list inside the `catch` for the same reason as
 * `isDirectorySyncUnsupported`: two of these codes cannot be produced on a runner
 * that deletes as root, so the decision is tested by being handed the errno.
 */
export function isUnlinkRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  // ENOENT: already gone. EISDIR/EPERM/EACCES: this process may not remove it —
  // a directory, a read-only mount, a file owned by someone else.
  return code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES';
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
  } catch (error) {
    if (isUnlinkRefusal(error)) return false;
    throw error;
  }
}

/**
 * A segment's text, read from the local filesystem.
 *
 * This is the default value of `FileAuditStoreConfig.segmentReader`; it is a
 * module-level function rather than a method so that a deployment can keep the
 * same semantics while wrapping it (accounting, retries, a different medium).
 * Returns `null` — not `''` — when the file is missing or its archive is damaged,
 * because "there is no text" is the port's vocabulary and the store turns it into
 * the empty segment.
 */
export function readSegmentFromDisk(path: string, compressed: boolean): string | null {
  try {
    const raw = readFileSync(path);
    return compressed ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Whether an entry satisfies a filter.
 *
 * `query()` and `count()` share this so the two cannot drift: a filter that
 * selects in one and not in the other makes a count disagree with the page it is
 * counting, which is the shape of a broken audit report.
 */
function matches(entry: AuditEntry, filter: AuditQueryFilter): boolean {
  if (filter.startTime && new Date(entry.timestamp) < filter.startTime) return false;
  if (filter.endTime && new Date(entry.timestamp) > filter.endTime) return false;
  if (filter.operation !== undefined && entry.operation !== filter.operation) return false;
  if (filter.actor !== undefined && entry.actor !== filter.actor) return false;
  if (filter.result !== undefined && entry.result !== filter.result) return false;
  if (filter.severity !== undefined && entry.severity !== filter.severity) return false;
  return true;
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

  /** Where segment text comes from. See `FileAuditStoreConfig.segmentReader`. */
  private readonly segmentReader: (path: string, compressed: boolean) => string | null;

  /** Where written lines go, and what "durable" means there. */
  private readonly fileSystem: DurableFileSystem;

  /** Current active file path. */
  private activeFilePath: string;

  /** Current file stats (track size). */
  private currentSize = 0;
  private currentCreatedAt: number;

  /**
   * The segment was created by this run and its name is not yet on the medium.
   *
   * A file's existence is a directory entry, and syncing the file does not sync
   * the name that leads to it. The first line of a segment therefore pays for one
   * `syncDirectory`, and no later line does.
   */
  private segmentNeedsDirectorySync: boolean;

  /**
   * The segment ends mid-line, so the next append must start with a newline.
   *
   * A torn tail is what a crash between two writes leaves behind. Readers skip
   * an unparsable line, so the fragment costs nothing on its own; appending to it
   * would fuse the next entry to the fragment and lose both, which is a quieter
   * failure than the crash that caused it.
   */
  private separatorOwed: boolean;

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
    this.segmentReader = config.segmentReader ?? readSegmentFromDisk;
    this.fileSystem = config.fileSystem ?? nodeDurableFileSystem;

    // Inverted until now: the directory was created only if it already existed, so
    // a store pointed at a fresh path failed on its first write with ENOENT.
    // A path that exists but is not a directory now fails here, at construction:
    // `resolveActiveFile` reads the directory without a fallback, because a store
    // that cannot list its own segments cannot safely choose one to append to.
    // Unconditional: `recursive: true` does nothing to a directory that exists, and
    // a path that is not a directory fails with ENOTDIR here — at construction,
    // where a store that cannot list its own segments should fail.
    mkdirSync(this.dataDir, { recursive: true });

    this.activeFilePath = this.resolveActiveFile();
    this.currentSize = existsSync(this.activeFilePath) ? statSync(this.activeFilePath).size : 0;
    this.currentCreatedAt = Date.now();

    // A store cannot know whether the process that created this segment synced its
    // name — it may have died between the data and the directory entry — so it pays
    // one directory sync per segment it opens. Asking `currentSize === 0` saved a
    // single `fsync` per process start and turned "the name is durable" into "the
    // name was probably durable", which is not the same claim.
    this.segmentNeedsDirectorySync = true;
    // The other thing the previous run may have left behind: a segment that does
    // not end on a line boundary. Asked once, here.
    this.separatorOwed = this.fileSystem.needsSeparator(this.activeFilePath);
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
    const taken = new RegExp(`^${escapeRegExp(this.filePrefix)}-${datePrefix}-(\\d{4})\\.ndjson(\\.gz)?$`);
    let files: string[];
    try {
      files = readdirSync(this.dataDir);
    } catch {
      // A directory that cannot be listed holds no names to avoid.
      return 1;
    }

    // Outside the `try`: a parse bug in this loop used to be caught by the same
    // handler as a missing directory, so the sequence restarted at 0001 and the
    // next rotation overwrote a segment instead of failing.
    let maxSeq = 0;
    for (const f of files) {
      const match = f.match(taken);
      if (match) maxSeq = Math.max(maxSeq, Number.parseInt(match[1]!, 10));
    }
    return maxSeq + 1;
  }

  /** Find or create the active (current write) file. */
  private resolveActiveFile(): string {
    const active = newestOpenSegment(readdirSync(this.dataDir), this.filePrefix);
    // No segment yet, or every one is archived: start the next one. Falling back
    // to `generateFilePath` rather than constructing a name here keeps the
    // sequence collision rule in one place.
    return active === '' ? this.generateFilePath() : join(this.dataDir, active);
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
    // The new segment does not exist yet, so its name is not on the medium and
    // its first append has to fix that. It is also the first thing written into
    // it, so no separator can be owed.
    this.segmentNeedsDirectorySync = true;
    this.separatorOwed = false;

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
            // Compression failed: keep the original, drop whatever partial archive
            // is there. `recursive` because the thing at that path may not be a
            // file — and because a throw *here* has no handler above it: the job's
            // promise is resolved by `finally`, so a rejected cleanup would surface
            // as an unhandled rejection in a process that is otherwise fine.
            rmSync(gzPath, { force: true, recursive: true });
          })
          .finally(() => {
            // After the archive is in place, so the sweep sees the segment under
            // the name it will keep.
            this.sweepExpiredSegments();
            resolve();
          });
      });
    });
    this.pendingCompressions.add(job);
    void job.finally(() => this.pendingCompressions.delete(job));
  }

  /**
   * Delete segments whose last write is older than `retentionDays`.
   *
   * Retention was a documented configuration value that nothing read: a store
   * configured to keep ninety days kept everything, and the only way to expire a
   * segment was to call `pruneOlderThan` yourself. It runs here because rotation
   * is the moment a segment stops being the live one — expiry is a property of
   * closed segments, so a store that never rotates never expires anything, and an
   * idle store never expires the file it is still appending to.
   *
   * `retentionDays: 0` disables automatic expiry rather than meaning "keep
   * nothing": retention that deletes evidence on construction is a footgun, and a
   * caller who wants to prune decides when.
   */
  private sweepExpiredSegments(): void {
    if (this.retentionDays <= 0) return;
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    const segment = segmentPattern(this.filePrefix);

    let files: string[];
    try {
      files = readdirSync(this.dataDir);
    } catch {
      return;
    }

    for (const f of files) {
      if (!segment.test(f)) continue;
      // No skip for the live segment: this runs after rotation moved
      // `activeFilePath` to the segment that was just opened, so the file being
      // expired is by definition a closed one. The guard that used to be here could
      // never be true for an expired path, which is why no test could see it.
      const path = join(this.dataDir, f);
      try {
        if (statSync(path).mtime.getTime() >= cutoff) continue;
        rmSync(path);
      } catch {
        // A segment that cannot be examined is not one to delete: reporting an
        // expiry that did not happen is worse than leaving the file for the next
        // sweep, which is what the next rotation is.
      }
    }
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
   * Append one line so that it survives a power loss.
   *
   * The recipe is three steps and one order:
   *
   *   1. `append` — the bytes are in the file (probably still in the page cache).
   *   2. `syncFile` — the file's data is on the medium.
   *   3. `syncDirectory`, only for a segment created by this run — the *name* is
   *      on the medium. The name is a directory entry; step 2 does not touch it,
   *      so without step 3 a crash can leave the data written and unreachable.
   *
   * Every failure propagates. The previous revision caught the `fsync` and
   * carried on — "best-effort" — which meant `write()` returned an id for an
   * entry that could be gone after a power loss, and the one component whose job
   * is to record what happened was the one component reporting a success it could
   * not observe. A caller can retry a rejection; it cannot retry a lie.
   *
   * Nothing here reads the segment. The previous revision did — it read the whole
   * file, concatenated the new line and renamed a replacement into place — so
   * appending to a segment cost its entire size, a segment of 50 000 lines cost
   * 50 000 rewrites, and the last line of a large segment rewrote 50 MB to add
   * 400 bytes. It also made two writers to one trail lose each other's entries,
   * because each one wrote what it had read a moment earlier.
   */
  private writeLine(line: string): void {
    if (this.shouldRotate()) {
      this.rotate();
    }

    const data = `${this.separatorOwed ? '\n' : ''}${line}\n`;

    // The append is the step that can leave the file longer than `currentSize`
    // says, so the accounting follows it rather than the whole recipe: a failed
    // sync reports failure, but the bytes are there and the rotation threshold
    // has to be measured against what is.
    this.fileSystem.append(this.activeFilePath, data);
    this.currentSize += Buffer.byteLength(data);
    this.separatorOwed = false;

    this.fileSystem.syncFile(this.activeFilePath);

    if (this.segmentNeedsDirectorySync) {
      this.fileSystem.syncDirectory(this.dataDir);
      this.segmentNeedsDirectorySync = false;
    }
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
    const filtered = this.scanEntries(this.maxScanLines).filter((entry) => matches(entry, filter));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return filtered.slice(offset, offset + limit);
  }

  /**
   * Look an entry up by id across the whole trail.
   *
   * Unbounded on purpose. `maxScanLines` keeps a *page* cheap; an id lookup is a
   * question with one answer, and answering "not found" because the entry sits
   * beyond a ten-thousand-line budget turns a lookup into a lie.
   */
  async get(id: string): Promise<AuditEntry | null> {
    return this.scanEntries(null).find((e) => e.id === id) ?? null;
  }

  /**
   * Count the entries matching `filter`, ignoring paging.
   *
   * `offset` and `limit` are paging, not selection: a count that inherited
   * `limit: 100` from `query()`'s default reported at most one hundred matches
   * for any filter, and an `offset` shortened it further. A number that is wrong
   * exactly when the trail is large is the wrong number to be wrong about.
   */
  async count(filter?: AuditQueryFilter): Promise<number> {
    const entries = this.scanEntries(null);
    return filter ? entries.filter((entry) => matches(entry, filter)).length : entries.length;
  }

  /**
   * Delete closed segments last written before `timestamp`; returns how many went.
   *
   * Two boundaries are deliberate. Only names this store could have produced are
   * touched (`segmentPattern`), because a prune is a delete and a delete should
   * not need a directory of its own; and the live segment is skipped even when it
   * is old, because removing the file the store is appending to would drop the
   * entries a resumed store is about to write. Each file is removed in isolation:
   * one unreadable segment used to abandon the whole sweep through the outer
   * `catch`, leaving evidence past its retention date and reporting a partial
   * number as the result.
   */
  async pruneOlderThan(timestamp: Date): Promise<number> {
    const segment = segmentPattern(this.filePrefix);
    let files: string[];
    try {
      files = readdirSync(this.dataDir);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const f of files) {
      if (!segment.test(f)) continue;
      const path = join(this.dataDir, f);
      if (path === this.activeFilePath) continue;
      try {
        if (statSync(path).mtime >= timestamp) continue;
        rmSync(path);
        removed++;
      } catch {
        /* leave it for the next sweep rather than claiming it went */
      }
    }
    return removed;
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Read a segment, decompressing it when rotation has archived it.
   *
   * There is no `null` return any more, and no `continue` at the call sites. A
   * sentinel meaning "this segment has no entries" was a second way of saying what
   * the parser already says — `JSON.parse(null)` and `JSON.parse('')` both yield
   * nothing to push — so it created two branches whose removal no run could
   * observe, and two mutants that survived for exactly that reason. A segment that
   * cannot be read is an empty segment: one damaged archive must not hide the
   * entries in the segments after it, and saying so once is enough.
   */
  private readSegment(path: string, compressed: boolean): string {
    try {
      return this.segmentReader(path, compressed) ?? '';
    } catch {
      // A reader that throws is a reader that produced nothing. The policy lives
      // here rather than in the port so that every port — including a future
      // remote one — inherits the same containment.
      return '';
    }
  }

  /**
   * The files worth reading, newest first; `null` when the directory is gone.
   *
   * The directory is gone (unmounted, pruned) far more often than a caller expects:
   * an audit read over a missing store returns what exists — nothing — rather than
   * throwing at the person who is already investigating an incident.
   */
  private listReadableFiles(): string[] | null {
    try {
      // This store's own names — `<prefix>-…ndjson`, archived or not — plus the
      // single-array `.json` files it documents reading. A directory can hold an
      // export, a second store's segments, or the `.tmp` of an in-flight write;
      // reading them puts entries from another trail into this one's audit report,
      // and the pruner (which only deletes names it could have produced) would
      // never agree to remove them. The match is on the prefix rather than on the
      // full segment shape, so a hand-planted `audit-timed.ndjson` is still read
      // while `auditXv2-…` — another store's file — is not.
      const owned = `${this.filePrefix}-`;
      // `.json` is the legacy single-array format, which was written before
      // segments had a prefix, so it is matched by extension alone.
      const mine = (f: string): boolean =>
        f.endsWith('.json') || (f.startsWith(owned) && (f.endsWith('.ndjson') || f.endsWith('.ndjson.gz')));
      return readableSegmentsNewestFirst(readdirSync(this.dataDir).filter(mine));
    } catch {
      return null;
    }
  }

  /**
   * Scan the readable segments, returning parsed entries in chronological order.
   *
   * `budget` caps how many entries are collected (`null` for no cap); it is
   * applied while scanning newest-first, so a capped scan keeps the most recent
   * history rather than the oldest.
   */
  private scanEntries(budget: number | null): AuditEntry[] {
    // One block per file, in the order the lines appear inside it. Files are
    // visited newest-first so the budget protects recent history; the blocks are
    // put back in chronological order at the end. Reversing the flat list instead
    // would also reverse the entries *within* a segment, which is backwards.
    const blocks: AuditEntry[][] = [];
    let scanned = 0;
    const exhausted = (): boolean => budget !== null && scanned >= budget;

    const files = this.listReadableFiles();
    if (files === null) return [];

    for (const f of files) {
      if (exhausted()) break;
      const block: AuditEntry[] = [];
      blocks.push(block);

      if (f.endsWith('.json')) {
        // Single JSON array format.
        const array = this.readSegment(join(this.dataDir, f), false);
        try {
          for (const e of JSON.parse(array) as AuditEntry[]) {
            if (exhausted()) break;
            block.push(e);
            scanned++;
          }
        } catch {
          /* ignore parse errors: a damaged export must not fail the query */
        }
        continue;
      }

      // Everything else in this list is one of this store's segments, compressed
      // once rotation archived them. Skipping the compressed ones made the trail
      // unreadable after the first rotation: the entries were on disk and `query()`,
      // `get()` and `count()` all reported that they were not.
      const content = this.readSegment(join(this.dataDir, f), f.endsWith('.gz'));

      for (const line of content.split('\n')) {
        if (exhausted()) break;
        // A blank line — the one after the final newline, or a whitespace-only
        // line — is not JSON, so the parser rejects it and the `catch` below skips
        // it. The guard that checked for one was a second way of saying that, and
        // no test could tell which of the two was doing the work.
        try {
          block.push(JSON.parse(line) as AuditEntry);
          scanned++;
        } catch {
          /* skip malformed lines, including a torn final line */
        }
      }
    }

    return blocks.reverse().flat();
  }
}
