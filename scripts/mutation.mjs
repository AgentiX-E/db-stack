#!/usr/bin/env node
/**
 * Run the mutation gate for one package — from the repository root, in a sandbox.
 *
 * This script exists for one assertion: **the working directory must be the
 * repository root**. Stryker copies `process.cwd()` into its sandbox and runs the
 * tests there, so invoking it from `operations/` produces a sandbox that is a
 * copy of `operations/` — which has no parent, and therefore neither
 * `tsconfig.base.json` (which `operations/tsconfig.json` extends, and which Vite
 * reads while transforming) nor `scripts/test-tmpdir.mjs` (which every
 * `vitest.setup.ts` imports). The run then dies in the initial test phase with a
 * `TSConfckParseError` that says nothing about the real mistake, which is why the
 * previous revision worked around it by mutating in place.
 *
 * A checker that only documents a constraint is a comment. This one refuses.
 *
 * The refusal is a returned code and a sentence, not a `process.exit()` in the
 * middle of the module, so a test can assert both without starting Stryker.
 *
 * Usage:
 *   node scripts/mutation.mjs <cluster|federation|operations|all> [stryker args]
 *
 * Extra arguments are forwarded to Stryker, which is what makes a targeted run
 * possible: `node scripts/mutation.mjs operations --mutate "...:740-760"`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TARGETS } from "../mutation/targets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * The Stryker entry point, resolved rather than reached through a shell, so this
 * works on every platform.
 */
export function strykerBin(requireFn = createRequire(import.meta.url)) {
  return resolve(
    dirname(requireFn.resolve("@stryker-mutator/core/package.json")),
    "bin/stryker.js",
  );
}

/** The exit code of one Stryker run. */
export function runOne(target, forwarded, options = {}) {
  const spawnFn = options.spawn ?? spawn;
  const error = options.error ?? console.error;

  // P3-96: a mutation run killed mid-flight can leave an in-place edit behind.
  // The worktree guard is opt-in through `files`: when named, a snapshot is taken
  // before the child starts and any file that changed during the run is restored
  // and reported. All three operations are injected so a case can drive a dirty
  // tree without launching Stryker or touching the repository.
  const guarded = Array.isArray(options.files) && options.files.length > 0;
  const snapshot = options.snapshot ?? (() => new Map());
  const changed = options.changed ?? (() => []);
  const restore = options.restore ?? (() => {});
  let before = null;
  if (guarded) {
    try {
      before = snapshot(options.files);
    } catch (cause) {
      error(`mutation: could not snapshot the worktree — ${cause.message}`);
    }
  }

  const settleGuarded = (code) => {
    if (!guarded || before === null) return code;
    let touched;
    try {
      touched = changed(before);
    } catch (cause) {
      error(`mutation: could not diff the worktree — ${cause.message}`);
      return code;
    }
    if (touched.length === 0) return code;
    error(
      `mutation: source tree was modified by the mutation run: ${touched.join(", ")}`,
    );
    try {
      restore(before, touched);
      error(
        `mutation: restored ${touched.length} file(s) to their pre-run state`,
      );
    } catch (cause) {
      error(`mutation: could not restore the worktree — ${cause.message}`);
    }
    // A run that edited its own source is never a pass, even if the child exited 0.
    return 1;
  };

  return new Promise((settle) => {
    const child = spawnFn(
      options.execPath ?? process.execPath,
      [options.bin ?? strykerBin(), "run", ...forwarded],
      {
        cwd: options.cwd ?? repositoryRoot,
        env: { ...(options.env ?? process.env), MUTATION_TARGET: target },
        stdio: "inherit",
      },
    );
    child.on("close", (code, signal) => {
      if (signal) {
        error(`mutation: ${target} was killed by ${signal}`);
        settle(settleGuarded(1));
      } else {
        settle(settleGuarded(code ?? 1));
      }
    });
    child.on("error", (cause) => {
      error(`mutation: could not start the ${target} run — ${cause.message}`);
      settle(settleGuarded(1));
    });
  });
}

/**
 * The worktree guard's default I/O.
 *
 * The snapshot is the file's **bytes**, not its git blob and not an instruction
 * to `git checkout --`. That distinction was learned the hard way: a first
 * implementation restored a file from HEAD while a contributor was formatting
 * it concurrently, and silently destroyed an hour of uncommitted work. Restoring
 * the bytes captured at the start puts back exactly what was there when the run
 * began — no more (a mutation residue) and no less (a legitimate edit).
 */
const FS = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeFileSync(path, text, "utf8"),
  unlink: unlinkSync,
};

/** Capture the exact bytes of each named file; `null` means it did not exist. */
export function snapshotFiles(files, root, fs = FS) {
  const before = new Map();
  for (const file of files) {
    const path = resolve(root, file);
    try {
      before.set(file, fs.exists(path) ? fs.read(path) : null);
    } catch {
      // An unreadable file is recorded as absent: a later write is still a change.
      before.set(file, null);
    }
  }
  return before;
}

/** Name the files whose bytes moved since the snapshot. */
export function changedFiles(before, root, fs = FS) {
  const touched = [];
  for (const [file, was] of before) {
    const path = resolve(root, file);
    let now;
    try {
      now = fs.exists(path) ? fs.read(path) : null;
    } catch {
      now = null;
    }
    if (now !== was) touched.push(file);
  }
  return touched;
}

/** Put back the bytes captured at the start, removing a file that did not exist. */
export function restoreFiles(before, files, root, fs = FS) {
  for (const file of files) {
    const path = resolve(root, file);
    const was = before.get(file) ?? null;
    if (was === null) {
      if (fs.exists(path)) fs.unlink(path);
    } else {
      fs.write(path, was);
    }
  }
}

/**
 * The command line as a function: which targets to run, from where, and what to
 * report when the answer is "not like this".
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const error = options.error ?? console.error;
  const targets = options.targets ?? TARGETS;
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? repositoryRoot;
  const [requested, ...forwarded] = argv;
  const names = Object.keys(targets);

  if (!requested || !(requested === "all" || requested in targets)) {
    error(
      `mutation: expected one of ${[...names, "all"].join(", ")}, received ${requested ?? "nothing"}`,
    );
    return 2;
  }

  if (resolve(cwd) !== root) {
    error(
      [
        `mutation: run this from the repository root, not from ${cwd}.`,
        "  Stryker copies the working directory into its sandbox; run from a package",
        "  directory and the copy has no parent, so the tsconfig it extends and the",
        "  test helper the setup files import are both missing.",
        `  From the root: pnpm run test:mutation:${requested === "all" ? "<target>" : requested}`,
      ].join("\n"),
    );
    return 2;
  }

  // `all` stops at the first failure: a gate that reports three scores and exits 0
  // because the last one passed is not a gate.
  const queue = requested === "all" ? names : [requested];
  // The default runner is `runOne` with the *caller's* options, so it is reachable
  // from a test that injects `spawn` and `bin` — a default nobody can reach is a
  // default nobody has measured. When the target names the files it mutates, the
  // worktree guard is wired to git; a target with no `mutate` list runs without it.
  const run =
    options.run ??
    ((target) => {
      const files = Array.isArray(targets[target]?.mutate)
        ? targets[target].mutate
        : [];
      return runOne(target, forwarded, {
        ...options,
        files,
        snapshot: options.snapshot ?? ((paths) => snapshotFiles(paths, root)),
        changed: options.changed ?? ((before) => changedFiles(before, root)),
        restore:
          options.restore ??
          ((before, paths) => restoreFiles(before, paths, root)),
      });
    });
  for (const target of queue) {
    const code = await run(target);
    if (code !== 0) return code;
  }
  return 0;
}

if (isEntryPoint(process.argv[1])) {
  // No arrow wrapper here: a `.then((code) => ...)` is a function the in-process
  // suite can never call (the entry guard is false under the test runner), and a
  // function nobody can reach is a function nobody can cover. `process.exitCode`
  // lets the event loop drain and keeps the CLI verdict identical.
  main().then(setExitCode);
}

export function setExitCode(code) {
  process.exitCode = code;
}
