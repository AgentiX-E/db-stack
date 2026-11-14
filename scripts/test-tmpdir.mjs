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
  // `os.tmpdir()` memoises its result; reset the cache so later callers see it.
  if (typeof os.tmpdir.resetCache === 'function') os.tmpdir.resetCache();
  return root;
}
