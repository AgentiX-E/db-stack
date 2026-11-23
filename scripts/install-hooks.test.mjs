/**
 * Tests for the hook installer.
 *
 * The installer has three jobs and each of them fails quietly in a way that
 * matters: a `core.hooksPath` that does not point at `.githooks`, an absolute path
 * that happens to be right on one machine, and a hook without the execute bit —
 * which git skips without a word, so the push is unchecked and indistinguishable
 * from a checked one.
 *
 * The git calls are injected, so these cases assert the *command* rather than a
 * repository's state, and the file-shaped cases run against a temporary tree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  HOOKS_DIR,
  check,
  repoGit,
  configuredHooksPath,
  hookNames,
  hooksPath,
  isEntryPoint,
  install,
  main,
  rootArg,
} from "./install-hooks.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A temporary repository-shaped tree with the given hooks. */
function tree(hooks, mode = 0o644) {
  const dir = mkdtempSync(join(tmpdir(), "install-hooks-"));
  mkdirSync(join(dir, HOOKS_DIR));
  for (const name of hooks) {
    writeFileSync(join(dir, HOOKS_DIR, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, HOOKS_DIR, name), mode);
  }
  return dir;
}

test("install sets core.hooksPath and makes every hook executable", () => {
  const dir = tree(["pre-push", "pre-commit"]);
  const calls = [];
  const modes = [];
  try {
    const done = install(
      dir,
      (args) => calls.push(args),
      (path, mode) => modes.push([path, mode]),
    );

    assert.deepEqual(calls, [["config", "core.hooksPath", HOOKS_DIR]]);
    assert.deepEqual(done.hooks, ["pre-commit", "pre-push"]);
    // Every hook, not just the one this iteration added: a second hook nobody
    // made executable is the same defect one file later.
    assert.deepEqual(
      modes.map(([path, mode]) => [path.slice(dir.length + 1), mode]),
      [
        [join(HOOKS_DIR, "pre-commit"), 0o755],
        [join(HOOKS_DIR, "pre-push"), 0o755],
      ],
    );
    assert.equal(done.hooksPath, HOOKS_DIR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install refuses a tree with no hooks rather than configuring an empty directory", () => {
  const dir = tree([]);
  try {
    assert.throws(() => install(dir, () => {}), /no hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hookNames reports nothing when the directory is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "install-hooks-"));
  try {
    assert.deepEqual(hookNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check accepts the configured relative path and an absolute one that resolves to it", () => {
  const dir = tree(["pre-push"], 0o755);
  try {
    assert.equal(check(dir, HOOKS_DIR).ok, true);
    // A contributor who ran `git config core.hooksPath "$PWD/.githooks"` got the
    // right answer by a different route; refusing it would be pedantry with a cost.
    assert.equal(check(dir, join(dir, HOOKS_DIR)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check names each way the chain is broken", () => {
  const dir = tree(["pre-push"], 0o755);
  try {
    assert.match(check(dir, "").problem, /core\.hooksPath is not set/);
    assert.match(check(dir, ".husky").problem, /not \.githooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const noHooks = tree([]);
  try {
    assert.match(check(noHooks, HOOKS_DIR).problem, /holds no hook/);
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }

  const notExecutable = tree(["pre-push"], 0o644);
  try {
    // The mode is the finding, not the content: git runs no hook it cannot execute
    // and says nothing about it.
    assert.match(check(notExecutable, HOOKS_DIR).problem, /not executable/);
  } finally {
    rmSync(notExecutable, { recursive: true, force: true });
  }
});

test("configuredHooksPath treats an unset key as an empty answer, not an error", () => {
  assert.equal(
    configuredHooksPath(() => `${HOOKS_DIR}\n`),
    HOOKS_DIR,
  );
  assert.equal(
    configuredHooksPath(() => {
      throw new Error("exit 1");
    }),
    "",
  );
});

test("main exits 1 when the checkout is not configured, and 0 when it is", () => {
  const dir = tree(["pre-push"], 0o755);
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const unset = (args) => {
      if (args[1] === "--get") throw new Error("exit 1");
      return "";
    };
    assert.equal(main(["--check"], dir, unset), 1);

    // A configured checkout: the same tree, a git that answers with the path.
    assert.equal(
      main(["--check"], dir, () => `${HOOKS_DIR}\n`),
      0,
    );

    // And the installing path sets it, rather than only reporting on it.
    const calls = [];
    assert.equal(
      main([], dir, (args) => {
        calls.push(args);
        return "";
      }),
      0,
    );
    assert.deepEqual(calls, [["config", "core.hooksPath", HOOKS_DIR]]);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real git path configures a real repository", () => {
  const dir = tree(["pre-push"], 0o755);
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      // No injected git: the default runs `git config` against the tree, which is
      // the path every contributor takes after `pnpm install`.
      assert.equal(main([], dir), 0);
      assert.equal(main(["--check"], dir), 0);
    } finally {
      console.log = originalLog;
    }
    assert.equal(
      repoGit(dir)(["config", "--get", "core.hooksPath"]).trim(),
      HOOKS_DIR,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line answers a repository it is pointed at, installed or not", () => {
  // The path every contributor takes and no in-process case can: the file as a
  // program. `--root` is what makes both answers reachable — without it, the
  // branch that reports "not set" exists only on a clone that has not installed
  // the hooks, which is a coverage figure that depends on the machine: 98.80 %
  // lines with 166-167 uncovered here, 100 % on a fresh one.
  const dir = tree(["pre-push"], 0o755);
  const script = resolve(ROOT, "scripts/install-hooks.mjs");
  const run = (...argv) =>
    spawnSync(process.execPath, [script, ...argv], {
      cwd: dir,
      encoding: "utf8",
    });
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);

    // Not installed yet: the CLI names what is wrong and exits 1.
    const before = run("--check", "--root", dir);
    assert.equal(before.status, 1);
    assert.match(before.stderr, /core\.hooksPath is not set/);

    // Installed by the same command line, then asked again.
    const installed = run("--root", dir);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /core\.hooksPath=\.githooks/);

    const after = run("--check", "--root", dir);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /install-hooks: pre-push via \.githooks/);
    assert.equal(
      repoGit(dir)(["config", "--get", "core.hooksPath"]).trim(),
      HOOKS_DIR,
    );

    // A flag with no directory is answered, not thrown: the only caller that can
    // get this wrong is a person.
    const bare = run("--root");
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /--root needs a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real repository ships a hook, and this script is what installs it", () => {
  // A gate over zero hooks passes for any tree; this asserts the tree this
  // repository actually pushes from has one.
  assert.deepEqual(hookNames(ROOT), ["pre-push"]);
  assert.equal(hooksPath(), HOOKS_DIR);
  const hook = readFileSync(resolve(ROOT, HOOKS_DIR, "pre-push"), "utf8");
  assert.match(hook, /pnpm preflight/);
});

test("the entry check answers false when there is no program path", () => {
  // `process.argv[1]` is always a test file in this suite, so the half of the guard
  // that matters to a script imported as a module — no path at all — used to be an
  // untaken branch on the file's last line. Naming the check made it a case: with
  // the compile cache stripped, these three scripts read 94.12 % / 93.55 % / 94.12 %
  // branches and the only missing arm was `process.argv[1] ?? ""`.
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(""), false);
  assert.equal(isEntryPoint("/nowhere/else.mjs"), false);
  assert.equal(
    isEntryPoint(resolve(import.meta.dirname, "install-hooks.mjs")),
    true,
  );
});

test("--root names the tree, and its absence means this one", () => {
  // `main` short-circuits on its own `root` argument, so the flag path is only
  // reached from a command line — the branch that returns the default was the one
  // arm of this file no case took.
  assert.equal(rootArg(["--check"]), ROOT);
  assert.equal(
    rootArg(["--check", "--root", "/tmp/elsewhere"]),
    "/tmp/elsewhere",
  );
  assert.equal(rootArg(["--root"]), null);
});
