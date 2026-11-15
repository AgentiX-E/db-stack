/**
 * scripts/test-tmpdir — the scratch-root helper every vitest setup depends on.
 *
 * Why this file exists
 * --------------------
 * `TMPDIR` is process-wide, and roughly seventy call sites across the three
 * packages create directories with `mkdtempSync(join(os.tmpdir(), …))`. That
 * makes the root a shared, mutable invariant: if any single test removes a path
 * at or above it, every later test on the same worker thread fails inside
 * `mkdtempSync` with `ENOENT` — in a file with no connection to the deleter.
 * The failure is timing-dependent, so it surfaces as a one-in-two-thousand red
 * run rather than as a reproducer.
 *
 * `ensureTestTmpRoot()` closes that hole by re-asserting the invariant, and the
 * setups call it before every test. These cases pin both halves of the
 * contract: the helper recreates a removed root, and it refuses to run when it
 * has not been told where the root is (silently falling back to `/tmp` would
 * put fsync-bound suites back on the slow filesystem without saying so).
 *
 * Acceptance criteria:
 *   AC 33.1  resolveTestTmpRoot honours DBSTACK_TEST_TMPDIR and creates it
 *   AC 33.2  useTestTmpRoot points TMPDIR/TMP/TEMP at the root it returns
 *   AC 33.3  ensureTestTmpRoot recreates a root that was deleted mid-run
 *   AC 33.4  ensureTestTmpRoot is a no-op for an existing root
 *   AC 33.5  ensureTestTmpRoot rejects an unset or empty TMPDIR
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTestTmpRoot, useTestTmpRoot, ensureTestTmpRoot } from '../../../../scripts/test-tmpdir.mjs';

const ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP', 'DBSTACK_TEST_TMPDIR'] as const;

describe('test-tmpdir', () => {
  const saved: Record<string, string | undefined> = {};
  let overrideRoot = '';

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // An override that lives *inside* the suite's own root: the cases below
    // delete it on purpose, and must never delete the root the rest of the run
    // is using.
    overrideRoot = path.join(saved.TMPDIR ?? os.tmpdir(), `tmpdir-helper-${process.pid}-${Date.now()}`);
    process.env.DBSTACK_TEST_TMPDIR = overrideRoot;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(overrideRoot, { recursive: true, force: true });
  });

  it('honours the explicit override and creates it', () => {
    // AC 33.1
    const root = resolveTestTmpRoot('unit');

    expect(root).toBe(process.env.DBSTACK_TEST_TMPDIR);
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it('points every temporary-directory variable at the root it returns', () => {
    // AC 33.2
    const root = useTestTmpRoot('unit');

    expect(root).toBe(process.env.DBSTACK_TEST_TMPDIR);
    expect(process.env.TMPDIR).toBe(root);
    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
    expect(os.tmpdir()).toBe(root);
  });

  it('recreates a root that a test deleted', () => {
    // AC 33.3
    const root = useTestTmpRoot('unit');
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(root)).toBe(false);

    expect(ensureTestTmpRoot()).toBe(root);
    expect(fs.statSync(root).isDirectory()).toBe(true);
    // The point of the recreation: callers can mkdtemp again.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'after-delete-'));
    expect(fs.statSync(scratch).isDirectory()).toBe(true);
  });

  it('leaves an existing root alone', () => {
    // AC 33.4
    const root = useTestTmpRoot('unit');
    fs.writeFileSync(path.join(root, 'sentinel'), 'keep');

    expect(ensureTestTmpRoot()).toBe(root);
    expect(fs.readFileSync(path.join(root, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('refuses to guess a root when TMPDIR is unset', () => {
    // AC 33.5
    delete process.env.TMPDIR;
    expect(() => ensureTestTmpRoot()).toThrow(/TMPDIR is unset/);

    process.env.TMPDIR = '';
    expect(() => ensureTestTmpRoot()).toThrow(/TMPDIR is unset/);
  });
});
