/**
 * Tests for the gate that measures the gates.
 *
 * Two halves. `parseTable` reads what Node prints — every case feeds it the real
 * format, because a parser tested against a format invented in the test proves
 * nothing. `check` decides, and it decides from rows written here, so each of
 * the six rules can be exercised on its own: a script with no test, a debt that
 * was paid, a debt that grew, a file that reached the floor, a file that fell
 * under it, and an entry for a script that no longer exists.
 *
 * The last case runs the whole gate over this repository. It is the one that
 * would catch a table format change, a script added without a test, and a
 * baseline that has gone stale — the three failures this gate exists to see.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  BELOW_FLOOR,
  NESTED,
  UNMEASURED,
  check,
  isEntryPoint,
  measure,
  parseTable,
  run,
  scripts,
} from "./check-script-coverage.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const row = (lines, branches, functions) => ({ lines, branches, functions });

test("the script list is the gates, not their tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    for (const name of ["b.mjs", "a.mjs", "a.test.mjs", "notes.md"]) {
      writeFileSync(join(dir, "scripts", name), "");
    }

    assert.deepEqual(scripts(dir), ["a.mjs", "b.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the table Node prints is read, and everything else in its output is not", () => {
  const output = [
    "# tests 99",
    "# start of coverage report",
    "# -----------------------------------------------------------------------",
    "# file                   | line % | branch % | funcs % | uncovered lines",
    "# -----------------------------------------------------------------------",
    "# scripts                |        |          |         | ",
    "#  check-english.mjs     | 100.00 |    96.81 |  100.00 | ",
    "#  check-docs-api.mjs    |  98.81 |    95.33 |   97.37 | 555-562",
    "#  check-script-bins.mjs |  83.43 |    84.00 |   77.78 | 111-119 147-165",
    "# -----------------------------------------------------------------------",
    "# all files              |  93.56 |    88.89 |   96.25 | ",
    "# -----------------------------------------------------------------------",
  ].join("\n");

  const rows = parseTable(output);

  assert.deepEqual(
    [...rows.keys()],
    ["check-english.mjs", "check-docs-api.mjs", "check-script-bins.mjs"],
  );
  assert.deepEqual(rows.get("check-docs-api.mjs"), row(98.81, 95.33, 97.37));
  assert.equal(rows.has("scripts"), false, "the group heading is not a file");
  assert.equal(rows.has("all files"), false, "the totals are not a file");
});

test("a script no test loads is a finding that says so", () => {
  const { findings, debt } = check(["gate.mjs"], new Map(), {
    unmeasured: [],
    belowFloor: [],
  });

  assert.equal(findings.length, 1);
  assert.match(findings[0], /gate\.mjs: no test loads it/);
  assert.match(
    findings[0],
    /A gate with no test is a script that prints "passed"/,
  );
  assert.deepEqual(debt, []);
});

test("a listed script that no test loads is reported as debt, not as a pass", () => {
  const { findings, debt } = check(["gate.mjs"], new Map(), {
    unmeasured: [
      { file: "gate.mjs", reason: "reads a workspace", roadmap: "P3-45" },
    ],
    belowFloor: [],
  });

  assert.deepEqual(findings, []);
  assert.deepEqual(debt, ["gate.mjs: unmeasured (P3-45) — reads a workspace"]);
});

test("a debt that was paid fails the gate until the entry is deleted", () => {
  const { findings } = check(
    ["gate.mjs"],
    new Map([["gate.mjs", row(99, 99, 99)]]),
    {
      unmeasured: [
        { file: "gate.mjs", reason: "was unmeasured", roadmap: "P3-45" },
      ],
      belowFloor: [],
    },
  );

  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /is listed as unmeasured and appears in the coverage report/,
  );
  assert.match(findings[0], /delete the entry from UNMEASURED/);
});

test("a measured file under the floor is a finding that names the dimension", () => {
  const { findings } = check(
    ["gate.mjs"],
    new Map([["gate.mjs", row(99, 80, 99)]]),
    {
      unmeasured: [],
      belowFloor: [],
    },
  );

  assert.deepEqual(findings, ["gate.mjs: branches 80.00% < 95%"]);
});

test("a recorded gap passes while it holds, and is printed as debt", () => {
  const { findings, debt } = check(
    ["walk.mjs"],
    new Map([["walk.mjs", row(100, 93.94, 100)]]),
    {
      unmeasured: [],
      belowFloor: [
        {
          file: "walk.mjs",
          dimension: "branches",
          measured: 93.94,
          reason: "defensive branches",
          roadmap: "P3-44",
        },
      ],
    },
  );

  assert.deepEqual(findings, []);
  assert.deepEqual(debt, [
    "walk.mjs: branches 93.94% (floor 95%, recorded 93.94%) — P3-44",
  ]);
});

test("a gap that grew is a finding, because a debt may not grow", () => {
  const { findings } = check(
    ["walk.mjs"],
    new Map([["walk.mjs", row(100, 92, 100)]]),
    {
      unmeasured: [],
      belowFloor: [
        {
          file: "walk.mjs",
          dimension: "branches",
          measured: 93.94,
          reason: "defensive branches",
          roadmap: "P3-44",
        },
      ],
    },
  );

  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /branches fell from the recorded 93\.94% to 92\.00%\. A debt may not grow\./,
  );
});

test("a gap that closed fails the gate until the entry is deleted", () => {
  const { findings } = check(
    ["walk.mjs"],
    new Map([["walk.mjs", row(100, 96, 100)]]),
    {
      unmeasured: [],
      belowFloor: [
        {
          file: "walk.mjs",
          dimension: "branches",
          measured: 93.94,
          reason: "defensive branches",
          roadmap: "P3-44",
        },
      ],
    },
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0], /now meets the floor on every dimension/);
  assert.match(findings[0], /Delete its entry from BELOW_FLOOR/);
});

test("an entry for a script that no longer exists is a finding in both lists", () => {
  const { findings } = check([], new Map(), {
    unmeasured: [
      { file: "gone.mjs", reason: "was unmeasured", roadmap: "P3-45" },
    ],
    belowFloor: [
      {
        file: "also-gone.mjs",
        dimension: "branches",
        measured: 90,
        reason: "was low",
        roadmap: "P3-44",
      },
    ],
  });

  assert.equal(findings.length, 2);
  assert.match(
    findings[0],
    /gone\.mjs: listed as unmeasured and there is no such script/,
  );
  assert.match(
    findings[1],
    /also-gone\.mjs: recorded below the floor and there is no such script/,
  );
});

test("run prints the table, the debt and the verdict", () => {
  const output = [
    "#  clean.mjs | 100.00 |  99.00 |  100.00 |",
    "#  walk.mjs  | 100.00 |  93.94 |  100.00 |",
  ].join("\n");
  const lines = [];
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    for (const name of ["clean.mjs", "walk.mjs"])
      writeFileSync(join(dir, "scripts", name), "");

    const code = run({
      root: dir,
      output,
      unmeasured: [],
      belowFloor: [
        {
          file: "walk.mjs",
          dimension: "branches",
          measured: 93.94,
          reason: "defensive branches",
          roadmap: "P3-44",
        },
      ],
      log: (line) => lines.push(line),
    });

    assert.equal(code, 0);
    assert.match(
      lines[0],
      // The engine is named with the number: V8's branch accounting changed inside
      // the 22.x line, so a percentage without its ruler is not comparable.
      new RegExp(
        `Script coverage on v${process.versions.node} — floor 95% on lines / branches / functions, 2 script\\(s\\)`,
      ),
    );
    assert.match(
      lines.join("\n"),
      /\| `clean\.mjs` \| 100\.00 \| 99\.00 \| 100\.00 \|/,
    );
    assert.match(
      lines.join("\n"),
      /\*\*1 known gap\(s\), each with a roadmap id\.\*\*/,
    );
    assert.match(
      lines.join("\n"),
      /✓ script-coverage: 2 scripts accounted for, 1 known gap\(s\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run prints a missing script as an empty row rather than dropping it", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "orphan.mjs"), "");
    const lines = [];
    const errors = [];
    const code = run({
      root: dir,
      output: "",
      unmeasured: [],
      belowFloor: [],
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.match(lines.join("\n"), /\| `orphan\.mjs` \| — \| — \| — \|/);
    assert.match(errors[0], /✗ script-coverage: 1 finding\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's own bookkeeping accounts for every gate", () => {
  // No `unmeasured` / `belowFloor` override: this is the gate's real bookkeeping
  // read over the gate's real file list. A script added without a test fails here
  // as well as in CI, and a debt that was paid fails the paid-debt rule.
  const files = scripts(ROOT);
  const rows = new Map(files.map((file) => [file, row(100, 100, 100)]));

  const { findings, debt } = check(files, rows);

  // Every gate the repository has, measured, with neither a hole nor a recorded
  // debt. Both lists being empty is the claim: `UNMEASURED` said "no test loads
  // this" of six scripts two iterations ago, and `BELOW_FLOOR` held the one table
  // whose probes could only run in a job with a build.
  assert.deepEqual(findings, []);
  assert.deepEqual(debt, []);
  assert.ok(
    files.length >= 15,
    `expected every gate to be judged, got ${files.length}`,
  );
});

test("both debt lists are empty, and a file that leaves the tree empties them", () => {
  assert.deepEqual(
    UNMEASURED.map((entry) => entry.file),
    [],
    "a gate with no test is a script that prints passed",
  );
  assert.deepEqual(
    BELOW_FLOOR.map((entry) => entry.file),
    [],
  );

  // The rule that keeps an emptied list from being decoration: an entry naming a
  // file that no longer exists is a finding, so a list cannot survive the code it
  // described by being ignored. Asserted through the gate's own judgement rather
  // than by reading the source.
  const { findings } = check(
    ["kept.mjs"],
    new Map([["kept.mjs", row(100, 100, 100)]]),
    {
      unmeasured: [
        { file: "gone.mjs", reason: "it was deleted", roadmap: "P9-99" },
      ],
      belowFloor: [
        {
          file: "also-gone.mjs",
          dimension: "functions",
          measured: 10,
          reason: "x",
          roadmap: "P9-98",
        },
      ],
    },
  );

  assert.deepEqual(findings, [
    "gone.mjs: listed as unmeasured and there is no such script. Remove the entry.",
    "also-gone.mjs: recorded below the floor and there is no such script. Remove the entry.",
  ]);
});

test("run measures when no output is handed to it, and the measurement is isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  const calls = [];
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "gate.mjs"), "");
    writeFileSync(join(dir, "scripts", "gate.test.mjs"), "");

    // The ambient test context is what a nested run inherits, and a child that
    // inherits it skips every file and measures nothing. Reproduce it here so the
    // stripping is guarded rather than assumed.
    const before = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = "child";
    const lines = [];
    let code;
    try {
      code = run({
        root: dir,
        exec: (bin, args, options) => {
          calls.push({ bin, args, options });
          return "#  gate.mjs  | 100.00 | 100.00 | 100.00 | \n";
        },
        log: (line) => lines.push(line),
        error: () => {},
        unmeasured: [],
        belowFloor: [],
      });
    } finally {
      if (before === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = before;
    }

    assert.equal(code, 0);
    assert.match(
      lines.join("\n"),
      /✓ script-coverage: 1 scripts accounted for/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, process.execPath);
    assert.ok(calls[0].args.includes("--test"));
    assert.ok(calls[0].args.includes("--test-coverage-include=scripts/*.mjs"));
    assert.ok(
      calls[0].args.includes("--test-coverage-exclude=scripts/*.test.mjs"),
    );
    assert.equal(calls[0].options.env[NESTED], "1");
    assert.equal("NODE_TEST_CONTEXT" in calls[0].options.env, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a suite that did not pass is reported with its output and fails the gate", () => {
  const errors = [];
  const code = run({
    output: "# fail 2\nnot ok 7 - something\n__TESTS_FAILED__\n",
    error: (line) => errors.push(line),
    log: () => {},
  });

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /not ok 7 - something/);
  assert.match(
    errors.join("\n"),
    /the suite did not pass, so there is nothing to measure/,
  );
});

test("the entry check answers for this module, another file, and no file at all", () => {
  // The comparison is against this gate's own URL, so the case that must be true
  // is the gate's own path — the same string `process.argv[1]` carries in CI.
  assert.equal(
    isEntryPoint(resolve(ROOT, "scripts/check-script-coverage.mjs")),
    true,
  );
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/check-english.mjs")), false);
  assert.equal(isEntryPoint(undefined), false);
});

test("measure reports a failing suite as a failed gate, not as missing coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "gate.mjs"),
      "export const ok = true;\n",
    );
    writeFileSync(
      join(dir, "scripts", "gate.test.mjs"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
        'test("this one is wrong on purpose", () => {\n  assert.equal(1, 2);\n});\n',
    );

    // A suite that fails is not a suite that covered nothing: the difference
    // matters, because only one of the two is fixed by writing more tests.
    const output = measure(dir);
    assert.match(output, /__TESTS_FAILED__/);
    assert.match(output, /# fail 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measure rethrows a failure that is not a test failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-coverage-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // No captured streams on purpose: a spawn that never started has nothing to
    // say, and that is exactly the shape the gate must not mistake for a suite
    // that ran and failed.
    const boom = new Error("node could not start");

    assert.throws(
      () =>
        measure(dir, {
          exec: () => {
            throw boom;
          },
        }),
      /node could not start/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the command line measures this repository's gates",
  {
    skip: process.env[NESTED]
      ? "the gate started this run; a suite cannot re-run itself"
      : false,
  },
  () => {
    // The whole gate, over the real scripts: the tests must pass, every script
    // must be accounted for, and every recorded gap must still be true.
    const child = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/check-script-coverage.mjs")],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600_000,
      },
    );

    assert.equal(child.status, 0, child.stderr.slice(-4000));
    assert.match(child.stdout, /✓ script-coverage: \d+ scripts accounted for/);
  },
);
