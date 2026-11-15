// Forward pino output to /dev/null during tests
import { beforeEach } from 'vitest';

process.env.LOG_LEVEL = 'silent';
process.env.VITEST = 'true';

// Materialize a `pg` package stub under node_modules so the production
// `require('pg')` (inside RaftGroupManager._execOnLeader auto-forward) resolves
// to a controllable fake in the test environment.
//
// `pg` IS declared as an optionalDependency, so it is physically installed.
// However, the production code loads it via a CommonJS dynamic `require('pg')`,
// which bypasses Vitest's ESM module graph — so `vi.mock('pg')` and
// `resolve.alias` cannot intercept it. The only reliable way to stub a dynamic
// require is to materialize a real module at the node_modules path.
//
// To keep unit tests deterministic (no real TCP/pg-protocol handshake), we
// ALWAYS overwrite the installed `pg` with this stub (idempotent per worker:
// setupFiles run once per fork). node_modules is gitignored, so this is
// non-invasive. The stub reads per-test behaviour from `globalThis.__pgActions`
// dynamically, so parallel test files never race on it.
import * as fs from 'fs';
import * as path from 'path';

// Route scratch data to the fastest filesystem available (tmpfs when present).
//
// The suites are fsync-bound (Raft log + SQLite WAL + LMDB), and a durable
// commit costs ~19ms on overlayfs versus ~0.03ms on tmpfs. Using tmpfs also
// removes the "/tmp is pruned mid-run" class of failures that showed up as
// SQLite "disk I/O error"; the helper falls back to a workspace-local `.tmp`
// when /dev/shm is unavailable.
import { useTestTmpRoot, ensureTestTmpRoot } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('cluster');

// The temp root is process-wide, so one test that removes a path at or above it
// breaks `mkdtempSync` for every later test on the same worker — reported as an
// ENOENT in an unrelated file. Re-assert it before each test; a healthy root
// costs one `existsSync`.
beforeEach(() => {
  ensureTestTmpRoot();
});

const pgStubDir = path.resolve(process.cwd(), 'node_modules/pg');
fs.mkdirSync(pgStubDir, { recursive: true });
fs.writeFileSync(
  path.join(pgStubDir, 'package.json'),
  JSON.stringify({ name: 'pg', version: '0.0.0-test-stub', main: 'index.js' }),
);
fs.writeFileSync(
  path.join(pgStubDir, 'index.js'),
  `
class Client {
  constructor(cfg) {
    this.cfg = cfg;
    const a = globalThis.__pgActions || {};
    if (a.onCreate) a.onCreate(cfg);
  }
  on(ev, fn) { const a = globalThis.__pgActions || {}; if (a.onEvent) a.onEvent(ev, fn); }
  connect() { const a = globalThis.__pgActions || {}; return a.onConnect ? a.onConnect(this.cfg) : Promise.resolve(); }
  query(sql) { const a = globalThis.__pgActions || {}; return a.onQuery ? a.onQuery(sql, this.cfg) : Promise.resolve({ rows: [] }); }
  end() { const a = globalThis.__pgActions || {}; return a.onEnd ? a.onEnd(this.cfg) : Promise.resolve(); }
}
module.exports = { Client };
`,
);
