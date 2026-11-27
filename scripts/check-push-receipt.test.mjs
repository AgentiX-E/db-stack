/**
 * Tests for the gate that reads the preflight receipt.
 *
 * Every rule in the gate exists because a tree got through without it, so every case
 * here is a tree that gets through without it: a receipt from another commit, one
 * taken on a dirty worktree, one from a `--only lint` run, one whose last step
 * failed. Each states the sentence it is refused with, because a refusal that does
 * not name what is wrong sends its reader to the source.
 *
 * The judgement is a pure function of a receipt and a head, so these cases write
 * both rather than producing them — which is the only way to assert that a gate
 * refuses anything rather than that it passes here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  NO_RECEIPT,
  audit,
  check,
  isEntryPoint,
  readReceipt,
  report,
  run,
} from "./check-push-receipt.mjs";
import { STEPS } from "./preflight.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TREE = "89abcdef0123456789abcdef0123456789abcdef";
const HEAD = { commit: COMMIT, tree: TREE };

/** A receipt that every rule accepts, so a case can spoil exactly one field. */
function receipt(overrides = {}) {
  return {
    commit: COMMIT,
    tree: TREE,
    clean: true,
    passed: true,
    steps: STEPS.map((step) => ({ script: step.script, ok: true, ms: 1 })),
    node: process.version,
    finishedAt: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

/** The reasons, joined — a case asserts the sentence, not the count. */
function refusals(input) {
  const verdict = audit(input);
  return { ok: verdict.ok, said: verdict.reasons.join(" ") };
}

test("a receipt for this tree, with every step passed, is an approval", () => {
  const verdict = audit({ receipt: receipt(), head: HEAD });
  assert.deepEqual(verdict, { ok: true, reasons: [] });
});

test("no receipt is a refusal that names the command", () => {
  const { ok, said } = refusals({ receipt: undefined, head: HEAD });
  assert.equal(ok, false);
  assert.equal(said, NO_RECEIPT);
  assert.match(said, /pnpm preflight/);
  // Why the command is the gate, not the hook: the sentence has to carry the reason,
  // because the next question a reader asks is "why did the hook not catch this".
  assert.match(said, /cannot run a git hook/);
});

test("a receipt that does not parse is refused as a file, not as an absence", () => {
  // "Never ran" and "ran, and the record is corrupt" are different problems with
  // different fixes, so the two do not share a sentence.
  for (const broken of [null, [], "passed", 42]) {
    const { ok, said } = refusals({ receipt: broken, head: HEAD });
    assert.equal(ok, false);
    assert.match(said, /not a JSON object/);
    assert.match(said, /Delete it and run `pnpm preflight`/);
  }
});

test("a failed preflight is a record of failure, not an approval", () => {
  const { ok, said } = refusals({
    receipt: receipt({
      passed: false,
      steps: STEPS.map((s) => ({ script: s.script, ok: true })),
    }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(said, /the last preflight failed/);
});

test("a receipt taken on a dirty worktree judged bytes that are not HEAD's", () => {
  const { ok, said } = refusals({
    receipt: receipt({ clean: false }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(said, /preflight ran with uncommitted changes/);
  assert.match(said, /Commit first, then run `pnpm preflight`/);
});

test("a receipt for another commit names both commits", () => {
  const { ok, said } = refusals({
    receipt: receipt({ commit: "f".repeat(40) }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(
    said,
    /the receipt is for commit fffffff and this push is 0123456/,
  );
});

test("a receipt for another tree names both trees", () => {
  // The commit can match while the tree does not — an amended commit keeps neither,
  // but a hand-edited receipt keeps both — so the tree is checked on its own.
  const { ok, said } = refusals({
    receipt: receipt({ tree: "f".repeat(40) }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(
    said,
    /the receipt names tree fffffff and 0123456 contains 89abcde/,
  );
});

test("a narrowed run cannot be cited as the whole set", () => {
  const lintOnly = {
    ...receipt(),
    steps: [{ script: "lint", ok: true, ms: 1 }],
  };
  const { ok, said } = refusals({ receipt: lintOnly, head: HEAD });
  assert.equal(ok, false);
  assert.match(said, /the receipt does not name typecheck/);
  assert.match(said, /A narrowed run is not the whole set/);
});

test("a step this commit does not define is refused rather than ignored", () => {
  // A receipt from a version of the command that ran something else is not evidence
  // about this one; ignoring the extra entry would let the sets drift apart silently.
  const { ok, said } = refusals({
    receipt: receipt({
      steps: [...receipt().steps, { script: "gone", ok: true }],
    }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(said, /the receipt names gone, which is not a preflight step/);
});

test("a step recorded as not ok fails the receipt even when the flag says passed", () => {
  // The flag and the list are two statements of the same fact. When they disagree the
  // stricter one wins, because the flag is a summary and the list is the detail.
  const steps = STEPS.map((step, index) => ({
    script: step.script,
    ok: index !== 2,
  }));
  const { ok, said } = refusals({ receipt: receipt({ steps }), head: HEAD });
  assert.equal(ok, false);
  assert.match(
    said,
    new RegExp(`the receipt records ${STEPS[2].script} as not ok`),
  );
});

test("a receipt with the right steps in the wrong order was written by something else", () => {
  const reordered = [...receipt().steps];
  const first = reordered[0];
  reordered[0] = reordered[1];
  reordered[1] = first;
  const { ok, said } = refusals({
    receipt: receipt({ steps: reordered }),
    head: HEAD,
  });
  assert.equal(ok, false);
  assert.match(said, /ran in a different order/);
});

test("readReceipt tells an absent file from an unparseable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "push-receipt-"));
  try {
    const missing = join(dir, "nothing.json");
    assert.equal(readReceipt(missing), undefined);

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json", "utf8");
    assert.equal(readReceipt(corrupt), null);

    const valid = join(dir, "valid.json");
    writeFileSync(valid, JSON.stringify({ passed: true }), "utf8");
    assert.deepEqual(readReceipt(valid), { passed: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check joins the repository's own head to the receipt it finds", () => {
  // The two edges — git and the file — injected; everything between them is the gate.
  const verdict = check({
    git: (...args) => {
      const key = args.join(" ");
      if (key === "rev-parse --absolute-git-dir") return "/repo/.git\n";
      if (key === "rev-parse HEAD") return `${COMMIT}\n`;
      if (key === "rev-parse HEAD^{tree}") return `${TREE}\n`;
      if (key.startsWith("status --porcelain")) return "";
      throw new Error(`unexpected git call: ${key}`);
    },
    read: () => receipt(),
  });
  assert.deepEqual(verdict, { ok: true, reasons: [] });
});

test("a tree that is not a git worktree is refused by name, not by a stack trace", () => {
  const verdict = check({
    git: () => {
      throw new Error("fatal: not a git repository (or any parent)");
    },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /not a git worktree/);
  assert.match(verdict.reasons.join(" "), /nothing to push/);
});

test("report prints the reasons, or the sentence that says the receipt held", () => {
  const refused = [];
  assert.equal(
    report({ ok: false, reasons: ["one", "two"] }, (line) =>
      refused.push(line),
    ),
    false,
  );
  assert.deepEqual(refused, ["  - one", "  - two"]);

  const approved = [];
  assert.equal(
    report({ ok: true, reasons: [] }, (line) => approved.push(line)),
    true,
  );
  assert.deepEqual(approved, [
    "the preflight receipt matches this tree and every step passed.",
  ]);
});

test("run answers 0 for an approval and 1 for a refusal, saying which", () => {
  const out = [];
  const say = (line) => out.push(line);
  const err = (line) => out.push(line);

  assert.equal(
    run(
      {
        git: () => {
          throw new Error("no repo");
        },
      },
      say,
      err,
    ),
    1,
  );
  // The refusal ends with the command that clears it, because "refused" without a
  // next step is how a gate earns a `--force` flag.
  assert.match(
    out.at(-1),
    /Run `pnpm preflight` at this commit and push again/,
  );

  const approved = [];
  assert.equal(
    run(
      {
        git: (...args) => {
          const key = args.join(" ");
          if (key === "rev-parse --absolute-git-dir") return "/repo/.git\n";
          if (key === "rev-parse HEAD") return `${COMMIT}\n`;
          if (key === "rev-parse HEAD^{tree}") return `${TREE}\n`;
          return "";
        },
        read: () => receipt(),
      },
      (line) => approved.push(line),
      (line) => approved.push(line),
    ),
    0,
  );
  assert.deepEqual(approved, [
    "the preflight receipt matches this tree and every step passed.",
  ]);
});

test("report and run write to the console when nothing is injected", () => {
  // The defaults are what a push sees: one to stdout, the refusal to stderr.
  const logged = [];
  const errored = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => logged.push(line);
  console.error = (line) => errored.push(line);
  try {
    assert.equal(report({ ok: true, reasons: [] }), true);
    assert.equal(
      run({
        git: () => {
          throw new Error("no repo");
        },
      }),
      1,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(logged, [
    "the preflight receipt matches this tree and every step passed.",
    "  - this is not a git worktree (no repo), so there is no tree to approve and nothing to push.",
  ]);
  assert.match(errored[0], /^refusing to push/);
});

test("the entry check answers false when there is no program path", () => {
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(""), false);
  assert.equal(isEntryPoint("/nowhere/else.mjs"), false);
  assert.equal(
    isEntryPoint(resolve(import.meta.dirname, "check-push-receipt.mjs")),
    true,
  );
});

test("the command answers what the judgement says, in this repository's own state", () => {
  // The path an in-process case cannot take: the file as a program, reading the real
  // repository. The assertion is agreement rather than a fixed verdict — the suite must
  // not depend on whether a receipt happens to exist, because that would make it pass or
  // fail on the order its cases were run in. What it proves is that `process.exit(run())`
  // is the judgement, and that the reasons printed are the reasons found.
  const verdict = check();
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-push-receipt.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, verdict.ok ? 0 : 1, child.stderr);
  if (verdict.ok) {
    assert.match(child.stdout, /the preflight receipt matches this tree/);
  } else {
    assert.match(
      child.stderr,
      /refusing to push: this tree has not passed the static gates/,
    );
    for (const reason of verdict.reasons) {
      assert.ok(
        child.stdout.includes(reason),
        `the program did not print: ${reason}`,
      );
    }
  }
});
