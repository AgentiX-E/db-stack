#!/usr/bin/env node
/**
 * check-hooks — the pre-push hook exists, is executable, and runs the gate.
 *
 * A hook is the one part of a gate chain that fails silently: git skips a hook
 * that is not executable, skips a `core.hooksPath` that no longer exists, and runs
 * hooks from the repository root, so a hook written as if it were run from
 * `.githooks/` fails on the first push. None of those produce a message; they
 * produce a push that was not checked, which is indistinguishable from one that
 * passed.
 *
 * So this gate reads the repository side of the chain:
 *
 *   1. `.githooks/pre-push` exists and is executable;
 *   2. it invokes `pnpm preflight` — the same command CONTRIBUTING tells people to
 *      run, rather than a second list that can drift from it;
 *   3. `preflight` itself still lists the gates, so a hook that runs an empty
 *      command is a finding rather than a green result;
 *   4. `package.json` has `prepare` → `install-hooks`, which is what puts the
 *      versioned hooks in front of git after `pnpm install`.
 *
 * What it cannot check is whether *this* clone has `core.hooksPath` set — CI
 * checks out a fresh tree and never runs a hook. `pnpm install-hooks --check`
 * answers that for a machine, and the two together are the whole chain.
 *
 * Usage: node scripts/check-hooks.mjs
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { HOOKS_DIR, hookNames } from "./install-hooks.mjs";
import { STEPS } from "./preflight.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** The command the hook must run, and the reason it must be that one. */
export const REQUIRED_COMMAND = "pnpm preflight";

/** Gates a preflight without these would not be the preflight CONTRIBUTING describes. */
export const REQUIRED_STEPS = [
  "typecheck",
  "typecheck:tests",
  "lint",
  "format:check",
  "check:gates",
];

/**
 * Judge a tree: the hook file, its content, the preflight it names, and the
 * `prepare` script that installs it.
 *
 * Every argument is a fact about a tree rather than a path, so a test can build
 * each broken shape without a git repository: the shapes that matter are a hook
 * without the execute bit, a hook that runs something else, and a `prepare` that
 * was renamed.
 */
export function audit({ hookText, hookMode, steps, prepare }) {
  const problems = [];

  if (hookText === null) {
    problems.push(
      `${HOOKS_DIR}/pre-push is missing; nothing runs before a push`,
    );
  } else {
    if ((hookMode & 0o111) === 0) {
      problems.push(
        `${HOOKS_DIR}/pre-push is not executable, and git skips such a hook without a word`,
      );
    }
    if (!hookText.includes(REQUIRED_COMMAND)) {
      problems.push(
        `${HOOKS_DIR}/pre-push does not run \`${REQUIRED_COMMAND}\``,
      );
    }
  }

  const missing = REQUIRED_STEPS.filter((name) => !steps.includes(name));
  if (missing.length > 0) {
    problems.push(
      `preflight does not run ${missing.join(", ")}, so the hook would check less than it claims`,
    );
  }

  if (!prepare || !prepare.includes("install-hooks")) {
    problems.push(
      "package.json has no `prepare` script running install-hooks, so no clone gets the hook",
    );
  }

  return problems;
}

/** Read the facts `audit` judges out of a real tree. */
export function facts(root) {
  const file = join(root, HOOKS_DIR, "pre-push");
  let hookText = null;
  let hookMode = 0;
  try {
    hookText = readFileSync(file, "utf8");
    hookMode = statSync(file).mode;
  } catch {
    // Reported as "missing" by `audit`, which is the finding that matters.
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    hookText,
    hookMode,
    steps: STEPS.map((step) => step.script),
    prepare: pkg.scripts?.prepare ?? "",
    hooks: hookNames(root),
  };
}

export function main(root = ROOT) {
  const read = facts(root);
  const problems = audit(read);
  if (problems.length > 0) {
    console.error("check-hooks:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `check-hooks: ${read.hooks.join(", ")} → ${REQUIRED_COMMAND} (${STEPS.length} steps)`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
