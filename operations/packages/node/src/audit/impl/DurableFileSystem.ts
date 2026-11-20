/**
 * DurableFileSystem — the three filesystem steps that make one line survive.
 *
 * A durable write is a recipe, not a call: the bytes have to reach the file, the
 * file's data has to reach the medium, and — for a file that was just created —
 * the directory entry that names it has to reach the medium too. Any of the three
 * can fail, and two of them are invisible to every test that only reads the file
 * back afterwards, because the page cache answers the read either way.
 *
 * So the recipe is an interface. It is deliberately narrower than `node:fs`:
 * `append`, `syncFile`, `syncDirectory`. Narrow enough that a caller can supply a
 * recording implementation and assert **the order**, wide enough that an
 * implementation for a different medium (an object store with a write-then-commit
 * sequence, a journaled block device) is expressible without reimplementing the
 * store.
 *
 * The store holds no other filesystem dependency on its write path: there is no
 * temporary file, no `rename`, and no read-modify-write. Those existed to make a
 * whole file replacement atomic; an append-only trail does not need one, and
 * paying for it on every line meant rewriting the segment to add a line to it.
 *
 * @module @agentix-e/db-operations-node/audit/impl
 */

import { appendFileSync, closeSync, fstatSync, fsyncSync, openSync, readSync } from 'node:fs';

/**
 * What a durable append needs from the medium.
 *
 * Contract, not suggestion — the store relies on all three:
 *
 * 1. `append` places all of `data` at the end of `path`, creating the file when
 *    it is absent, or throws. It does not have to be durable when it returns.
 * 2. `syncFile` returns only once `path`'s data is on the medium, or throws. The
 *    data is *everything appended to `path` before the call* — not one line. That
 *    is what lets the store acknowledge a whole turn's appends with one call
 *    (`FileAuditStore` group commit), and an implementation that synced only the
 *    most recent append would make every batch except the last a false claim.
 * 3. `syncDirectory` returns only once the entries *naming* files in `path` are
 *    on the medium, or throws. It is called once per segment, after the segment's
 *    first line, because that is when a new name appears.
 *
 * An implementation that returns without doing the work is an implementation that
 * has moved the durability claim into its own documentation. That is the whole
 * reason this is an interface: the claim is only worth what the caller can assert.
 */
export interface DurableFileSystem {
  /** Append `data` to `path`, creating it if absent; throws on failure. */
  append(path: string, data: string): void;
  /** Return once `path`'s contents are on the medium; throws on failure. */
  syncFile(path: string): void;
  /** Return once the directory entries of `path` are on the medium; throws on failure. */
  syncDirectory(path: string): void;
  /**
   * Whether an append to `path` must begin with a newline, because the file ends
   * mid-line — the signature of a run that died between two writes.
   *
   * A reader skips an unparsable line, so a torn tail is survivable; an *append*
   * after one is not, because the next entry is then glued to the fragment and
   * lost along with it. One byte read per segment answers the question, and it is
   * asked once per segment rather than once per line.
   *
   * False when the file is absent, empty, or already ends with a newline.
   */
  needsSeparator(path: string): boolean;
}

/**
 * Whether an error means "this platform cannot sync a directory", as opposed to
 * "the sync failed".
 *
 * The distinction is the difference between a documented limitation and a
 * swallowed error. Opening a directory for reading fails on Windows (`EISDIR`,
 * `EPERM`), and a few filesystems refuse `fsync` on a directory fd (`EINVAL`,
 * `ENOTSUP`). Those are answers of the form "not here"; `EIO` and `ENOSPC` are
 * answers of the form "not now, and your data is at risk", and they must reach the
 * caller. A predicate rather than a `try`/`catch` in the default implementation so
 * the rule can be tested on a platform where the failure does not occur.
 */
export function isDirectorySyncUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP';
}

/**
 * The syscalls the default implementation uses.
 *
 * Named one by one rather than typed as `typeof fs`, because the point is that
 * this is the whole surface: if the recipe grows a step, it grows here, where the
 * decision to add it is visible.
 */
export interface NodeFileCalls {
  appendFileSync: typeof appendFileSync;
  openSync: typeof openSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  fstatSync: typeof fstatSync;
  readSync: typeof readSync;
}

/** The real syscalls, in one place so the implementation can be handed others. */
export const nodeFileCalls: NodeFileCalls = {
  appendFileSync,
  openSync,
  fsyncSync,
  closeSync,
  fstatSync,
  readSync,
};

/**
 * Build the default implementation over a set of syscalls.
 *
 * Two deliberate choices, both about being answerable rather than convenient:
 *
 * `syncFile` opens the file for reading *and writing* rather than reading only.
 * POSIX leaves `fsync` on a descriptor that is not open for writing
 * implementation-defined — Linux happens to flush, other systems may answer
 * `EBADF` — and "it works on the machine we tested" is not a durability
 * argument.
 *
 * `append` opens and closes per line rather than holding a descriptor. An
 * `O_APPEND` write is placed at the end of the file by the kernel, so two
 * processes appending to one trail do not overwrite each other's lines; a held
 * descriptor with a remembered offset would reintroduce exactly the lost update
 * this replaced. The cost is one `open`/`close` pair per line, against an `fsync`
 * that dominates it by orders of magnitude.
 *
 * The seam exists because of two branches that no Linux runner can reach: a
 * platform that refuses to open a directory for reading, and a filesystem that
 * refuses to sync one. Both are handled by `isDirectorySyncUnsupported`, and
 * "handled" is a claim about code that a test on this platform cannot reach — so
 * the syscalls are a parameter, and the cases that decide whether a limitation is
 * tolerated or an error is propagated are asserted by supplying the errno.
 *
 * Deployments do not need it: `nodeDurableFileSystem` is this function applied to
 * the real syscalls.
 */
export function createNodeDurableFileSystem(calls: NodeFileCalls = nodeFileCalls): DurableFileSystem {
  return {
    append(path: string, data: string): void {
      calls.appendFileSync(path, data, 'utf-8');
    },

    syncFile(path: string): void {
      const fd = calls.openSync(path, 'r+');
      try {
        calls.fsyncSync(fd);
      } finally {
        calls.closeSync(fd);
      }
    },

    syncDirectory(path: string): void {
      let fd: number;
      try {
        fd = calls.openSync(path, 'r');
      } catch (error) {
        // A platform that cannot open a directory has not failed to sync this
        // one. Anything else is a real answer about this directory.
        if (isDirectorySyncUnsupported(error)) return;
        throw error;
      }
      try {
        calls.fsyncSync(fd);
      } catch (error) {
        if (!isDirectorySyncUnsupported(error)) throw error;
      } finally {
        calls.closeSync(fd);
      }
    },

    needsSeparator(path: string): boolean {
      // A file that cannot be opened has no tail to continue, and an empty one has
      // no tail either. Both answer "no separator", which is what the store does
      // for a fresh segment.
      let fd: number;
      try {
        fd = calls.openSync(path, 'r');
      } catch {
        return false;
      }
      try {
        const { size } = calls.fstatSync(fd);
        if (size === 0) return false;
        const last = Buffer.alloc(1);
        const read = calls.readSync(fd, last, 0, 1, size - 1);
        // A read that returned nothing tells us as little as an empty file does,
        // and guessing "torn" would put a blank line at the head of every segment.
        return read === 1 && last[0] !== 0x0a;
      } finally {
        calls.closeSync(fd);
      }
    },
  };
}

/** The default implementation: POSIX `append` + `fsync`, over the real syscalls. */
export const nodeDurableFileSystem: DurableFileSystem = createNodeDurableFileSystem();
