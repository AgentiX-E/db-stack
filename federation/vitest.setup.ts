// Silence dependency log output during tests.
//
// db-federation aliases in sibling packages (@agentix-e/db-cluster and the
// db-operations chaosengine). Those packages emit Raft election / CDC / chaos
// pino logs at `info` level when their code is exercised under test, which
// floods stdout and slows down the run. Setting `LOG_LEVEL=silent` (read by
// the shared `LoggingAdapter`) and `VITEST=true` keeps unit-test output
// deterministic and readable, mirroring the db-cluster test setup.
process.env.LOG_LEVEL = 'silent';
process.env.VITEST = 'true';

// Route scratch data to the fastest filesystem available (tmpfs when present).
// Durable commits cost ~19ms on the workspace overlayfs versus ~0.03ms on
// tmpfs; the outbox/CDC suites are fsync-bound, so this is the difference
// between a seconds-long run and a multi-minute one.
import { beforeEach } from 'vitest';
import { useTestTmpRoot, ensureTestTmpRoot } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('federation');

// The temp root is process-wide, so one test that removes a path at or above it
// breaks `mkdtempSync` for every later test on the same worker — reported as an
// ENOENT in an unrelated file. Re-assert it before each test; a healthy root
// costs one `existsSync`.
beforeEach(() => {
  ensureTestTmpRoot();
});
