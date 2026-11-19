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
 *
 * Each step takes its filesystem, environment and working directory as an
 * argument with the real one as the default. The interesting branches — a
 * `/dev/shm` that is full, a `statfs` that is unsupported, an override that is
 * set but empty — are the ones a machine never reaches on a good day, and they
 * are exactly the branches that decide where a ninety-second test writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The least free space `/dev/shm` must have before it is preferred. */
export const MIN_SHM_BYTES = 512 * 1024 * 1024;

/**
 * Which worker thread this process-level root belongs to.
 *
 * `TMPDIR` is process-wide, so every worker thread in one vitest process shares
 * one root — and a directory that one test removes damages whichever test is
 * running elsewhere. Isolating the root per worker removes that class instead of
 * documenting it: a scratch directory now belongs to one thread, and a deletion
 * cannot reach another's.
 *
 * The port-lease directory is the exception and is deliberately *not* per worker
 * (`resolveSharedTempDir`): two threads that leased from separate pools would
 * hand out the same port.
 */
export function workerSuffix(env = process.env) {
  const id = env.VITEST_WORKER_ID ?? env.VITEST_POOL_ID;
  return id === undefined || id === "" ? "-w0" : `-w${id}`;
}

/** @param {string} label */
export function resolveTestTmpRoot(label, deps = {}) {
  const fsx = deps.fs ?? fs;
  const env = deps.env ?? process.env;
  const shm = deps.shm ?? "/dev/shm";
  const cwd = deps.cwd ?? process.cwd();
  const suffix = workerSuffix(env);

  const override = env.DBSTACK_TEST_TMPDIR;
  if (override && override.length > 0) {
    fsx.mkdirSync(override, { recursive: true });
    return override;
  }

  if (fsx.existsSync(shm)) {
    try {
      const stat = fsx.statfsSync(shm);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes > MIN_SHM_BYTES) {
        const dir = path.join(shm, "db-stack-tests", `${label}${suffix}`);
        fsx.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch {
      // statfs unsupported — fall through to the workspace directory.
    }
  }

  const localTmp = path.join(cwd, ".tmp", `${label}${suffix}`);
  fsx.mkdirSync(localTmp, { recursive: true });
  return localTmp;
}

/**
 * A directory shared by every worker of this process, for coordination.
 *
 * Ports are the only thing that needs one: a port leased in one thread must be
 * visible to the others, or the same port is handed out twice.
 *
 * @param {string} kind
 */
export function resolveSharedTempDir(kind, deps = {}) {
  const fsx = deps.fs ?? fs;
  const shm = deps.shm ?? "/dev/shm";
  const cwd = deps.cwd ?? process.cwd();

  if (fsx.existsSync(shm)) {
    const dir = path.join(shm, "db-stack-tests", kind);
    fsx.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(cwd, ".tmp", kind);
  fsx.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} label */
export function useTestTmpRoot(label, deps = {}) {
  const env = deps.env ?? process.env;
  const root = resolveTestTmpRoot(label, deps);
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;
  // `os.tmpdir()` memoises its result on some platforms; reset the cache so
  // later callers see it.
  if (typeof os.tmpdir.resetCache === "function") os.tmpdir.resetCache();
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
export function ensureTestTmpRoot(deps = {}) {
  const fsx = deps.fs ?? fs;
  const env = deps.env ?? process.env;
  const root = env.TMPDIR;
  if (!root || root.length === 0) {
    throw new Error(
      "ensureTestTmpRoot: TMPDIR is unset — call useTestTmpRoot(label) first",
    );
  }
  if (!fsx.existsSync(root)) fsx.mkdirSync(root, { recursive: true });
  return root;
}
