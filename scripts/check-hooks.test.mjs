/**
 * Tests for the hook gate.
 *
 * `check-hooks` exists because every way a hook fails is silent: git skips one
 * that is not executable, skips a `core.hooksPath` that points nowhere, and runs
 * hooks from the repository root. The findings are therefore built as facts about
 * a tree — a hook's text and mode, the steps preflight runs, the `prepare` script
 * — so each broken shape can be constructed without a checkout.
 *
 * The last case runs the gate over the real repository, because a gate that reads
 * zero files reports perfect compliance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REQUIRED_STEPS,
  audit,
  facts,
  isEntryPoint,
  main,
} from "./check-hooks.mjs";
import { STEPS } from "./preflight.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HEALTHY = {
  hookText: "#!/bin/sh\nset -e\npnpm preflight\nexec pnpm check:push-receipt\n",
  hookMode: 0o755,
  steps: STEPS.map((step) => step.script),
  prepare: "node scripts/install-hooks.mjs",
};

test("a healthy tree has no findings", () => {
  assert.deepEqual(audit(HEALTHY), []);
});

test("a missing hook is a finding, and so is one git would skip", () => {
  assert.match(
    audit({ ...HEALTHY, hookText: null }).join("\n"),
    /pre-push is missing/,
  );
  assert.match(
    audit({ ...HEALTHY, hookMode: 0o644 }).join("\n"),
    /not executable/,
  );
});

test("a hook that runs something else is a finding", () => {
  // The quietest wrong answer: a hook that exists, is executable, and checks a
  // different thing than the one CONTRIBUTING documents.
  const problems = audit({
    ...HEALTHY,
    hookText: "#!/bin/sh\nexec pnpm lint\n",
  });
  assert.match(problems.join("\n"), /does not run `pnpm preflight`/);
});

test("a hook that preflights and never reads the receipt is a finding", () => {
  // The shape the gate was added for: the gates run, the receipt is written, and
  // nothing asks for it — so the push that skipped preflight elsewhere is not caught
  // here either, and the record is the only thing anyone could cite.
  const problems = audit({
    ...HEALTHY,
    hookText: "#!/bin/sh\nset -e\nexec pnpm preflight\n",
  });
  assert.equal(problems.length, 1);
  assert.match(problems.join("\n"), /never `pnpm check:push-receipt`/);
  assert.match(problems.join("\n"), /read by nothing/);
});

test("a preflight that lost a step is a finding, named by step", () => {
  const problems = audit({
    ...HEALTHY,
    steps: STEPS.map((step) => step.script).filter((s) => s !== "lint"),
  });
  assert.match(problems.join("\n"), /preflight does not run lint/);
  // Every required step is required by name: a gate that would accept any subset
  // would accept the empty one.
  for (const step of REQUIRED_STEPS) assert.ok(HEALTHY.steps.includes(step));
});

test("a package.json with no prepare means no clone receives the hook", () => {
  assert.match(
    audit({ ...HEALTHY, prepare: "" }).join("\n"),
    /no `prepare` script/,
  );
  assert.match(
    audit({ ...HEALTHY, prepare: "node scripts/something-else.mjs" }).join(
      "\n",
    ),
    /no `prepare` script/,
  );
});

test("facts reads the hook mode and the prepare script out of a tree", () => {
  const read = facts(ROOT);
  assert.match(read.hookText, /pnpm preflight/);
  assert.notEqual(read.hookMode & 0o111, 0);
  assert.match(read.prepare, /install-hooks/);
  assert.deepEqual(read.hooks, ["pre-push"]);
});

test("facts reports a missing hook as missing, and main fails on that tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-hooks-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { prepare: "node scripts/install-hooks.mjs" },
      }),
    );
    assert.equal(facts(dir).hookText, null);

    const originalError = console.error;
    const errors = [];
    console.error = (line) => errors.push(line);
    try {
      assert.equal(main(dir), 1);
    } finally {
      console.error = originalError;
    }
    assert.match(errors.join("\n"), /pre-hook|pre-push is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts reads a hook that exists but cannot be executed", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-hooks-"));
  try {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(
      join(dir, ".githooks", "pre-push"),
      "#!/bin/sh\nexec pnpm preflight\n",
      { mode: 0o644 },
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const read = facts(dir);
    assert.equal(read.hookMode & 0o111, 0);
    assert.equal(read.prepare, "");
    assert.match(audit(read).join("\n"), /not executable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate passes on the real repository", () => {
  const originalLog = console.log;
  const originalError = console.error;
  let exitCode;
  console.log = () => {};
  console.error = () => {};
  try {
    exitCode = main(ROOT);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(exitCode, 0);
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
    isEntryPoint(resolve(import.meta.dirname, "check-hooks.mjs")),
    true,
  );
});
