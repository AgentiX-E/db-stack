import { createConfig } from '../eslint.shared.mjs';

/**
 * The e2e package is test infrastructure — the suites and the process harness that
 * spawns real nodes — but "infrastructure" is not an exemption from the gates: this
 * file exists because the harness had accumulated a defect (log lines written into
 * the child's own pipe instead of the runner's console) that a linter would not have
 * caught but a missing gate would have kept invisible.
 */
export default createConfig({ tsconfigRootDir: import.meta.dirname });
