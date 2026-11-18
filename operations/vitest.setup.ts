// Route scratch data to the fastest filesystem available (tmpfs when present).
import { beforeEach } from 'vitest';
import { useTestTmpRoot, ensureTestTmpRoot, resolveSharedTempDir } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('operations');

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
