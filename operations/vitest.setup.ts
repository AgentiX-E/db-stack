// Route scratch data to the fastest filesystem available (tmpfs when present).
import { useTestTmpRoot } from '../scripts/test-tmpdir.mjs';

useTestTmpRoot('operations');
