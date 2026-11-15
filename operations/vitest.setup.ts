// Route scratch data to the fastest filesystem available (tmpfs when present).
import { beforeEach } from 'vitest';
import { useTestTmpRoot, ensureTestTmpRoot } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('operations');

// The temp root is process-wide, so one test that removes a path at or above it
// breaks `mkdtempSync` for every later test on the same worker — reported as an
// ENOENT in an unrelated file. Re-assert it before each test; a healthy root
// costs one `existsSync`.
beforeEach(() => {
  ensureTestTmpRoot();
});
