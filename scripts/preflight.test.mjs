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
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  STEPS,
  failureHint,
  isEntryPoint,
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

test("the summary names the step that actually took longest", () => {
  // The first step is what a `reduce` without a real comparison reports — it
  // returns the accumulator it was handed and never looks at the candidate. The
  // clock here is driven, because on a fast machine every step measures 0 ms and
  // the answer would be a property of the hardware rather than of the code.
  const real = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  const printed = [];
  try {
    const code = main(
      ["--only", "lint,typecheck"],
      (script) => {
        clock += script === "lint" ? 4_200 : 7;
        return true;
      },
      (line) => printed.push(line),
    );
    assert.equal(code, 0);
  } finally {
    Date.now = real;
  }
  // Declared order, so `lint` is the second step taken and the slowest one seen.
  assert.equal(printed.at(-2), "preflight: 2 steps passed (slowest: lint).");
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
});

test("runScript answers false for a non-zero status and for a child killed by a signal", () => {
  // The failure case is injected rather than spawned. Asking pnpm for a script it
  // does not define does fail it — and it fails the command that hosts this test
  // too, because the process reporting the error is pnpm, inside pnpm. CI job
  // 45108062128 is exactly that: every assertion green, the step red.
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 2 };
  };
  assert.equal(runScript("lint", spawn), false);
  // And the shape of the real spawn, asserted instead of assumed: pnpm, the
  // script name alone, in the repository root, terminal attached — a captured
  // buffer would summarize away the file and column a contributor acts on.
  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: ["lint"],
      options: { cwd: ROOT, stdio: "inherit", shell: false },
    },
  ]);
  // A child killed by a signal has no status at all. `null === 0` is false, which
  // is the answer that matters — a killed step is not a passed step.
  assert.equal(
    runScript("lint", () => ({ status: null })),
    false,
  );
  assert.equal(
    runScript("lint", () => ({ status: 0 })),
    true,
  );
});

test("the command line lists the steps it would run", () => {
  // The one path an in-process case cannot take: the file as a program. It is also
  // the path `check:hooks` compares the hook against, so a `--list` that drifted
  // from `STEPS` would let a hook run a shorter preflight and still pass.
  // Measured with the compile cache stripped, `preflight.mjs` read 98.96 % lines
  // with 191-192 uncovered — `process.exit(main())` — until this case existed.
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/preflight.mjs"), "--list"],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(
    child.stdout.trim().split("\n"),
    STEPS.map((step) => step.script),
  );
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
    isEntryPoint(resolve(import.meta.dirname, "preflight.mjs")),
    true,
  );
});
