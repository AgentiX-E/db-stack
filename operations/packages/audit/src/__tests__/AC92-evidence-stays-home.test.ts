/**
 * AC 92 — evidence stays where the caller put it, and a name is never derived
 * from a value that is not there.
 *
 * The finding this file answers was a file in the working tree: `operations/undefined.tmp`,
 * 182 bytes, one `LOGIN` entry with an `admin` actor, mtime 2026-11-16T16:00:14Z.
 * `.gitignore`'s `*.tmp` rule hid it for eight days. Two things are wrong with a
 * file like that, and only one of them is cosmetic:
 *
 *   1. a name containing `undefined` is a path built from a value that was not
 *      there — the caller asked for evidence, and got a filename that is a type
 *      error written to disk;
 *   2. it is in the process's working directory, not the directory any store was
 *      pointed at, so the audit trail of a deployment can accumulate in whatever
 *      directory a service happens to be started from.
 *
 * Who wrote it
 * ------------
 * The write path before `19f0f4f` was "write to `.tmp`, fsync, rename", with
 * `const tmpPath = this.activeFilePath + '.tmp'`. That field was assigned in the
 * constructor, so the value could only be missing for a `writeLine` invoked on
 * something that was never constructed — a partial double, or a call path in a
 * version since replaced. Since `19f0f4f` the write path appends and syncs and
 * never opens a temporary file (`DW.9`), and an unclaimed segment is `''`, whose
 * `.tmp` is `.tmp`, not `undefined.tmp`. The writer is gone; measuring that took
 * one run of the two suites that write audit entries (839 cases) and then the whole
 * operations package (3 155 cases, 147 files) with the tree watched for `*.tmp`.
 * The answer was no such file, before and after.
 *
 * What the writer left behind, though, was a class
 * -----------------------------------------------
 * A path that is not *pinned* is a path that can move. `dataDir` was stored as
 * given, so a relative directory was re-interpreted against `process.cwd()` at
 * every use — and `cwd` belongs to the process, not to the store. Measured before
 * the fix: construct with `logs`, `chdir` away, write — `ENOENT`, evidence lost,
 * and the caller holding a rejection it can do nothing with. The directory is now
 * resolved once, at construction.
 *
 * Why two of these cases run in a child process
 * ---------------------------------------------
 * `process.chdir()` throws in a worker thread, and the suite runs in workers, so a
 * test that changed the working directory of the runner would be a test nobody
 * could run. It also would not be the claim: "a store's evidence cannot move with
 * the process" is a property of a *process*, so it is measured in one — a real
 * `node` child, given the directory to start in, reporting what it found.
 *
 * What each case is for:
 *
 *   XP.1  every path the write port is handed is absolute and inside the configured
 *         directory, and no component of it is a missing value
 *   XP.2  a relative `dataDir` is pinned at construction, so a later `chdir` cannot
 *         move the evidence (this is the reproduction, not a hypothetical)
 *   XP.3  a store run in an empty working directory leaves it empty
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { FileAuditStore } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';

/** The audit package root: the directory a child process is started in. */
const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');

/** A write port that records every path it is asked about and does the real work. */
class RecordingFileSystem implements DurableFileSystem {
  readonly paths: string[] = [];

  append(path: string, data: string): void {
    this.paths.push(path);
    nodeDurableFileSystem.append(path, data);
  }

  syncFile(path: string): void {
    this.paths.push(path);
    nodeDurableFileSystem.syncFile(path);
  }

  syncDirectory(path: string): void {
    this.paths.push(path);
    nodeDurableFileSystem.syncDirectory(path);
  }

  needsSeparator(path: string): boolean {
    this.paths.push(path);
    return nodeDurableFileSystem.needsSeparator(path);
  }
}

function entry(operation: string) {
  return { operation, actor: 'auditor', resource: '/db/orders', result: 'success' as const };
}

/**
 * Run a snippet in a real process, importing the store from source through `tsx`.
 *
 * `cwd` is the whole point of the parameter: this is how the cases below ask "what
 * does a store do when the process it lives in starts *here*".
 */
function inChild(script: string, cwd: string): string {
  // `--import tsx` is resolved from the *child's* working directory, which these
  // cases deliberately set to a directory that has no `node_modules` — so the
  // loader is named by absolute URL, resolved here where the package graph lives.
  // `createRequire` rather than `import.meta.resolve`: the test runner's module
  // transform does not carry the latter.
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return execFileSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  }).trim();
}

const STORE_IMPORT = `import { FileAuditStore } from ${JSON.stringify(join(PACKAGE_DIR, 'src/impl/FileAuditStore.ts'))};`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac92-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AC 92 — a path the store writes is pinned and whole', () => {
  it('XP.1 — every path handed to the write port is absolute, inside the directory, and names no missing value', async () => {
    const dataDir = join(root, 'segments');
    const recorder = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: recorder });

    await store.write(entry('INSERT'));
    await store.write(entry('UPDATE'));
    await store.close();

    expect(recorder.paths.length).toBeGreaterThan(0);
    for (const path of recorder.paths) {
      // Absolute, because a relative path is a name whose meaning somebody else owns.
      expect(path.startsWith(sep)).toBe(true);
      // Inside the directory the caller named — the directory itself, or a file in it.
      expect(path === dataDir || path.startsWith(`${dataDir}${sep}`)).toBe(true);
      // The defect, as an assertion: `undefined`, `null` and `NaN` are what a
      // template literal writes when a value that should have been there was not.
      expect(path).not.toMatch(/(^|[/\\])(undefined|null|NaN)([./\\]|$)/);
    }

    // Both entries landed in the same segment, and it is the one the port was told
    // to write — not a temporary file beside it. The port is asked about the same
    // path several times (is a separator owed, append, sync), so the claim is about
    // the set of names, not the number of calls.
    expect([...new Set(recorder.paths.filter((path) => path.endsWith('.ndjson')))]).toHaveLength(1);
    expect(recorder.paths.some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('XP.2 — a relative dataDir is pinned at construction, so a later chdir cannot move the evidence', () => {
    const named = join(root, 'named');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(named, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });

    // The caller names a directory the way a configuration file would — relative to
    // where the process starts — and then something else in the process changes the
    // working directory before the first write.
    const reported = inChild(
      `${STORE_IMPORT}
       import { readdirSync } from 'node:fs';
       process.chdir(${JSON.stringify(root)});
       const store = new FileAuditStore({ dataDir: 'named' });
       process.chdir(${JSON.stringify(elsewhere)});
       await store.write({ operation: 'LOGIN', actor: 'admin', resource: '/api/login', result: 'success' });
       await store.close();
       const files = (dir) => readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
       console.log(JSON.stringify({ named: files(${JSON.stringify(named)}), elsewhere: files(${JSON.stringify(elsewhere)}) }));`,
      PACKAGE_DIR,
    );

    // Before the fix this child died with `ENOENT`: the store had built its segment
    // path from `named`, and by the time it appended, `named` meant a directory that
    // did not exist. The evidence is now pinned to where the caller pointed.
    const parsed = JSON.parse(reported);
    expect(parsed.elsewhere).toEqual([]);
    expect(parsed.named).toHaveLength(1);
    expect(parsed.named[0]).toMatch(/^audit-\d{8}-\d{4}\.ndjson$/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('XP.3 — a store leaves the working directory alone', () => {
    const dataDir = join(root, 'segments');
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });

    // The child *starts* in the empty directory, which is the situation a service
    // has when it is launched from a unit file that names no working directory.
    const reported = inChild(
      `${STORE_IMPORT}
       const store = new FileAuditStore({ dataDir: ${JSON.stringify(dataDir)} });
       await store.write({ operation: 'DELETE', actor: 'ops', resource: '/db/rows', result: 'success' });
       await store.close();
       console.log(JSON.stringify({ cwd: process.cwd() }));`,
      work,
    );
    expect(JSON.parse(reported).cwd).toBe(work);

    // The store was pointed at `dataDir`; the directory it happened to run in is not
    // its business, and an audit trail that drips into it is evidence in the wrong
    // place — which is exactly what `operations/undefined.tmp` was.
    expect(readdirSync(work)).toEqual([]);

    // Not vacuous: the entry exists, and it is in the directory that was named.
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.ndjson'))).toHaveLength(1);
  });
});
