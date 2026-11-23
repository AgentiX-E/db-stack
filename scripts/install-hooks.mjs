#!/usr/bin/env node
/**
 * install-hooks — point git at the hooks this repository keeps in `.githooks/`.
 *
 * The repository had no hooks at all. `pnpm verify` existed, was documented, and
 * ran in no pre-push path: the only thing between a contributor and a push was
 * remembering. Iteration 25 landed a file that `format:check` rejects and learned
 * about it from CI — a round trip that costs a runner fifteen minutes and the
 * author a context switch, for a check that takes one command locally.
 *
 * Hooks live in the repository rather than in `.git/hooks` for the reason every
 * hook tool exists: `.git/hooks` is not versioned, so a hook that is not
 * installed *and* not reviewed is a hook that differs per machine. `core.hooksPath`
 * is what makes the versioned copy the one git runs.
 *
 * A hook cannot run where the push does not go through a local git: this
 * repository is pushed over the GitHub Git Data API from a sandbox whose proxy
 * allows only `api.github.com`. There, `pnpm preflight` is the command and CI is
 * the second net — the hook is for the machine where git push is the path.
 *
 * Usage:
 *   pnpm install-hooks           # set core.hooksPath, make the hooks executable
 *   pnpm install-hooks --check   # exit 1 unless core.hooksPath already points here
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/** Where the versioned hooks live, relative to the repository root. */
export const HOOKS_DIR = ".githooks";

/** Every hook this repository ships. A file here that git never runs is a claim. */
export function hookNames(root) {
  const dir = join(root, HOOKS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

/** The `core.hooksPath` a correct install produces; relative so it survives a clone. */
export function hooksPath() {
  return HOOKS_DIR;
}

/**
 * Read the configured hooks path.
 *
 * `git config --get` exits 1 when the key is absent, which is a fact rather than
 * a failure: the caller decides whether "unset" is a problem.
 */
export function configuredHooksPath(git) {
  try {
    return git(["config", "--get", "core.hooksPath"]).trim();
  } catch {
    return "";
  }
}

/**
 * Install: point git at the versioned hooks and make them executable.
 *
 * The mode change is not cosmetic — git refuses to run a hook that is not
 * executable, silently, and a hook that is skipped without a word is the failure
 * this whole file exists to prevent.
 */
export function install(root, git, chmod = chmodSync) {
  const names = hookNames(root);
  if (names.length === 0)
    throw new Error(`no hooks in ${join(root, HOOKS_DIR)}`);
  git(["config", "core.hooksPath", hooksPath()]);
  for (const name of names) chmod(join(root, HOOKS_DIR, name), 0o755);
  return { hooksPath: hooksPath(), hooks: names };
}

/**
 * Check: the configured path is this repository's hooks directory.
 *
 * Absolute installs are accepted when they resolve to the same directory, because
 * a contributor who ran `git config core.hooksPath "$PWD/.githooks"` got the right
 * answer by a different route, and refusing that would be pedantry with a cost.
 */
export function check(root, configured) {
  if (!configured) {
    return {
      ok: false,
      problem:
        "core.hooksPath is not set, so git runs no hook from this repository",
    };
  }
  const expected = join(root, HOOKS_DIR);
  const actual = resolve(root, configured);
  if (actual !== expected) {
    return {
      ok: false,
      problem: `core.hooksPath is ${configured}, which is not ${HOOKS_DIR}`,
    };
  }
  const names = hookNames(root);
  if (names.length === 0) {
    return {
      ok: false,
      problem: `${HOOKS_DIR} holds no hook, so there is nothing to install`,
    };
  }
  const notExecutable = names.filter(
    (name) => (statSync(join(root, HOOKS_DIR, name)).mode & 0o111) === 0,
  );
  if (notExecutable.length > 0) {
    return {
      ok: false,
      problem: `${notExecutable.join(", ")} not executable; git skips such a hook silently`,
    };
  }
  return { ok: true, hooks: names };
}

/**
 * The real git, run against `root`.
 *
 * A named function rather than a default arrow inside `main`: a default value is
 * evaluated per call and, until a test runs it, is a function nothing has ever
 * executed — which is the shape of a code path that rots.
 */
export function repoGit(root) {
  return (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/**
 * @param {string[]} argv
 * @param {string} root
 * @param {(args: string[]) => string} git  injected so a test does not need a repository
 */
export function main(
  argv = process.argv.slice(2),
  root = ROOT,
  git = repoGit(root),
) {
  if (argv.includes("--check")) {
    const verdict = check(root, configuredHooksPath(git));
    if (!verdict.ok) {
      console.error(
        `install-hooks: ${verdict.problem}. Run \`pnpm install-hooks\`.`,
      );
      return 1;
    }
    console.log(
      `install-hooks: ${verdict.hooks.join(", ")} via ${hooksPath()}`,
    );
    return 0;
  }

  const done = install(root, git);
  console.log(
    `install-hooks: core.hooksPath=${done.hooksPath}, executable: ${done.hooks.join(", ")}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
