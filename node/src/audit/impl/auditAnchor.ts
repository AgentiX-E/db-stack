/**
 * The anchor — what a directory has given up, written where a verification reads it.
 *
 * A hash chain is a statement about the entries that are *present*. Delete the
 * beginning of the trail and every remaining link still holds: the successor names
 * a `prev` this reader has never seen, and `verifyTrail` forgives that, because a
 * trail whose oldest segments were pruned looks exactly the same. That forgiveness
 * is not a bug — retention prunes, and a pruned trail has to verify — but it means
 * the first entries are the one deletion the digest cannot report.
 *
 * The anchor is the fact that closes it: before a store unlinks a segment, it
 * records the last link of each writer's prefix in that segment, and the record is
 * what `verifyTrail` compares the first surviving entry against. An entry that
 * resumes above the recorded floor is a gap nobody recorded; one that resumes at
 * the floor has to name the digest the floor recorded.
 *
 * Four decisions, each of them the answer to a question a reader will ask:
 *
 *   - **One file per directory, not per writer.** The thing that gave entries up is
 *     the directory; a file per writer would need the directory's own record to be
 *     assembled from parts that can disagree. `${prefix}.anchor` is named so that
 *     no reader mistakes it for a segment: it does not match `segmentPattern`, and
 *     it is not a `.json` export, so `query()`, `count()` and `verify()`'s entry
 *     scan all ignore it.
 *   - **A floor per writer, not a log of deletions.** Retention prunes by age,
 *     which means the same segment is looked at again by the next sweep; a log
 *     would grow a line per attempt. A floor is idempotent, monotone, and it is
 *     all a verification needs: "everything up to `seq` for this writer is gone".
 *   - **Written before the unlink, replaced atomically.** A record written after
 *     the deletion leaves a window in which the entries are gone and nothing says
 *     why; a record written in place leaves a torn one. So the new text goes to
 *     `${prefix}.anchor.part`, is synced, and is renamed into position.
 *   - **Unkeyed, like the chain it anchors.** An attacker who can write the
 *     directory can write the anchor too, and this file does not pretend otherwise.
 *     What it does is make deletion *accountable*: a prune the store performed is a
 *     fact a later verification reads, and a hand-deletion after one is a break.
 *     A trail that must resist its own administrator needs an external witness —
 *     the daily digest, a WORM bucket, a remote log — and the user guide says so.
 *
 * @module @agentix-e/db-node/audit/impl
 */

import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { chainHeads } from './auditChain.js';
import type { ChainHead } from './auditChain.js';
import { isDirectorySyncUnsupported } from './DurableFileSystem.js';

/** The shape this module writes and the only one it reads. */
export const ANCHOR_VERSION = 1;

/**
 * The suffix a new anchor is written under before it is published.
 *
 * A name with it is not an anchor: nothing reads it, so a crash mid-write leaves a
 * file that the next prune overwrites rather than one that two readers disagree
 * about.
 */
export const PARTIAL_ANCHOR_SUFFIX = '.part';

/** The anchor's name for a store whose segments are called `${prefix}-…`. */
export function anchorFileName(prefix: string): string {
  return `${prefix}.anchor`;
}

/** The anchor's path in `dataDir`. */
export function anchorPath(dataDir: string, prefix: string): string {
  return join(dataDir, anchorFileName(prefix));
}

/**
 * Merge `heads` into `into`, keeping the highest sequence per writer.
 *
 * `true` when the map changed, which is what lets a prune skip the write: a sweep
 * that finds nothing newer than what is already recorded has nothing to say, and an
 * anchor rewritten on every rotation is a file whose mtime is a log of the store
 * rather than of what it gave up.
 *
 * Per writer and not global: two writers advance independently, and the floor of
 * one says nothing about the other's.
 */
export function absorbPrefixes(into: Map<string, ChainHead>, heads: Iterable<ChainHead>): boolean {
  let changed = false;
  for (const head of heads) {
    const recorded = into.get(head.writer);
    if (recorded !== undefined && recorded.seq >= head.seq) continue;
    into.set(head.writer, { writer: head.writer, seq: head.seq, hash: head.hash });
    changed = true;
  }
  return changed;
}

/**
 * The anchor's text for a set of floors.
 *
 * Sorted by writer so the file is a function of what it holds: two directories with
 * the same floors produce the same bytes, which is what makes a diff of two anchors
 * mean something. An array rather than an object, because a writer id is caller
 * input and an object would make `__proto__` a key with a behaviour.
 */
export function renderAnchor(pruned: ReadonlyMap<string, ChainHead>, generatedAt: string): string {
  return `${JSON.stringify({ version: ANCHOR_VERSION, generatedAt, pruned: chainHeads(pruned) }, null, 2)}\n`;
}

/** A hash as this package writes one: SHA-256, lowercase hex. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Whether `value` is a chain position: a whole number from 1.
 *
 * A predicate rather than a test inside the parser for one reason: `Number.isInteger`
 * takes an `unknown` and returns a boolean, so a parser that used it directly would also
 * need a `typeof` in front of it to narrow — and that `typeof` could never be the reason a
 * row was refused, because every value it rejects `Number.isInteger` rejects too. A branch
 * that cannot change the answer is a branch no case can cover, and this package does not
 * keep those.
 */
export function isPosition(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

/** Whether `value` is a digest as this package writes one. */
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

/**
 * Read an anchor, or throw with the reason it is not one.
 *
 * Strict on purpose. A reader that skipped a malformed row would verify a trail
 * against a floor it only partly knows, and the row it skipped is exactly the one
 * that would have named the missing entries. Throwing lets the store answer
 * `anchorUnreadable`, which is the honest report: the file that could say what was
 * pruned is the file that is damaged.
 *
 * `seq` starts at 1 — a floor of 0 says "nothing has been given up", which is what
 * the absence of a row says — so a row claiming 0 is refused rather than stored as
 * a floor that silently anchors nothing.
 */
export function parseAnchor(text: string): Map<string, ChainHead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // `String(error)`, not a conditional on `instanceof Error`: `JSON.parse` throws a
    // `SyntaxError` and nothing else, so the other arm of that conditional is a branch
    // no case can reach — and an unreachable branch in error handling is where a reader
    // assumes a case exists.
    throw new Error(`the anchor is not JSON: ${String(error)}`);
  }
  const record = parsed as { version?: unknown; pruned?: unknown };
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('the anchor is not an object');
  }
  if (record.version !== ANCHOR_VERSION) {
    throw new Error(`the anchor is version ${JSON.stringify(record.version)}, this reader writes ${ANCHOR_VERSION}`);
  }
  if (!Array.isArray(record.pruned)) throw new Error('the anchor has no `pruned` array');

  const floors = new Map<string, ChainHead>();
  for (const row of record.pruned as unknown[]) {
    const entry = row as { writer?: unknown; seq?: unknown; hash?: unknown };
    if (typeof entry !== 'object' || entry === null) throw new Error('a pruned row is not an object');
    if (typeof entry.writer !== 'string' || entry.writer === '') {
      throw new Error(`a pruned row has no writer (${JSON.stringify(entry.writer)})`);
    }
    if (!isPosition(entry.seq)) {
      throw new Error(`pruned writer ${entry.writer} has seq ${JSON.stringify(entry.seq)}, which is not a position`);
    }
    if (!isDigest(entry.hash)) {
      throw new Error(`pruned writer ${entry.writer} has no digest (${JSON.stringify(entry.hash)})`);
    }
    // The last row wins, and it is the higher one: `absorbPrefixes` only ever writes
    // the maximum, so a file with two rows for one writer was written by hand or by
    // two processes. Taking the max keeps the floor monotone under either.
    const existing = floors.get(entry.writer);
    if (existing === undefined || entry.seq > existing.seq) {
      floors.set(entry.writer, { writer: entry.writer, seq: entry.seq, hash: entry.hash });
    }
  }
  return floors;
}

/**
 * The five syscalls publishing an anchor needs.
 *
 * Injectable for the reason every other filesystem port in this package is: three of
 * the arms below — a rename that fails, a directory that cannot be opened, a directory
 * sync the platform refuses — cannot be produced on a runner that runs as root, and an
 * arm nobody can produce is an arm nobody can verify. The interface is deliberately
 * five calls wide, so that "what publishing means" is readable in one place.
 */
export interface AnchorCalls {
  /** Open `path` with `flags`, returning a descriptor. */
  open(path: string, flags: string): number;
  /** Write `text` to `descriptor`. */
  write(descriptor: number, text: string): void;
  /** Return once `descriptor`'s bytes are on the medium. */
  sync(descriptor: number): void;
  /** Close `descriptor`. */
  close(descriptor: number): void;
  /** Rename `from` to `to`, atomically within a directory. */
  rename(from: string, to: string): void;
}

/** The real syscalls, in one place so `publishAnchor` can be handed others. */
export const nodeAnchorCalls: AnchorCalls = {
  open: (path, flags) => openSync(path, flags),
  write: (descriptor, text) => {
    writeSync(descriptor, text);
  },
  sync: (descriptor) => {
    fsyncSync(descriptor);
  },
  close: (descriptor) => {
    closeSync(descriptor);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

/**
 * Publish `text` at `path` so that a reader sees the old anchor or the new one.
 *
 * Three syscalls, and the middle one is the reason this is not `writeFileSync`: a
 * rename is atomic within a directory, but the *contents* reach the medium only
 * when the file is synced, and a rename of an unsynced file can be durable while the
 * bytes are not. The directory sync afterwards is what makes the new name durable —
 * `rename` is cheap precisely because it does not have to be.
 *
 * A platform that cannot sync a directory is tolerated, by the same predicate the
 * write path uses (`isDirectorySyncUnsupported`), because the alternative is a
 * Windows deployment that cannot prune at all. A directory sync that fails for any
 * other reason is thrown: the caller then keeps the segment, which is the safe
 * order — better an old entry than an unrecorded hole.
 */
export function publishAnchor(path: string, text: string, calls: AnchorCalls = nodeAnchorCalls): void {
  const partial = path + PARTIAL_ANCHOR_SUFFIX;
  const descriptor = calls.open(partial, 'w');
  try {
    calls.write(descriptor, text);
    calls.sync(descriptor);
  } finally {
    calls.close(descriptor);
  }
  calls.rename(partial, path);

  // The directory entry, not the file: a rename that has not reached the medium is a
  // rename the next process does not see, and a missing anchor turns a recorded
  // prune into an unaccounted head.
  let directory: number;
  try {
    directory = calls.open(dirname(path), 'r');
  } catch (error) {
    if (isDirectorySyncUnsupported(error)) return;
    throw error;
  }
  try {
    calls.sync(directory);
  } catch (error) {
    if (!isDirectorySyncUnsupported(error)) throw error;
  } finally {
    calls.close(directory);
  }
}
