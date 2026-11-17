/**
 * FileAuditStore — Production-grade file-based audit log storage.
 *
 * Features:
 *   - Writes audit entries as NDJSON lines (one JSON object per line)
 *   - Automatic log rotation by size or time
 *   - Durable writes: append, sync the file, sync the directory that names it
 *     (`DurableFileSystem`, injectable so the order is assertable)
 *   - Group commit: one file sync acknowledges every append made in the same turn,
 *     because a sync covers all the bytes before it — so ten concurrent callers pay
 *     one round trip to the medium instead of ten
 *   - Compression (gzip) of rotated files, written to a partial name and renamed
 *     into place, so an incomplete archive is never visible to a reader
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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  /**
   * How a segment name is claimed, `O_CREAT | O_EXCL` by default.
   *
   * Injectable for one reason: the interesting answers are "somebody else has that
   * name" and "the name could not be created", and a runner cannot produce either on
   * demand. A store that reported a taken name as a failed disk would stop rotating
   * under load; a store that reported a failed disk as a taken name would spin eight
   * times and then accuse its peers.
   */
  claim?: (path: string) => void;
}

// ── Defaults ────────────────────────────────────────────────────

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_FILE_PREFIX = 'audit';

/**
 * How many names the store tries before it gives up on claiming a segment.
 *
 * Eight refusals mean eight other writers named a segment in the same millisecond.
 * The bound exists because a retry loop with no ceiling is not a policy, and the
 * error it raises names the real problem: a directory being written by more processes
 * than it can serve.
 */
const CLAIM_ATTEMPTS = 8;
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
 *
 * `unlink` is injectable for the same reason `nodeFileCalls` is: the branch that
 * matters most here — a removal that fails for a reason other than refusal, which
 * must reach the caller instead of reporting "cannot delete" — cannot be produced on
 * a runner that deletes as root. Rather than leave that arm untested, it is a
 * parameter a test can hand an `EIO` to.
 */
export function unlinkIfUnchanged(
  path: string,
  expected: FileIdentity,
  unlink: (path: string) => void = unlinkSync,
): boolean {
  const actual = fileIdentity(path);
  if (!actual) return false;
  if (actual.ino !== expected.ino || actual.size !== expected.size) return false;
  try {
    unlink(path);
    return true;
  } catch (error) {
    if (isUnlinkRefusal(error)) return false;
    throw error;
  }
}

/**
 * Whether `after` is still the file the compressor read.
 *
 * `null` — the file is gone — counts as publishable, and that is not laxity: the
 * archive holds every byte that was in it, so it is now the only copy of those
 * entries and refusing to publish it would delete them.
 *
 * A *different* file at the same path, or the same file grown, does not. Both mean
 * the archive is a prefix of the segment, and since a reader prefers an archive
 * over its original, publishing it would make every line after the prefix
 * unreadable — data on the disk that no query can see, which is the failure this
 * module exists to be incapable of. The appends are atomic; it is the *archive*
 * that has to be whole.
 *
 * A function of two identities rather than an inline comparison because the three
 * answers (gone, same, grown) are the whole of the rule and a runner cannot
 * produce the middle one at will.
 */
export function isWholeSegment(after: FileIdentity | null, before: FileIdentity): boolean {
  if (after === null) return true;
  return after.ino === before.ino && after.size === before.size;
}

/**
 * What a segment name and its archive say to each other when both exist.
 *
 * A name is a view of a segment, and rotation publishes a second view of the same
 * segment as `<name>.gz`. Every reader prefers the archive — correctly, because
 * between the rename and the unlink both hold the same entries — and that preference
 * is sound only while the two views cover the same bytes.
 *
 * A second live writer breaks that, and it breaks it through the feature that makes a
 * restart a continuation: the second store *adopts* the newest open segment, the first
 * one later rotates and archives it, and the second one's next append recreates the
 * plain name from the unlink onwards — holding lines the archive has never seen. Those
 * lines are complete and on the disk, behind a name every reader has already decided
 * to skip.
 *
 * Comparing the two texts is the only evidence that survives a crash, because it is
 * the only evidence about the *bytes*: a pid, an mtime or a lease file all record who
 * meant to own the name, and the question is what the name holds. Eight answers, each
 * with its own repair:
 *
 *   `no-twin`           only one of the two names exists — nothing to relate
 *   `plain-missing`     the archive's name exists, the segment's does not
 *   `plain-unreadable`  the segment's name exists but yields no text
 *   `archive-unreadable` the archive's name exists but yields no text — a damaged
 *                        archive hides a readable segment while contributing nothing
 *   `same`              identical bytes: the plain file is a complete second copy
 *   `plain-extra`       the file starts with the archive and is longer, so the *file*
 *                       is the superset and it is the archive that hides entries
 *   `archive-extra`     the archive starts with the file, so the file carries nothing
 *                       the archive does not already hold
 *   `disjoint`          neither contains the other: both carry unique entries and one
 *                       of them has to move to a name of its own
 *
 * `startsWith` and not a byte-wise diff: a segment is newline-delimited records
 * appended in order, so "one contains the other" is the whole of the relation between
 * two views of it. A shared prefix that ends mid-record cannot occur — an archive is
 * produced from a whole file, and the file grows by whole lines.
 */
export type TwinVerdict =
  | 'no-twin'
  | 'plain-missing'
  | 'plain-unreadable'
  | 'archive-unreadable'
  | 'same'
  | 'plain-extra'
  | 'archive-extra'
  | 'disjoint';

/**
 * One view of a segment: whether the name is there, and what it says.
 *
 * Two fields rather than one nullable string because they are two different questions
 * and only one of them is about the bytes: a name that exists and yields no text — a
 * damaged archive, a file this process may not read — is a name a reader will still
 * prefer over its twin, so "exists" and "readable" have to be answerable separately.
 */
export interface SegmentView {
  readonly exists: boolean;
  readonly text: string | null;
}

/** The view of `path`, read from the local filesystem. */
export function readView(path: string, compressed: boolean): SegmentView {
  if (!isRegularFile(path)) return { exists: false, text: null };
  return { exists: true, text: readSegmentFromDisk(path, compressed) };
}

/**
 * What to do about a pair of views, given where they were found.
 *
 * A table rather than two chains of `if`, because the two chains are the same decision
 * asked in two places and the answers differ in exactly three cells: a file that is an
 * exact copy of its archive is deleted at rest (nothing continues it) and the *archive*
 * is deleted while writing (the file is the thing being appended to); a file contained
 * in its archive is the file that goes at rest and the name that is abandoned while
 * writing; a file whose archive exists but has no file beside it is nothing at rest and
 * a refusal while writing. Written as two chains, three of those five differences were
 * mutants no test could tell from the wrong answer, because the wrong answer also
 * repaired the state on the next line.
 *
 * `release` is not a repair of the pair — it is the statement that this store cannot
 * prove the line belongs to a file it holds, so it stops using the name and refuses the
 * write. `none` covers the two verdicts where the right move is to do nothing: no twin
 * at all, and a view that cannot be read (deleting evidence to make a verdict come out
 * clean is not a repair).
 */
export function repairFor(verdict: TwinVerdict, when: 'live' | 'at-rest'): TwinRepair {
  if (verdict === 'disjoint') return 'promote';
  if (verdict === 'plain-extra' || verdict === 'archive-unreadable') return 'remove-archive';
  if (verdict === 'same') return when === 'live' ? 'remove-archive' : 'remove-plain';
  if (verdict === 'archive-extra') return when === 'live' ? 'release' : 'remove-plain';
  if (verdict === 'plain-missing') return when === 'live' ? 'release' : 'none';
  return 'none';
}

/** What `repairFor` decides. See the table it is written from. */
export type TwinRepair = 'none' | 'remove-archive' | 'remove-plain' | 'promote' | 'release';

/**
 * The segment names in `names` that have an archive beside them.
 *
 * A function of the listing rather than a loop inside the sweep, for the reason
 * `newestOpenSegment` is one: the pairing rule has four conditions and a runner cannot
 * produce the directory states that separate them one at a time, so they are asserted
 * on arrays. The three that look redundant are not: without `endsWith('.gz')` an
 * archive that has an archive of its own (`X.ndjson.gz.gz`) makes `X.ndjson.gz` look
 * like a segment, and without the prefix test a neighbouring store's files are this
 * store's to rename.
 */
export function shadowedPairs(names: readonly string[], prefix: string): string[] {
  const segment = segmentPattern(prefix);
  const pairs: string[] = [];
  for (const name of names) {
    if (name.endsWith('.gz')) continue;
    if (!segment.test(name)) continue;
    if (!names.includes(`${name}.gz`)) continue;
    pairs.push(name);
  }
  return pairs;
}

/** Relate a segment's two views. See `TwinVerdict` for what each answer means. */
export function relateTwin(plain: SegmentView, archived: SegmentView): TwinVerdict {
  if (!archived.exists) return 'no-twin';
  if (!plain.exists) return 'plain-missing';
  // An unreadable view is not an empty one: it is a name a reader prefers and gets
  // nothing from, which is the state worth repairing rather than the state to ignore.
  if (plain.text === null) return 'plain-unreadable';
  if (archived.text === null) return 'archive-unreadable';
  if (plain.text === archived.text) return 'same';
  if (plain.text.startsWith(archived.text)) return 'plain-extra';
  if (archived.text.startsWith(plain.text)) return 'archive-extra';
  return 'disjoint';
}

/**
 * Whether a segment has outlived its retention window.
 *
 * `mtime === null` — the date could not be read — is **not** an expiry. Deleting a
 * segment because its `stat` failed turns an I/O error into permanent data loss,
 * and reporting an expiry that did not happen is worse than leaving the file for
 * the next sweep, which is what the next rotation is.
 *
 * Three lines, and worth extracting: this was the one expression in the store that
 * no test could distinguish, because its null arm was reachable only through a
 * failing `stat` — so mutation testing reported a change to it as *survived* while
 * every other line in the file was accounted for. The rule is now a function with
 * a name, and the four cases are four assertions.
 */
export function isExpired(mtime: number | null, cutoff: number): boolean {
  if (mtime === null) return false;
  return mtime < cutoff;
}

/**
 * Take exclusive ownership of a segment name, or report that somebody else has it.
 *
 * A segment name is chosen by reading the directory and taking the next sequence
 * number — a decision two processes can reach at the same moment, in the same
 * millisecond, from the same scan. Without a claim both append into the same file,
 * and the damage is not the interleaving (an `O_APPEND` write is positioned by the
 * kernel) but what follows it: whoever rotates first compresses that segment and
 * unlinks it while the other is still writing, the other's next append recreates
 * the name, and the reader — which prefers an archive over the plain file of the
 * same name — stops seeing everything written after the archive was taken. On the
 * disk, invisible to every query.
 *
 * `O_CREAT | O_EXCL` is the only operation that answers "was this name free?"
 * atomically, so a name is claimed before it is written to.
 *
 * `false` means "that name is taken", which is an answer. Anything else is thrown:
 * a failure to create the file is not a collision, and retrying it would turn an
 * unavailable disk into a slow loop.
 */
export function claimSegment(
  path: string,
  claim: (path: string) => void = (target) => closeSync(openSync(target, 'wx')),
): boolean {
  try {
    claim(path);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

/** Whether a failure means "that name exists", which is an answer and not an error. */
export function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'EEXIST';
}

// ── Directory primitives ────────────────────────────────────────
//
// Five places in this file need "the names in this directory, or nothing", "is this
// a file", "what is its mtime", "remove it if you can". Each of them used to carry
// its own `try`/`catch`, which meant five handlers nobody could reach: `readdir` on
// the store's own directory fails when it has been unmounted, `rm` fails when the
// medium is read-only, and a runner that runs as root can produce neither. Written
// as functions, each answer is one call a test can make with a path that is missing
// or a `remove` that refuses.

/**
 * The names in `directory`, or `null` when it cannot be read.
 *
 * `null` and not `[]`: "there is nothing here" and "I could not look" are different
 * answers, and the callers that care (adoption, expiry) behave differently — but both
 * are survivable, which is why none of them throws at a caller who is already
 * investigating an incident.
 */
export function listDirectory(directory: string): string[] | null {
  try {
    return readdirSync(directory);
  } catch {
    return null;
  }
}

/**
 * Whether `path` is a file that can be read, as opposed to a name that exists.
 *
 * A directory called `X.ndjson.gz` holds no entries, and treating it as an archive
 * hid the complete `X.ndjson` beside it. `false` for a path that is gone covers the
 * race this is called inside: another process's rotation retires an archive between
 * the listing and the read all the time.
 */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** When `path` was last written, or `null` when it has no answer to give. */
export function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtime.getTime();
  } catch {
    return null;
  }
}

/**
 * Remove `path`, reporting whether it went.
 *
 * `false` for a removal that was refused — already gone, not ours to delete, a
 * directory where a file was expected — because in each of those cases the caller's
 * next move is the same: leave it for the next sweep. A failure that is *not* a
 * refusal is not reported as "cannot delete": it is thrown, because a cleanup that
 * reports success for something it could not do is how evidence stays past its
 * retention while the report says it expired.
 *
 * Not `recursive`, deliberately: a directory that carries a segment's name is not a
 * segment, and removing a tree because it shares a name with one is how a cleanup
 * becomes data loss. `EISDIR` is a refusal, so the sweep leaves it alone.
 *
 * `remove` is injectable for the same reason `unlink` is above.
 */
export function removeFile(path: string, remove: (path: string) => void = unlinkSync): boolean {
  try {
    remove(path);
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

// ── Archiving ───────────────────────────────────────────────────

/**
 * The suffix a compression writes under before it is published.
 *
 * A name with it is not a segment: `segmentPattern`, `newestOpenSegment` and the
 * store's own reader all ignore it, so a half-written archive is invisible —
 * which is the whole point. See `archiveSegment`.
 */
export const PARTIAL_ARCHIVE_SUFFIX = '.part';

/** How an archive is produced. Injectable so the publication can be observed. */
export type CompressFile = (source: string, destination: string) => Promise<void>;

/** Compress one file into another with gzip. The default `CompressFile`. */
export async function gzipFile(source: string, destination: string): Promise<void> {
  await pipeline(createReadStream(source), createGzip(), createWriteStream(destination));
}

/**
 * Compress a rotated segment, then publish the archive — in that order.
 *
 * The order is the fix for a defect this function exists to make unrepresentable.
 * Compression used to write straight to `<segment>.ndjson.gz`, and the reader
 * prefers an archive over the plain segment of the same name (otherwise a scan
 * between the archive and the unlink reports every entry twice). So for the whole
 * duration of a compression — a second, on a fifty-megabyte segment — the archive
 * existed and was incomplete, the plain segment was still complete and was
 * therefore *hidden*, and `get(id)` answered `null` for an entry sitting on the
 * disk. An audit store that cannot find an entry it holds is wrong in the one
 * place wrongness is not recoverable, and it was wrong for as long as gzip ran.
 *
 * Four steps, and the same rule as the write path: nothing is published before
 * it is complete.
 *
 *   1. compress into `<archive>.part` — a name no reader believes in;
 *   2. check that the segment is still the segment, and still the same length —
 *      an append that arrived while gzip ran makes the archive a prefix, and a
 *      prefix is not a segment (see `isWholeSegment`);
 *   3. `rename`, which is atomic within a directory, so the archive appears
 *      complete or not at all;
 *   4. unlink the plain segment, if it is still the file that was compressed, in
 *      the same synchronous block as the rename — so in this process the two
 *      never coexist, and a scan cannot double-count them.
 *
 * A failed compression leaves the plain segment (readable, uncompressed) and
 * removes its own partial: an archive that is not there is a cost, an archive
 * that is there and empty is a lost entry.
 */
export async function archiveSegment(
  source: string,
  archive: string,
  compress: CompressFile = gzipFile,
  discard: (path: string) => unknown = removeFile,
): Promise<void> {
  // Captured before the compression, checked after it: segment names are reused
  // when a directory is recreated, so "the file at this path" after a second of
  // gzip is not necessarily the file that was read.
  const identity = fileIdentity(source);
  if (!identity) return;

  const partial = archive + PARTIAL_ARCHIVE_SUFFIX;
  try {
    await compress(source, partial);

    // The segment must be the same segment, and the same length, before the archive
    // is allowed to exist. A reader prefers an archive over the plain file of the
    // same name — otherwise a scan between the rename and the unlink counts every
    // entry twice — so an archive of a *prefix* hides every line appended while gzip
    // ran. Those lines would be in the file, complete, and invisible to `get()`,
    // `query()` and `count()`: the one failure mode this store exists to be
    // incapable of. Publish nothing and leave the plain segment as the single name
    // a reader can see.
    if (!isWholeSegment(fileIdentity(source), identity)) {
      discard(partial);
      return;
    }

    renameSync(partial, archive);
    unlinkIfUnchanged(source, identity);
  } catch (error) {
    // A partial that cannot be removed must not replace the failure that is worth
    // reporting: the compression is what went wrong, the cleanup is bookkeeping. The
    // discard is injectable so this arm — a cleanup that itself fails, which a runner
    // that deletes as root cannot produce — is asserted instead of assumed.
    try {
      discard(partial);
    } catch {
      /* the original failure is the one that explains this call */
    }
    throw error;
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

/**
 * Remove half-written archives left behind by a process that died mid-compression,
 * returning how many went.
 *
 * A `.part` is not a segment, so nothing reads it — which is exactly why it needs
 * removing: it would otherwise sit in the directory forever, holding the bytes of a
 * compression nobody will finish. A store that finds one when it opens the directory
 * knows no compressor of its own wrote it, so the only live owner it could have is
 * another process sharing the directory. Deleting a live compressor's partial makes
 * its `rename` fail, which its own `catch` turns into "keep the plain segment" — a
 * wasted compression, not a lost entry.
 *
 * A function of the directory rather than a method, so that the two answers worth
 * asserting are assertable: a directory that cannot be listed has nothing to sweep,
 * and a name that is not this store's is not its garbage.
 */
export function sweepAbandonedArchives(directory: string, prefix: string): number {
  // `?? []`: a directory that is gone holds nothing to remove.
  const names = listDirectory(directory) ?? [];
  const owned = `${prefix}-`;
  const partialName = `.ndjson.gz${PARTIAL_ARCHIVE_SUFFIX}`;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(owned)) continue;
    if (!name.endsWith(partialName)) continue;
    // A partial that cannot be removed is still invisible to every reader, which is
    // why a refusal here is not reported as a failure.
    if (removeFile(join(directory, name))) removed++;
  }
  return removed;
}

// ══════════════════════════════════════════════════════════════════
//  FileAuditStore
// ══════════════════════════════════════════════════════════════════

/**
 * One append waiting to be acknowledged.
 *
 * It remembers *where* it went and *which* segment generation it belongs to,
 * because between the append and the flush the store may have rotated: the sync
 * that acknowledges a line has to be a sync of the file that line is in, and not
 * of whatever file happens to be active when the flush runs.
 */
interface PendingCommit {
  readonly path: string;
  readonly generation: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

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

  /** How a segment name is taken. See `FileAuditStoreConfig.claim`. */
  private readonly claim: (path: string) => void;

  /**
   * The segment being appended to, or `''` when this store has not named one yet.
   *
   * Empty is a state, not a missing value: `rotate()` closes a segment and leaves
   * the store without a name, and the next line claims one. Naming a segment before
   * it is needed is how an idle store ends up leaving an empty file in a directory
   * it never wrote to, and it separates the decision "which number is free" from the
   * moment "that number is mine" can be made atomically.
   */
  private activeFilePath: string;

  /**
   * Whether the active segment's name is this store's.
   *
   * A segment adopted at construction is already somebody's: it exists, so claiming
   * it is neither possible nor necessary, and continuing it is the whole point of
   * adopting it. Every other segment is created here, exclusively, before its first
   * line — see `claimSegment`.
   *
   * No initializer, because the constructor computes it from the directory and an
   * initial value would be a second place to state a fact that is decided once.
   */
  private activeSegmentClaimed: boolean;

  /** Current file stats (track size). */
  private currentSize = 0;
  private currentCreatedAt: number;

  /**
   * The segment was created by this run and its name is not yet on the medium.
   *
   * A file's existence is a directory entry, and syncing the file does not sync
   * the name that leads to it. The first line of a segment therefore pays for one
   * `syncDirectory`, and no later line does.
   *
   * Expressed as two numbers — how many segments this store has opened, and the
   * highest one whose name is on the medium — rather than as a boolean, because a
   * boolean has to be cleared by whoever synced last, and with group commit nobody
   * knows who that is until the batch is flushed. Monotone, so a batch that spans
   * a rotation still costs one directory sync, and a failed one leaves the number
   * where it was and is paid again.
   */
  private segmentGeneration = 0;
  private durableDirectoryGeneration = -1;

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

  /**
   * Appends waiting for the sync that makes them durable.
   *
   * This is the group-commit queue: `write()` appends immediately and hands its
   * acknowledgement here, and one flush serves every append made before it. The
   * entries are queued rather than synced in place because the sync is the
   * expensive step (one round trip to the medium per call, tens of microseconds on
   * a quiet disk, milliseconds under load) and it is the *same* step for all of
   * them — a file sync covers everything appended before it, which is the property
   * the batch relies on and the port promises.
   */
  private readonly pendingCommits: PendingCommit[] = [];

  /** Whether a flush is already scheduled for the end of this turn. */
  private flushScheduled = false;

  constructor(config: FileAuditStoreConfig) {
    this.dataDir = config.dataDir;
    this.maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.filePrefix = config.filePrefix ?? DEFAULT_FILE_PREFIX;
    this.maxScanLines = config.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
    this.segmentReader = config.segmentReader ?? readSegmentFromDisk;
    this.fileSystem = config.fileSystem ?? nodeDurableFileSystem;
    this.claim = config.claim ?? ((path: string) => closeSync(openSync(path, 'wx')));

    // Inverted until now: the directory was created only if it already existed, so
    // a store pointed at a fresh path failed on its first write with ENOENT.
    // A path that exists but is not a directory now fails here, at construction:
    // `resolveActiveFile` reads the directory without a fallback, because a store
    // that cannot list its own segments cannot safely choose one to append to.
    // Unconditional: `recursive: true` does nothing to a directory that exists, and
    // a path that is not a directory fails with ENOTDIR here — at construction,
    // where a store that cannot list its own segments should fail.
    mkdirSync(this.dataDir, { recursive: true });

    // Before the directory is read for a name to adopt: an abandoned partial is
    // not a name to avoid, and leaving it would grow the directory by one file per
    // crash for the life of the deployment.
    this.sweepAbandonedArchives();

    // Before a name is adopted, not after: the sweep can move the newest segment to a
    // name of its own, and adopting first would mean continuing a name whose archive
    // the sweep is about to look at.
    this.sweepShadowedSegments();

    this.activeFilePath = this.resolveActiveFile();
    this.activeSegmentClaimed = this.activeFilePath !== '';
    this.currentSize = this.activeSegmentClaimed ? statSync(this.activeFilePath).size : 0;
    this.currentCreatedAt = Date.now();

    // A store cannot know whether the process that created this segment synced its
    // name — it may have died between the data and the directory entry — so it pays
    // one directory sync per segment it opens. Asking `currentSize === 0` saved a
    // single `fsync` per process start and turned "the name is durable" into "the
    // name was probably durable", which is not the same claim.
    //
    // `durableDirectoryGeneration` stays at -1 — "no name is known to be on the
    // medium" — so the first flush pays for the segment this store adopted.

    // The other thing the previous run may have left behind: a segment that does
    // not end on a line boundary. Asked once, here — and only for a segment this
    // store adopted, because a segment it names itself is created empty.
    this.separatorOwed = this.activeSegmentClaimed && this.fileSystem.needsSeparator(this.activeFilePath);
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

    // A directory that cannot be listed holds no names to avoid.
    const files = listDirectory(this.dataDir) ?? [];

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

  /**
   * The newest open segment to continue, or `''` when this store has to name one.
   *
   * Adopting rather than always starting fresh is what makes a restart a
   * continuation instead of a gap: a process that is killed leaves a segment that
   * ends mid-trail, and the store that comes after it appends to that file. Creating
   * a name here instead would leave an empty segment behind every construction and
   * put a second file between two lines that belong together.
   */
  private resolveActiveFile(): string {
    const active = newestOpenSegment(readdirSync(this.dataDir), this.filePrefix);
    return active === '' ? '' : join(this.dataDir, active);
  }

  /**
   * Name and claim the segment the next line will go into.
   *
   * Once per segment: the claim is what makes a name this store's, so it happens
   * where a name is first needed and never earlier — a store that is constructed and
   * never written to leaves nothing behind.
   */
  private claimActiveSegment(): void {
    if (this.activeSegmentClaimed) return;
    this.activeFilePath = this.claimNewSegmentPath();
    this.activeSegmentClaimed = true;
    this.currentSize = 0;
    this.currentCreatedAt = Date.now();
    // The claim created the file, so it is empty: no separator can be owed. Its
    // name is not on the medium until the first flush syncs the directory.
    this.separatorOwed = false;
    this.segmentGeneration++;
  }

  /**
   * The first segment name this store can have, scanning again after a refusal.
   *
   * The rescan *is* the retry: `O_EXCL` failing means the name exists, and it exists
   * by the time the next scan runs, so the candidate after a refusal is the one after
   * it — no arithmetic of its own, and correct against any number of writers. The
   * bound is there because a loop that cannot terminate is not a retry policy: eight
   * refusals mean eight other writers named a segment in the same millisecond, which
   * is a deployment that needs its writers to stop sharing a directory.
   */
  private claimNewSegmentPath(): string {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const path = this.generateFilePath();
      if (claimSegment(path, this.claim)) return path;
    }
    throw new Error(
      `audit: could not claim a segment name in ${this.dataDir} after ${CLAIM_ATTEMPTS} attempts — ` +
        `${CLAIM_ATTEMPTS} segments were created by other writers in the same millisecond`,
    );
  }

  /** Check if rotation is needed. */
  private shouldRotate(): boolean {
    // Nothing to rotate away from: this store has not named a segment yet, and the
    // first line goes into a fresh one anyway.
    if (!this.activeSegmentClaimed) return false;
    if (this.currentSize >= this.maxFileSize) return true;
    if (Date.now() - this.currentCreatedAt >= this.maxAgeMs) return true;
    return false;
  }

  /** Rotate: close current file, compress old, and leave the next name to the claim. */
  private rotate(): void {
    const oldPath = this.activeFilePath;
    // The store is between segments. The next line claims a name, which is the one
    // moment the "is this number free?" question can be answered atomically; naming
    // it here would answer it at a moment that is already stale by the time the file
    // is created.
    //
    // Only the name is cleared. The size, the age and the owed separator describe a
    // *segment*, and the segment that follows does not exist yet: `claimActiveSegment`
    // is where all three are set, so resetting them here as well would be a second
    // opinion that always agrees — and one that a mutation run cannot distinguish
    // from the first, which is how one of these assignments survived a whole
    // iteration as a mutant.
    this.activeFilePath = '';
    this.activeSegmentClaimed = false;

    // What is being compressed, captured now rather than trusted later: segment
    // names are reused after a directory is recreated, so "the file at oldPath" at
    // completion time is not necessarily the file that was read. `archiveSegment`
    // captures it again at its own start, which is the hop below — close enough to
    // this one that nothing can reuse the name in between, and it is the file's
    // identity, not this line, that decides what may be unlinked.
    if (!fileIdentity(oldPath)) return;

    // Compress the rotated file in background (non-blocking), but tracked.
    const job = new Promise<void>((resolve) => {
      setImmediate(() => {
        // A failure here is not a failure of the store: the plain segment stays,
        // readable and uncompressed, and the next rotation tries again. What must
        // not happen is a rejection with no handler — the job's promise is resolved
        // by `finally`, so a throw here would surface as an unhandled rejection in
        // a process that is otherwise fine.
        archiveSegment(oldPath, oldPath + '.gz')
          .catch(() => {})
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
   * Remove half-written archives left behind by a process that died mid-compression.
   *
   * A `.part` is not a segment, so nothing reads it — which is exactly why it needs
   * removing: it would otherwise sit in the directory forever, holding the bytes of
   * a compression nobody will finish. A store that finds one at construction knows
   * no compressor of its own wrote it (its own start after this point), so the only
   * live owner it could have is another process sharing the directory. Deleting a
   * live compressor's partial makes its `rename` fail, which its own `catch` turns
   * into "keep the plain segment" — a wasted compression, not a lost entry.
   *
   * Delegated to `sweepAbandonedArchives`, which is a function of the directory so
   * that both answers — a directory that cannot be listed, and a name that is not
   * this store's — are assertions rather than branches nobody can reach.
   */
  private sweepAbandonedArchives(): void {
    sweepAbandonedArchives(this.dataDir, this.filePrefix);
  }

  /**
   * Repair every segment whose two views disagree, before a name is adopted.
   *
   * This is the half of the twin rule that a crash makes necessary. A store that dies
   * between appending a line and flushing it leaves that line in a plain segment whose
   * archive is already published: the next store skips the name (it is archived, so it
   * is not the open segment) and the line stays on the disk, invisible to every query,
   * for as long as the archive is there. Nothing in the write path can repair that,
   * because the writer that could have is gone — so the repair runs where a new store
   * looks at the directory, and it is the same rule the live path applies.
   *
   * Three of the four repairable verdicts delete a view that carries no unique bytes:
   * an archive that hides a superset goes, a plain file fully contained in its archive
   * goes. Only `disjoint` moves data, and it moves the *plain* file to a new name
   * rather than merging, because a merge would have to rewrite one of the two and a
   * rewrite is the operation that can be interrupted. What each verdict *does* is
   * `repairFor`'s table, asserted cell by cell in `AC 90`; this method only applies it.
   */
  private sweepShadowedSegments(): void {
    const names = listDirectory(this.dataDir);
    if (names === null) return;

    for (const name of shadowedPairs(names, this.filePrefix)) {
      const plainPath = join(this.dataDir, name);
      const archivePath = `${plainPath}.gz`;
      const repair = repairFor(relateTwin(readView(plainPath, false), readView(archivePath, true)), 'at-rest');

      if (repair === 'remove-archive') removeFile(archivePath);
      else if (repair === 'remove-plain') removeFile(plainPath);
      else if (repair === 'promote') this.promoteSegment(plainPath);
      // `none` is a verdict about a pair that a later store can still act on, or one it
      // must not act on. See `repairFor`.
    }
  }

  /**
   * Move a plain segment to a name of its own, returning the new path.
   *
   * The name is claimed exclusively first, so the destination cannot be another
   * writer's file; `rename` then replaces the empty name this store just took, which
   * is atomic within a directory. A crash between the two leaves an empty segment —
   * readable, contributes nothing, adopted or rotated away by the next store — rather
   * than a half-copied one.
   */
  private promoteSegment(from: string): string {
    const to = this.claimNewSegmentPath();
    renameSync(from, to);
    return to;
  }

  /**
   * Make sure the segment a line was just appended to is the one a reader reads.
   *
   * Runs after every append, before the acknowledgement, and costs one `stat` in the
   * ordinary case, where no archive of the active name exists. The expensive part —
   * reading both views — only happens when one does, and every repair moves the
   * question on: the archive is removed, or the file is renamed, or the line is
   * refused. There is no state in which the same pair has to be related twice, which
   * is why there is no memo of what was already looked at.
   *
   * A store that appended into a shadowed name and then died would leave the state the
   * construction sweep repairs. Repairing here instead is what makes the promise
   * narrower than "the next process will notice": an entry is acknowledged only after
   * its name is a name a reader reads.
   */
  private resolveShadowedSegment(): void {
    const archivePath = `${this.activeFilePath}.gz`;
    // Behaviourally redundant — `relateTwin` answers `no-twin` for an archive that is
    // not there — and kept for what it prevents: without it, every append would read
    // the whole active segment to compare it with an archive that does not exist.
    if (!isRegularFile(archivePath)) return;

    const repair = repairFor(relateTwin(readView(this.activeFilePath, false), readView(archivePath, true)), 'live');
    if (repair === 'remove-archive') {
      removeFile(archivePath);
      return;
    }
    if (repair === 'release') {
      // The line cannot be shown to be in a segment this store holds: the file it was
      // appended to is gone, and whether the archiving process captured those bytes
      // depends on when its identity check ran. Acknowledging would be a claim the
      // store cannot verify, and appending the line again would count an entry twice
      // if the archive did capture it — so the line is *not* acknowledged, and the
      // retry names a segment of this store's own.
      const abandoned = this.activeFilePath;
      this.releaseActiveFile();
      throw new Error(
        `audit: ${abandoned} was archived while this store was appending to it — ` +
          'the line was not acknowledged; retry it and it will land in a new segment',
      );
    }
    if (repair === 'promote') this.promoteActiveFile();
  }

  /** Stop appending to the current name; the next append claims one. */
  private releaseActiveFile(): void {
    this.activeFilePath = '';
    this.activeSegmentClaimed = false;
  }

  /** Keep appending to the same bytes under a name no archive shadows. */
  private promoteActiveFile(): void {
    const to = this.promoteSegment(this.activeFilePath);
    this.activeFilePath = to;
    this.activeSegmentClaimed = true;
    this.currentCreatedAt = Date.now();
    // `currentSize` is not re-read: a rename does not change a file's length, and every
    // byte in it was counted either when the segment was adopted (one `stat`) or when it
    // was appended. A count that drifted — a name another process truncated — makes the
    // rotation threshold fire early, which is a heuristic moving, not a line lost.
    //
    // A new name has to reach the medium before a line appended under it is
    // acknowledged, exactly like a claimed segment.
    this.segmentGeneration++;
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

    const files = listDirectory(this.dataDir);
    if (files === null) return;

    for (const f of files) {
      if (!segment.test(f)) continue;
      const path = join(this.dataDir, f);
      // A segment whose date cannot be read is not one to delete: reporting an
      // expiry that did not happen is worse than leaving the file for the next
      // sweep, which is what the next rotation is.
      if (!isExpired(mtimeOf(path), cutoff)) continue;
      // No skip for the live segment: this runs after rotation moved
      // `activeFilePath` to the segment that was just opened, so the file being
      // expired is by definition a closed one. The guard that used to be here could
      // never be true for an expired path, which is why no test could see it.
      removeFile(path);
    }
  }

  /**
   * Wait for a graceful stop: everything that was scheduled has finished.
   *
   * Call this before removing the data directory, or before asserting on its
   * contents — otherwise the assertion races a compressor. The flush here is not
   * politeness: an append whose acknowledgement is still queued would otherwise be
   * resolved by an `setImmediate` that the caller has stopped waiting for, and
   * `close()` is the promise that "what I acknowledged is what is on the medium".
   */
  async close(): Promise<void> {
    this.flush();
    while (this.pendingCompressions.size > 0) {
      await Promise.allSettled([...this.pendingCompressions]);
    }
  }

  /**
   * Append one line and hand back the acknowledgement the caller must wait for.
   *
   * The recipe is three steps and one order:
   *
   *   1. `append` — the bytes are in the file (probably still in the page cache).
   *   2. `syncFile` — the file's data is on the medium.
   *   3. `syncDirectory`, only for a segment created by this run — the *name* is
   *      on the medium. The name is a directory entry; step 2 does not touch it,
   *      so without step 3 a crash can leave the data written and unreachable.
   *
   * Step 1 happens here, synchronously, because it is cheap and because doing it
   * later would move the line's position away from the order the caller wrote it
   * in. Steps 2 and 3 happen in `flush()`, once per turn for all of them.
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
  private appendLine(line: string): Promise<void> {
    if (this.shouldRotate()) {
      this.rotate();
    }
    // Before the write, not after: a segment name is a shared resource, and the
    // only way to know it is this store's is to create it exclusively first. An
    // append to a name that another writer owns is the state in which entries end up
    // inside a file the reader has already archived.
    this.claimActiveSegment();

    const data = `${this.separatorOwed ? '\n' : ''}${line}\n`;

    // The append is the step that can leave the file longer than `currentSize`
    // says, so the accounting follows it rather than the whole recipe: a failed
    // sync reports failure, but the bytes are there and the rotation threshold
    // has to be measured against what is.
    this.fileSystem.append(this.activeFilePath, data);
    this.currentSize += Buffer.byteLength(data);
    this.separatorOwed = false;

    // After the bytes and before the acknowledgement, and that order is the point: a
    // name an archive shadows is not a name a reader reads, so a line may not be
    // acknowledged into one. Checking before the append instead would leave the window
    // in which the archive is published between the check and the write — this way the
    // line that lands in that window is the one that gets moved, not the one after it.
    this.resolveShadowedSegment();

    return this.commit(this.activeFilePath, this.segmentGeneration);
  }

  /**
   * Queue the acknowledgement for one appended line.
   *
   * A promise per line, resolved by whichever flush covers it, so that the caller
   * waits for *its* line and not for the turn. The previous revision synced inside
   * `write()`: correct, and the reason a caller had no way to overlap ten writes
   * with one `fsync` — each call paid a round trip to the medium while the process
   * waited, which measurement put at ~96 acknowledged entries per second per
   * writer on a disk with a 10 ms flush, a number that is a property of the disk
   * and not of the store.
   */
  private commit(path: string, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingCommits.push({ path, generation, resolve, reject });
      this.scheduleFlush();
    });
  }

  /**
   * Ask for a flush at the end of this turn, once.
   *
   * `setImmediate` and not a microtask: a microtask runs before the I/O callbacks
   * of the current turn, so it would batch only what one synchronous stack wrote.
   * The check phase is the last thing in a turn, which makes the batch "everything
   * written in this turn" — the widest window that still bounds how long an
   * acknowledgement can wait, and it waits one turn, not a timer interval.
   *
   * Once, because a second schedule for the same turn would find the queue already
   * drained and cost nothing but a second `fsync` of an unchanged file.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /**
   * Make every append made before this call durable, then acknowledge it.
   *
   * One file sync per segment in the batch, then at most one directory sync. This
   * is group commit and it is sound for one reason, which is the port's contract:
   * a file sync covers everything appended to that file before the call. Writes
   * that arrive while the batch is being formed are not covered by it — they are
   * in the queue for the next flush, because the batch was taken by `splice`, and
   * resolving a line the sync did not see is the single failure mode that turns
   * this optimisation into a data-loss bug.
   *
   * Failures are attributed as narrowly as the sequence allows, and never more
   * narrowly than it can prove. A line may be acknowledged only if its file was
   * synced *and* its name is on the medium: after a failure part way through a
   * batch, the lines in the segments before it are durable and are acknowledged,
   * while the rest are rejected — rejecting a durable line invites the caller to
   * write it twice, and an audit report that counts an entry twice is wrong in the
   * same way as one that lost it. A line whose file was synced but whose name was
   * never made durable stays rejected even though its bytes are on the disk: after
   * the power cut it is supposed to survive, the data is there and unreachable,
   * which is indistinguishable from absent.
   *
   * The bytes of a rejected line remain in the segment, because the append is what
   * the failure could not undo — truncating after a failed `fsync` is a second
   * write with its own failure mode, and the file may already hold another
   * process's bytes. So the trail is at-least-once across a failed sync, never
   * at-most-once, and a caller retries with a fresh id.
   */
  private flush(): void {
    if (this.pendingCommits.length === 0) return;
    const batch = this.pendingCommits.splice(0, this.pendingCommits.length);

    // How much of the batch the sequence covered before it failed.
    let covered = 0;
    try {
      // Consecutive comparison, not a set: rotation only ever moves forward, so a
      // path cannot recur after the batch has moved past it.
      let synced = '';
      for (let i = 0; i < batch.length; i++) {
        const commit = batch[i]!;
        if (commit.path !== synced) {
          this.fileSystem.syncFile(commit.path);
          synced = commit.path;
        }
        covered = i + 1;
      }

      // The name, after the data it leads to. One sync covers every segment opened
      // before it, so a batch that spans a rotation still pays once.
      let highest = -1;
      for (const commit of batch) highest = Math.max(highest, commit.generation);
      if (highest > this.durableDirectoryGeneration) {
        this.fileSystem.syncDirectory(this.dataDir);
        this.durableDirectoryGeneration = highest;
      }
    } catch (error) {
      for (let i = 0; i < batch.length; i++) {
        const commit = batch[i]!;
        if (i < covered && commit.generation <= this.durableDirectoryGeneration) commit.resolve();
        else commit.reject(error);
      }
      return;
    }

    for (const commit of batch) commit.resolve();
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

    await this.appendLine(JSON.stringify(entry));
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
    const files = listDirectory(this.dataDir);
    if (files === null) return 0;

    let removed = 0;
    for (const f of files) {
      if (!segment.test(f)) continue;
      const path = join(this.dataDir, f);
      if (path === this.activeFilePath) continue;
      const mtime = mtimeOf(path);
      if (mtime === null || mtime >= timestamp.getTime()) continue;
      if (removeFile(path)) removed++;
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

    const names = listDirectory(this.dataDir);
    if (names === null) return null;

    // Files, not names. `readableSegmentsNewestFirst` prefers an archive over the
    // plain segment of the same name, because between the rename and the unlink
    // both hold the same entries. A *directory* called `X.ndjson.gz` is neither: it
    // holds no entries, and letting it win the comparison hid the complete
    // `X.ndjson` next to it — the reader answered "no entries" for a segment it
    // could have read, because something unrelated shared its archive name.
    const listed = names.filter((f) => mine(f) && isRegularFile(join(this.dataDir, f)));
    return readableSegmentsNewestFirst(listed);
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
