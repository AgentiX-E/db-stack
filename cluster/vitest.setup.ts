// Test bootstrap for @agentix-e/db-cluster.
//
// Nothing here may write outside the scratch directory. An earlier version
// materialised a fake `pg` package at `node_modules/pg` so that a CommonJS
// `require('pg')` inside the production source would resolve to a controllable
// stub. Two things were wrong with that, and both were the harness apologising
// for a product defect:
//
//   - The write raced. `setupFiles` runs once per worker thread, so up to four
//     threads truncated and rewrote the same two files; a worker that required
//     `pg` inside that window got an empty module and failed with
//     "TypeError: Client is not a constructor" — a CI-only failure that pointed
//     at the wrong file.
//   - It wrote *through* a pnpm symlink, replacing the real `pg` in the shared
//     content-addressed store for the whole workspace for the rest of the run.
//
// The seam now lives in the product (`consensus/core/pgClient`) and tests
// substitute it through the module graph, so this file has nothing to fake.

import { beforeEach } from 'vitest';

// Silence by default, but let a run opt back in with `LOG_LEVEL=debug npx vitest…`:
// the alternative is editing this file to diagnose one suite, which nobody does
// twice, and the Raft log is the only place some failures are visible at all.
process.env.LOG_LEVEL ??= 'silent';
process.env.VITEST = 'true';

// Route scratch data to the fastest filesystem available (tmpfs when present).
//
// The suites are fsync-bound (Raft log + SQLite WAL + LMDB), and a durable
// commit costs ~19ms on overlayfs versus ~0.03ms on tmpfs. Using tmpfs also
// removes the "/tmp is pruned mid-run" class of failures that showed up as
// SQLite "disk I/O error"; the helper falls back to a workspace-local `.tmp`
// when /dev/shm is unavailable.
import { useTestTmpRoot, ensureTestTmpRoot, resolveSharedTempDir } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('cluster');

// Ports are leased process-wide on purpose: two worker threads with separate
// pools would hand out the same port (see `PortLeases`).
process.env.DBSTACK_PORT_LEASE_DIR = resolveSharedTempDir('ports');

// The temp root is process-wide, so one test that removes a path at or above it
// breaks `mkdtempSync` for every later test on the same worker — reported as an
// ENOENT in an unrelated file. Re-assert it before each test; a healthy root
// costs one `existsSync`.
beforeEach(() => {
  ensureTestTmpRoot();
});

// What is *not* here, and why.
//
// Iteration 46 tried to close the other half of that hole — "a test that is
// already running loses its scratch space" — by wrapping `fs.rmSync` in this
// file and refusing a deletion at or above the root. It was removed after the
// interception was measured: under vite-node, `import fs from 'node:fs'` (what
// this file uses) and `import * as fs from 'node:fs'` (what almost every other
// file uses) are **different objects**, and patching the first leaves the second
// untouched.
//
//   fsDefault.rmSync === fsNs.rmSync   → false
//   __tmpRootGuarded (default)         → true
//   __tmpRootGuarded (namespace)       → undefined
//
// So the guard reported "installed", logged nothing, and could not have stopped
// the deletion it was written for: a guard that answers a question it does not
// act on, which is the failure mode this repository keeps writing down (D18).
// The instability is registered as P3-31 with the evidence instead of papered
// over with machinery that cannot fire.
