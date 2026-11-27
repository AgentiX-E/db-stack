#!/usr/bin/env node
/**
 * check-push-receipt — a push must cite a verdict about the tree it is pushing.
 *
 * The repository has one command that runs every static gate (`pnpm preflight`), a
 * hook that calls it (`.githooks/pre-push`) and a structural gate that keeps the
 * hook wired (`check:hooks`). Between those three the chain looks closed and is
 * not: the hook only runs when *git* pushes, and the environment that needs a push
 * path most — a proxy that allows only `api.github.com` — pushes through the Git
 * Data API, where no client hook exists to run. `CONTRIBUTING` said so in a
 * sentence, and a sentence is not a gate.
 *
 * Iteration 97 paid for the demonstration: a `prefer-const` in a new harness file
 * reached CI while every gate that had been executed locally was green, because
 * `pnpm lint` was in the command and not in the run. This is the question nothing
 * was asking; the receipt `preflight` writes is the evidence it asks for.
 *
 *   1. a receipt exists — otherwise no run has ever approved this tree;
 *   2. it parses and is an object — a truncated file is not a pass;
 *   3. it passed — a failing receipt is a record of a failure, not an approval;
 *   4. it was taken on a clean worktree — otherwise it judged files that are not in
 *      HEAD, and the bytes it judged are not the bytes being pushed;
 *   5. it names this commit and this tree — anything else is a verdict about
 *      another tree, however green;
 *   6. it names every step in `STEPS`, in order, each ok — a `--only lint` run
 *      cannot be cited as the whole set, and neither can a receipt written before a
 *      gate was added.
 *
 * Rule 5 is why the order is commit → preflight → push. Rule 6 is why the step list
 * is imported rather than copied: the two commands have to agree on what "every
 * gate" means, and the only way to keep them agreeing is one definition.
 *
 * Usage:
 *   node scripts/check-push-receipt.mjs    # judge the receipt against HEAD
 *
 * Exit status is 0 only when every rule holds.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { STEPS, gitFacts, readGit } from "./preflight.mjs";

/** Said once, in one place: the refusal a tree with no receipt has earned. */
export const NO_RECEIPT =
  "no preflight receipt: nothing has approved this tree. Run `pnpm preflight` at this " +
  "commit — the API push path cannot run a git hook, so this command is the gate.";

/**
 * The judgement, as a function of what was read.
 *
 * `receipt` is the parsed file, `undefined` when there is no file and `null` when it
 * does not parse; `head` is the commit a push would send. Nothing here touches the
 * disk, so a case can state a receipt and a head and assert the refusal it earns —
 * which is the only way to prove a gate refuses anything.
 *
 * @param {{receipt: unknown, head: {commit: string, tree: string}, expected?: string[]}} input
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function audit({
  receipt,
  head,
  expected = STEPS.map((s) => s.script),
}) {
  if (receipt === undefined) return { ok: false, reasons: [NO_RECEIPT] };
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt)
  ) {
    return {
      ok: false,
      reasons: [
        "the preflight receipt is not a JSON object. Delete it and run `pnpm preflight` — " +
          "a file that does not parse is not evidence of anything.",
      ],
    };
  }

  /** @type {string[]} */
  const reasons = [];
  const r = /** @type {Record<string, any>} */ (receipt);
  const at = head.commit.slice(0, 7);

  if (r.passed !== true) {
    reasons.push(
      "the last preflight failed, so the receipt records a failure rather than an approval. " +
        "Fix the step it names and run `pnpm preflight` again.",
    );
  }

  if (r.clean !== true) {
    reasons.push(
      "preflight ran with uncommitted changes, so it checked files that are not in HEAD. " +
        "Commit first, then run `pnpm preflight` — the receipt must be about the bytes being pushed.",
    );
  }

  if (r.commit !== head.commit) {
    reasons.push(
      `the receipt is for commit ${String(r.commit).slice(0, 7)} and this push is ${at}. ` +
        "A verdict about another commit is a verdict about another tree.",
    );
  }

  if (r.tree !== head.tree) {
    reasons.push(
      `the receipt names tree ${String(r.tree).slice(0, 7)} and ${at} contains ${head.tree.slice(0, 7)}. ` +
        "The commit is not the only thing that has to match.",
    );
  }

  const steps = Array.isArray(r.steps) ? r.steps : [];
  const ran = steps.map((step) => step?.script);
  const missing = expected.filter((script) => !ran.includes(script));
  const extra = ran.filter((script) => !expected.includes(script));
  const failed = steps
    .filter((step) => step?.ok !== true)
    .map((step) => step.script);

  if (missing.length > 0) {
    reasons.push(
      `the receipt does not name ${missing.join(", ")}. A narrowed run is not the whole set — ` +
        "run `pnpm preflight` without `--only`.",
    );
  }
  if (extra.length > 0) {
    reasons.push(
      `the receipt names ${extra.join(", ")}, which is not a preflight step at this commit. ` +
        "It was written by a different version of the command.",
    );
  }
  if (failed.length > 0) {
    reasons.push(`the receipt records ${failed.join(", ")} as not ok.`);
  }
  if (
    ran.length === expected.length &&
    ran.some((script, index) => script !== expected[index])
  ) {
    reasons.push(
      "the steps ran in a different order than `pnpm preflight` defines, so this receipt " +
        "was not written by this command.",
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * The parsed receipt: `undefined` when there is no file, `null` when it does not
 * parse. The two are different refusals — "never ran" and "ran, and the record is
 * corrupt" — so the reader keeps them apart rather than collapsing both to nothing.
 */
export function readReceipt(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The whole check, from disk to verdict, with the two edges injected.
 *
 * A tree that is not a git worktree has nothing to approve; it is refused by name
 * rather than by an exception, because a stack trace is a worse refusal than a
 * sentence.
 *
 * @param {{git?: Function, read?: (path: string) => unknown}} [deps]
 */
export function check(deps = {}) {
  const git = deps.git ?? readGit;
  const read = deps.read ?? readReceipt;

  let facts;
  try {
    facts = gitFacts(git);
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `this is not a git worktree (${err instanceof Error ? err.message : String(err)}), ` +
          "so there is no tree to approve and nothing to push.",
      ],
    };
  }

  return audit({ receipt: read(facts.path), head: facts.head });
}

/**
 * What the reader is told: one line per reason, or the sentence that says it held.
 *
 * Named and exported because the interesting half is the refusal text — a gate that
 * fails silently, or fails with "error 1", sends its reader to the source.
 */
export function report(verdict, say = (line) => console.log(line)) {
  if (verdict.ok) {
    say("the preflight receipt matches this tree and every step passed.");
    return true;
  }
  for (const reason of verdict.reasons) say(`  - ${reason}`);
  return false;
}

/**
 * The program: judge, say what was found, answer with an exit status.
 *
 * The exit status is a return value rather than a `process.exit` at the bottom of
 * the file so that both answers are cases — a gate whose only reachable outcome is
 * its refusal has never been seen to approve anything.
 *
 * @param {{git?: Function, read?: (path: string) => unknown}} [deps]
 * @param {(line: string) => void} [say]
 * @param {(line: string) => void} [err]
 */
export function run(
  deps = {},
  say = (line) => console.log(line),
  err = (line) => console.error(line),
) {
  const verdict = check(deps);
  report(verdict, say);
  if (verdict.ok) return 0;
  err(
    "refusing to push: this tree has not passed the static gates. " +
      "Run `pnpm preflight` at this commit and push again.",
  );
  return 1;
}

export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

if (isEntryPoint(process.argv[1])) {
  process.exit(run());
}
