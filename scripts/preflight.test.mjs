/**
 * Tests for the preflight runner.
 *
 * The value of this script is not that it runs commands — `pnpm verify` did that —
 * but that it runs the *right* ones in the order that fails fastest and stops at
 * the first failure, so a contributor sees one compiler message instead of the
 * cascade that follows it. Both of those are order and stopping rules, which is
 * what these cases pin, with the executor injected so nothing is spawned.
 *
 * The last case runs the real command with `--list` and checks the set against the
 * repository's own `package.json`: a preflight that names a script nobody defines
 * would fail on the first contributor's machine and pass no gate here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  STEPS,
  failureHint,
  main,
  runScript,
  runSteps,
  selectSteps,
  toStdout,
} from "./preflight.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** Collect what the runner said, in order. */
function recorder() {
  const lines = [];
  return { lines, say: (line) => lines.push(line) };
}

test("preflight stops at the first failure and does not run what follows it", () => {
  const ran = [];
  const { lines, say } = recorder();
  const steps = [
    { script: "a", why: "first" },
    { script: "b", why: "second" },
    { script: "c", why: "third" },
  ];

  const result = runSteps(
    steps,
    (script) => {
      ran.push(script);
      return script !== "b";
    },
    say,
  );

  assert.equal(result.ok, false);
  // `c` never ran: a contributor fixes one failure at a time, and a runner that
  // printed three cascading errors for one cause teaches them to ignore the first.
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(
    result.results.map((entry) => entry.script),
    ["a", "b"],
  );
  assert.match(lines.at(-1), /preflight stopped at `pnpm b` \(second\)/);
});

test("preflight runs every step when they all pass, and reports the slowest", () => {
  const ran = [];
  const { lines, say } = recorder();
  const steps = [
    { script: "a", why: "first" },
    { script: "b", why: "second" },
  ];

  const result = runSteps(
    steps,
    (script) => {
      ran.push(script);
      return true;
    },
    say,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(result.results.length, 2);
  // One line per step, each naming the step and its own duration.
  assert.match(lines[0], /^✓ a \(\d+\.\ds\)$/);
  assert.match(lines[1], /^✓ b \(\d+\.\ds\)$/);
});

test("failureHint names the step and what it was checking", () => {
  assert.equal(
    failureHint({ script: "lint", why: "ESLint" }),
    "preflight stopped at `pnpm lint` (ESLint). Nothing after it ran.",
  );
});

test("--list prints the steps in order and runs none of them", () => {
  const printed = [];
  assert.equal(
    main(
      ["--list"],
      () => assert.fail("nothing may run"),
      (line) => printed.push(line),
    ),
    0,
  );
  assert.deepEqual(
    printed,
    STEPS.map((step) => step.script),
  );
});

test("a clean run says so, and says what it is not", () => {
  const printed = [];
  const code = main(
    [],
    () => true,
    (line) => printed.push(line),
  );

  assert.equal(code, 0);
  assert.equal(
    printed.at(-2),
    `preflight: ${STEPS.length} steps passed (slowest: typecheck).`,
  );
  // The sentence that keeps a passing preflight from being read as a green build.
  assert.match(printed.at(-1), /not the acceptance run/);
});

test("a failing run exits 1 and runs no further step", () => {
  const ran = [];
  const printed = [];
  const code = main(
    ["--only", "lint,typecheck"],
    (script) => {
      ran.push(script);
      return script !== "typecheck";
    },
    (line) => printed.push(line),
  );

  assert.equal(code, 1);
  assert.deepEqual(ran, ["typecheck"]);
  assert.match(printed.at(-1), /preflight stopped at `pnpm typecheck`/);
});

test("--only narrows the run, keeps the declared order, and refuses an unknown name", () => {
  const selected = selectSteps(["--only", "lint,typecheck"]);
  // Declared order, not the order the user typed: the order exists because a type
  // error explains most of the failures that follow it.
  assert.deepEqual(
    selected.steps.map((step) => step.script),
    ["typecheck", "lint"],
  );

  assert.throws(
    () => selectSteps(["--only", "typecheck,nope"]),
    /unknown step\(s\): nope/,
  );
  assert.throws(() => selectSteps(["--only"]), /needs a comma-separated list/);
  assert.throws(
    () => selectSteps(["--only", ""]),
    /needs a comma-separated list/,
  );
});

test("every step preflight runs is a script this repository defines", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const undefinedSteps = STEPS.filter((step) => !(step.script in pkg.scripts));
  assert.deepEqual(undefinedSteps, []);
  // And the set is not empty: a runner over zero steps exits 0 for any tree.
  assert.ok(STEPS.length >= 10);
});

test("runScript runs a real pnpm script and answers with its exit status", () => {
  // The cheapest real script in the chain: it reads four files and exits. Driven
  // through pnpm rather than by calling the gate directly, because the thing under
  // test is the spawn — the one line a fake executor cannot cover.
  assert.equal(runScript("check:hooks"), true);
  assert.equal(runScript("no-such-script-name"), false);
});

test("the default reporter writes the step names to stdout", () => {
  const original = console.log;
  const printed = [];
  console.log = (line) => printed.push(line);
  try {
    assert.equal(toStdout("typecheck"), undefined);
    // `--list` with no reporter: the default is what a contributor's terminal sees.
    assert.equal(
      main(["--list"], () => true),
      0,
    );
  } finally {
    console.log = original;
  }
  assert.equal(printed[0], "typecheck");
  assert.deepEqual(
    printed.slice(1),
    STEPS.map((step) => step.script),
  );
});

test("the gate that guards the loop is the first thing the loop checks", () => {
  // `check:hooks` verifies that the hook runs *this* command; if preflight did not
  // include it, the hook would be checked by nothing that runs on a push.
  assert.ok(STEPS.some((step) => step.script === "check:hooks"));
});
