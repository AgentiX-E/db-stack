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
 * Every run also leaves a **receipt** in the git directory: which commit, which
 * tree, whether the worktree was clean, which steps ran and how each ended. It is
 * the difference between "I ran the gates" and "this tree passed them", and it
 * exists because the first is a memory. Iteration 97 landed a `prefer-const` in a
 * new harness file that every gate would have caught, on a push path that cannot
 * run a git hook: `push_commit.py` speaks the Git Data API directly, so
 * `.githooks/pre-push` never executes, and nothing asked whether preflight had
 * been run at all. `scripts/check-push-receipt.mjs` is what asks, and
 * `push_commit.py` calls it before it creates a blob.
 *
 * A receipt names the tree it checked, so the order is commit → preflight → push.
 * Run before the commit, the worktree is dirty, the receipt records `clean: false`
 * and says so: it checked bytes that are not HEAD's, and a push may not cite it.
 * Run with `--only`, the receipt records the steps that actually ran and is
 * refused for the ones that did not, so a narrowed run cannot be mistaken for the
 * whole set.
 *
 * Usage:
 *   pnpm preflight            # run every step, stop at the first failure
 *   pnpm preflight --list     # print the steps, one per line (used by check:hooks)
 *   pnpm preflight --only lint,format:check
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
 *
 * `spawn` is injected for the same reason `runSteps` takes an `execute`, and it
 * took a red CI run to learn it. The only way to get a non-zero status out of
 * pnpm is to ask it for a script that does not exist — and that also fails the
 * command running the test, because the failing process is pnpm, inside pnpm.
 * CI job 45108062128 is that shape: 535 green assertions and a failed step.
 * The real spawn still runs, on the passing side, one case below.
 */
export function runScript(script, spawn = spawnSync) {
  return (
    spawn("pnpm", [script], { cwd: ROOT, stdio: "inherit", shell: false })
      .status === 0
  );
}

/** Where the runner's own lines go; named so it is a function something can run. */
export function toStdout(line) {
  console.log(line);
}

/** The receipt's file name, inside the git directory and therefore never tracked. */
export const RECEIPT_NAME = "preflight-receipt.json";

/**
 * The receipt that belongs to a git directory.
 *
 * Inside `.git` on purpose: a receipt in the worktree is a file someone can commit,
 * and a committed approval is an approval from a machine that is not this one.
 * `git status` does not see it, so writing it cannot make a clean worktree dirty.
 */
export function receiptPath(gitDir) {
  return resolve(gitDir, RECEIPT_NAME);
}

/**
 * What a push has to be able to name: the commit, and the tree it contains.
 *
 * Separate from `collectHead` in `check-push-receipt` only by what it is used for —
 * the shape is the same, and the shape is the contract between the two commands.
 */
export function collectHead(git) {
  return {
    commit: git("rev-parse", "HEAD").trim(),
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    clean:
      git("status", "--porcelain", "--untracked-files=normal").trim() === "",
  };
}

/**
 * The receipt for a run: which tree, which steps, how each ended.
 *
 * `clean` is not a detail. A preflight run before the commit checks files that are
 * not yet in HEAD, so its verdict is about bytes the receipt cannot name; recording
 * that as `false` is what lets the receiving gate refuse it by name instead of
 * trusting a verdict about something else. `steps` is the whole set that ran, in
 * order, which is also the proof that a `--only` run is not mistaken for this one.
 *
 * @param {{ok: boolean, results: Array<{script: string, ok: boolean, ms: number}>}} executed
 * @param {{commit: string, tree: string, clean: boolean}} head
 * @param {{now?: () => string, node?: string}} [deps]
 */
export function receiptFor(executed, head, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    commit: head.commit,
    tree: head.tree,
    clean: head.clean,
    passed: executed.ok,
    steps: executed.results.map((result) => ({
      script: result.script,
      ok: result.ok,
      ms: result.ms,
    })),
    node: deps.node ?? process.version,
    finishedAt: now(),
  };
}

/**
 * Write the receipt, creating the directory if the git directory is unusual.
 *
 * `mkdirSync` is here for `git worktree`, where the git directory is a path
 * `rev-parse --git-dir` prints and not necessarily one that exists yet.
 */
export function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

/** git, read-only, from the repository root. The one call a test has to replace. */
export function readGit(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * The path the receipt belongs at, and the tree it has to name — read together.
 *
 * Together because they are one fact: a receipt is only meaningful inside the git
 * directory whose HEAD it describes, and reading them apart produced two ways for a
 * run to be green about nothing. One `try` here rather than two guards there.
 */
export function gitFacts(git) {
  return {
    path: receiptPath(git("rev-parse", "--absolute-git-dir").trim()),
    head: collectHead(git),
  };
}

/**
 * @param {string[]} argv
 * @param {(script: string) => boolean} execute  injected so a test can drive both outcomes
 * @param {(line: string) => void} say
 * @param {{git?: Function, record?: Function, now?: () => string}} [deps]  the edges a test cannot own
 */
export function main(
  argv = process.argv.slice(2),
  execute = runScript,
  say = toStdout,
  deps = {},
) {
  const git = deps.git ?? readGit;
  const record = deps.record ?? writeReceipt;

  const selected = selectSteps(argv);
  if (selected.list) {
    for (const step of STEPS) say(step.script);
    return 0;
  }

  const executed = runSteps(selected.steps, execute, say);
  sayReceipt(executed, git, record, say, deps);
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

/**
 * Record the verdict against the tree it is about, and say where it went.
 *
 * Every run writes one, passing or failing: a failing receipt is the one that
 * matters most, because it is what turns "I already ran preflight" into a refusal
 * naming the step that failed.
 */
export function sayReceipt(executed, git, record, say, deps) {
  let facts;
  try {
    facts = gitFacts(git);
  } catch (err) {
    say(
      `preflight: no receipt written (${err instanceof Error ? err.message : String(err)}) — ` +
        "this tree cannot be named, so a push over the API path will refuse it.",
    );
    return null;
  }

  const receipt = receiptFor(executed, facts.head, deps);
  say(
    `preflight: receipt at ${record(facts.path, receipt)} (${facts.head.commit.slice(0, 7)}).`,
  );
  if (!facts.head.clean) {
    say(
      "preflight: the worktree is not clean, so this verdict is about files that are not in HEAD. " +
        "Commit, then run preflight again — a push may only cite a receipt for its own tree.",
    );
  }
  return receipt;
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
