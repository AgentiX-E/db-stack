#!/usr/bin/env node
/**
 * preflight — the gate a push has to pass, in one command.
 *
 * `pnpm verify` is the full chain: every suite, every coverage dimension, and the
 * end-to-end harness. It takes most of an hour and needs a GitHub Runner's worth
 * of disk, which is why nobody ran it before a push — and why iteration 25 landed
 * a file that `format:check` rejects and spent a CI round trip discovering it.
 *
 * This is the part of `verify` that is fast, deterministic and needs no network:
 * it compiles the sources and the tests, lints, checks formatting, and runs the
 * gates that read the tree. That is the set that catches the mistakes a push can
 * carry — a type error, an unformatted file, a doc page naming a symbol that no
 * longer exists — without pretending to be the acceptance run.
 *
 * The distinction matters and is stated in CONTRIBUTING: this command is what a
 * contributor runs, CI is what decides. A preflight that passed is not a green
 * build; it is the absence of the failures that are cheapest to catch locally.
 *
 * Usage:
 *   pnpm preflight            # run every step, stop at the first failure
 *   pnpm preflight --list     # print the steps, one per line (used by check:hooks)
 *   pnpm preflight --only lint,format:check
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * The steps, in the order that fails fastest.
 *
 * Cheap syntax-level answers come first (a type error usually breaks several
 * later steps anyway), then the gates that read the tree, then the two suites
 * that take a minute — the script self-tests last, because a script failure is
 * what the earlier steps would have caught.
 */
export const STEPS = [
  { script: "typecheck", why: "every package compiles" },
  { script: "typecheck:tests", why: "the tests are code too" },
  { script: "lint", why: "ESLint, one shared config" },
  { script: "format:check", why: "Prettier over the packages" },
  {
    script: "format:check:repo",
    why: "Prettier over the files no package owns",
  },
  { script: "check:gates", why: "no orphan config, no script pointing at air" },
  {
    script: "check:hooks",
    why: "the hook this command exists for is installed",
  },
  { script: "check:english", why: "English comments and test titles" },
  { script: "check:esm-require", why: "no CommonJS require() in ESM packages" },
  {
    script: "check:docs-api",
    why: "the API pages name symbols the packages export",
  },
  { script: "check:doc-examples", why: "fenced examples type-check" },
  {
    script: "check:public-types",
    why: "public signatures name importable types",
  },
  {
    script: "check:script-bins",
    why: "every script invokes an installed binary",
  },
  { script: "check:legacy-names", why: "no source imports a retired name" },
  {
    script: "check:test-counts",
    why: "the counts the docs state are the counts that ran",
  },
  {
    script: "check:script-coverage",
    why: "the gate self-tests cover the gates",
  },
  { script: "test:scripts", why: "the gate self-tests pass" },
];

/** What the user is told when a step fails: which step, and what it was checking. */
export function failureHint(step) {
  return `preflight stopped at \`pnpm ${step.script}\` (${step.why}). Nothing after it ran.`;
}

/**
 * Run steps until one fails, or all of them pass.
 *
 * `execute` is injected so a test can watch the order and the stopping rule
 * without spawning pnpm; the real one inherits stdio, because a contributor
 * wants the compiler's own message rather than a summary of it.
 *
 * @param {Array<{script: string, why: string}>} steps
 * @param {(script: string) => boolean} execute
 * @param {(line: string) => void} say
 */
export function runSteps(steps, execute, say) {
  const results = [];
  for (const step of steps) {
    const started = Date.now();
    const ok = execute(step.script);
    const ms = Date.now() - started;
    results.push({ script: step.script, ok, ms });
    say(`${ok ? "✓" : "✗"} ${step.script} (${(ms / 1000).toFixed(1)}s)`);
    if (!ok) {
      say(failureHint(step));
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

/** `--only a,b` narrows the run to the steps named; an unknown name is refused. */
export function selectSteps(argv) {
  const listAt = argv.indexOf("--list");
  if (listAt !== -1) return { list: true };

  const onlyAt = argv.indexOf("--only");
  if (onlyAt === -1) return { steps: STEPS };

  const wanted = (argv[onlyAt + 1] ?? "").split(",").filter(Boolean);
  if (wanted.length === 0)
    throw new Error("--only needs a comma-separated list of step names");
  const unknown = wanted.filter(
    (name) => !STEPS.some((step) => step.script === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown step(s): ${unknown.join(", ")}. Run \`pnpm preflight --list\` for the list.`,
    );
  }
  return { steps: STEPS.filter((step) => wanted.includes(step.script)) };
}

/**
 * The real executor: run the script through pnpm with the terminal attached.
 *
 * `stdio: 'inherit'` rather than a captured buffer — the compiler's own message,
 * with its file and column, is the thing a contributor acts on, and a summary of
 * it is a summary of the one detail that matters.
 */
export function runScript(script) {
  return (
    spawnSync("pnpm", [script], { cwd: ROOT, stdio: "inherit", shell: false })
      .status === 0
  );
}

/** Where the runner's own lines go; named so it is a function something can run. */
export function toStdout(line) {
  console.log(line);
}

/**
 * @param {string[]} argv
 * @param {(script: string) => boolean} execute  injected so a test can drive both outcomes
 * @param {(line: string) => void} say
 */
export function main(
  argv = process.argv.slice(2),
  execute = runScript,
  say = toStdout,
) {
  const selected = selectSteps(argv);
  if (selected.list) {
    for (const step of STEPS) say(step.script);
    return 0;
  }

  const executed = runSteps(selected.steps, execute, say);
  if (!executed.ok) return 1;

  const slowest = executed.results.reduce((a, b) => (b.ms > a.ms ? b : a));
  say(
    `preflight: ${executed.results.length} steps passed (slowest: ${slowest.script}).`,
  );
  say(
    "This is not the acceptance run: CI runs the suites, the coverage gate and the e2e harness.",
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
