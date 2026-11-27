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
 *   3. it also invokes `pnpm check:push-receipt`, because a receipt nothing reads is
 *      a record, not a gate;
 *   4. `preflight` itself still lists the gates, so a hook that runs an empty
 *      command is a finding rather than a green result;
 *   5. `package.json` has `prepare` → `install-hooks`, which is what puts the
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

/**
 * The second command, and the reason it is a rule rather than a suggestion.
 *
 * `preflight` writes the receipt; nothing reads it unless something is told to. The
 * hook is the one place in the tracked tree where a push is visible, so it is where
 * the receipt has to be read — otherwise the gate exists only inside the push tool,
 * where no reviewer can see it and no test of this repository runs it.
 */
export const REQUIRED_RECEIPT_COMMAND = "pnpm check:push-receipt";

/** Gates a preflight without these would not be the preflight CONTRIBUTING describes. */
export const REQUIRED_STEPS = [
  "typecheck",
  "typecheck:tests",
  "lint",
  "lint:root",
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
    } else if (!hookText.includes(REQUIRED_RECEIPT_COMMAND)) {
      // A hook that runs the gates and never reads the receipt approves nothing: the
      // receipt is the only thing a push can cite afterwards.
      problems.push(
        `${HOOKS_DIR}/pre-push runs \`${REQUIRED_COMMAND}\` and never \`${REQUIRED_RECEIPT_COMMAND}\`, ` +
          "so the receipt it writes is read by nothing",
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

/**
 * Whether this module was started as the program.
 *
 * A function rather than an inline comparison at the bottom of the file, for the
 * reason `check-script-coverage.mjs` gives: the comparison contains a branch for
 * `argv[1]` being absent, and a script's last two lines are the ones no test can
 * reach — the suite imports the module, so `process.argv[1]` is always the test
 * file. With the check named, the missing half is a case instead of a blind spot.
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

if (isEntryPoint(process.argv[1])) {
  process.exit(main());
}
