/**
 * Route every test temporary directory onto the fastest durable-capable
 * filesystem available in the sandbox.
 *
 * Why this matters
 * ----------------
 * These suites are fsync-bound: one Raft commit (or one LMDB outbox write)
 * issues several `fsync`s. Measured on the same machine:
 *
 *   tmpfs     (/dev/shm)       0.03 ms per durable commit
 *   overlayfs (workspace disk) 19    ms per durable commit
 *
 * That 600x gap turned a 1,000-proposal load test into a multi-minute timeout
 * and made WAL-based SQLite tests look like throughput regressions. Nothing
 * about the storage engines changes here — only where scratch data lives.
 *
 * Selection order:
 *   1. `$DBSTACK_TEST_TMPDIR` (explicit override)
 *   2. `/dev/shm/db-stack-tests/<id>` when writable with >= 512 MB free
 *   3. `<cwd>/.tmp` (workspace-local; survives /tmp pruning)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {string} label @returns {string} */
export function resolveTestTmpRoot(label) {
  const override = process.env.DBSTACK_TEST_TMPDIR;
  if (override && override.length > 0) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }

  const shm = '/dev/shm';
  if (fs.existsSync(shm)) {
    try {
      const stat = fs.statfsSync(shm);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes > 512 * 1024 * 1024) {
        const dir = path.join(shm, 'db-stack-tests', label);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch {
      // statfs unsupported — fall through to the workspace directory.
    }
  }

  const localTmp = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(localTmp, { recursive: true });
  return localTmp;
}

/** @param {string} label @returns {string} */
export function useTestTmpRoot(label) {
  const root = resolveTestTmpRoot(label);
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  // `os.tmpdir()` memoises its result on some platforms; reset the cache so
  // later callers see it.
  if (typeof os.tmpdir.resetCache === 'function') os.tmpdir.resetCache();
  return root;
}

/**
 * Re-create the test temp root if something removed it.
 *
 * `os.tmpdir()` is process-wide (one copy per worker thread), so every suite
 * that calls `mkdtempSync` depends on the *same* directory existing. Any single
 * test that deletes a path at or above that root — e.g. `rmSync(dirname(db))`
 * where the database was created directly inside the root — takes the root out
 * from under every later test on the same worker, which then fails with
 * `ENOENT: no such file or directory, mkdtemp '<root>/...'` in a file that has
 * nothing to do with the deleter.
 *
 * Callers re-assert the invariant per test (see the `beforeEach` hook in each
 * `vitest.setup.ts`) rather than once per worker process, because the deletion
 * happens mid-run. Re-creating an already-existing directory is a no-op, so the
 * steady-state cost is one `existsSync`.
 *
 * @returns {string} the temp root that is now guaranteed to exist.
 */
export function ensureTestTmpRoot() {
  const root = process.env.TMPDIR;
  if (!root || root.length === 0) {
    throw new Error('ensureTestTmpRoot: TMPDIR is unset — call useTestTmpRoot(label) first');
  }
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}
