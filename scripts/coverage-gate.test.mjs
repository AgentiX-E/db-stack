/**
 * Tests for the coverage gate.
 *
 * The gate is the instrument that certifies every other suite, so its own rules
 * are pinned case by case: a package under the floor, a package with no report,
 * a report with no files, a file under one dimension, a file under all four, and
 * the truncation that keeps a bad day readable. Each case asserts the message,
 * because a gate whose failure message does not say *which* file and *which*
 * dimension is a gate somebody will silence.
 *
 * `run()` is driven with a summary map rather than a filesystem where possible —
 * the judgement is what these cases are about, and building four coverage
 * reports to test a comparison would make the test slower than the thing it
 * tests. The last two cases read real files from a temporary root, because the
 * reading is the other half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { spawnSync } from "node:child_process";

import {
  evaluate,
  pct,
  readSummary,
  run,
  summarise,
  worst,
} from "./coverage-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const PACKAGES = [
  { name: "@scope/one", dir: "one" },
  { name: "@scope/two", dir: "two" },
];

/** One file row at `value` on every dimension. */
const above = (path, value) => ({
  path,
  lines: value,
  statements: value,
  functions: value,
  branches: value,
});

/**
 * A summary whose every dimension is `value`.
 *
 * The default is one clean file, because a summary with no files fails for a
 * different reason and would make every case below pass for the wrong one.
 */
const summary = (value, files = [above("one/src/keep.ts", value)]) => ({
  total: {
    lines: value,
    statements: value,
    functions: value,
    branches: value,
    files: files.length,
  },
  files,
});

const summariseThreshold = 95;

test("pct reads both shapes a reporter writes", () => {
  assert.equal(pct(97.5), 97.5);
  assert.equal(pct({ pct: 42, covered: 42, total: 100 }), 42);
  assert.equal(pct(undefined), 0);
});

test("summarise keeps the total, the file count and repository-relative paths", () => {
  const raw = {
    total: { lines: 99, statements: 98, functions: 97, branches: 96 },
    "/repo/cluster/src/a.ts": {
      lines: 100,
      statements: 100,
      functions: 100,
      branches: 100,
    },
    "/repo/cluster/src/b.ts": {
      lines: { pct: 90 },
      statements: 90,
      functions: 90,
      branches: 90,
    },
  };

  const rows = summarise(raw, "/repo");

  assert.deepEqual(rows.total, {
    lines: 99,
    statements: 98,
    functions: 97,
    branches: 96,
    files: 2,
  });
  assert.deepEqual(
    rows.files.map((row) => row.path),
    ["cluster/src/a.ts", "cluster/src/b.ts"],
  );
  assert.equal(rows.files[1].lines, 90);
});

test("worst names the dimension the file is furthest below the floor on", () => {
  assert.equal(
    worst({ lines: 80, statements: 90, functions: 99, branches: 70 }),
    "branches",
  );
  assert.equal(
    worst({ lines: 99, statements: 90, functions: 99, branches: 99 }),
    "statements",
  );
});

test("a workspace where everything meets the floor passes", () => {
  const summaries = new Map([
    ["one", summary(99)],
    ["two", summary(95)],
  ]);

  const { failures, table, detail } = evaluate(
    PACKAGES,
    summaries,
    summariseThreshold,
  );

  assert.deepEqual(failures, []);
  assert.equal(detail, null);
  assert.match(
    table,
    /\| @scope\/one \| 1 \| 99\.00% \| 99\.00% \| 99\.00% \| 99\.00% \| ✅ \|/,
  );
  assert.match(
    table,
    /threshold 95% on lines \/ statements \/ functions \/ branches/,
  );
});

test("a package below the floor fails and names the dimension and the number", () => {
  const summaries = new Map([
    ["one", summary(99)],
    ["two", summary(94.5)],
  ]);

  const { failures, table } = evaluate(PACKAGES, summaries, summariseThreshold);

  // Four package-level dimensions plus the one file those dimensions describe:
  // a summary's rows are judged too, so a package average of 94.5 cannot pass
  // by hiding a file that is below it for the same reason.
  assert.equal(failures.length, 5);
  assert.match(failures[0], /@scope\/two: lines 94\.50% < 95%/);
  assert.match(failures[4], /one\/src\/keep\.ts: lines 94\.50%/);
  assert.match(table, /❌ \|$/m);
});

test("a package with no report is a failure, not a clean sheet", () => {
  const summaries = new Map([["one", summary(99)]]);

  const { failures, table } = evaluate(PACKAGES, summaries, summariseThreshold);

  assert.deepEqual(failures, [
    "@scope/two: coverage summary missing (two/coverage/coverage-summary.json)",
  ]);
  assert.match(
    table,
    /\| @scope\/two \| — \| — \| — \| — \| — \| ❌ no report \|/,
  );
});

test("a report that lists no files measured nothing, so it fails", () => {
  const summaries = new Map([
    ["one", summary(100, [])],
    ["two", summary(100, [])],
  ]);

  const { failures } = evaluate(PACKAGES, summaries, summariseThreshold);

  assert.deepEqual(failures, [
    "@scope/one: the report contains no files, so nothing was measured",
    "@scope/two: the report contains no files, so nothing was measured",
  ]);
});

test("a file below one dimension is listed with that dimension and its number", () => {
  const summaries = new Map([
    [
      "one",
      summary(99, [
        {
          path: "one/src/a.ts",
          lines: 99,
          statements: 99,
          functions: 99,
          branches: 80,
        },
      ]),
    ],
    ["two", summary(99)],
  ]);

  const { failures, detail } = evaluate(
    PACKAGES,
    summaries,
    summariseThreshold,
  );

  assert.deepEqual(failures, ["one/src/a.ts: branches 80.00% < 95%"]);
  assert.match(detail, /\*\*1 file\(s\) below the floor\.\*\*/);
  assert.match(
    detail,
    /\| `one\/src\/a\.ts` \| 99\.00 \| 99\.00 \| 99\.00 \| 80\.00 \| branches \|/,
  );
});

test("a file below all four dimensions is named by its worst one", () => {
  const summaries = new Map([
    [
      "one",
      summary(99, [
        {
          path: "one/src/a.ts",
          lines: 90,
          statements: 20,
          functions: 90,
          branches: 90,
        },
      ]),
    ],
    ["two", summary(99)],
  ]);

  const { failures, detail } = evaluate(
    PACKAGES,
    summaries,
    summariseThreshold,
  );

  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /lines 90\.00%, statements 20\.00%, functions 90\.00%, branches 90\.00%/,
  );
  assert.match(detail, /\| statements \|/);
});

test("the offending table truncates instead of printing a thousand rows", () => {
  const files = Array.from({ length: 63 }, (_, index) => ({
    path: `one/src/f${index}.ts`,
    lines: 50,
    statements: 50,
    functions: 50,
    branches: 50,
  }));
  const summaries = new Map([
    ["one", summary(99, files)],
    ["two", summary(99)],
  ]);

  const { failures, detail } = evaluate(
    PACKAGES,
    summaries,
    summariseThreshold,
  );

  assert.equal(failures.length, 63);
  assert.match(detail, /\| … 3 more \| \| \| \| \| \|/);
});

test("run prints the table and passes when the reports meet the floor", async () => {
  const lines = [];
  const summaries = new Map([
    ["one", summary(97)],
    ["two", summary(97)],
  ]);

  const code = await run([], {
    packages: PACKAGES,
    summaries,
    log: (line) => lines.push(line),
    error: () => assert.fail("no error expected"),
  });

  assert.equal(code, 0);
  assert.match(lines[0], /^Coverage gate — threshold 95%/);
  assert.match(lines.at(-1), /Coverage gate passed/);
});

test("run reports every failure on stderr and exits 1", async () => {
  const errors = [];
  const summaries = new Map([["one", summary(50)]]);

  const code = await run([], {
    packages: PACKAGES,
    summaries,
    log: () => {},
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.equal(errors[0], "\nCoverage gate FAILED:");
  assert.match(errors[1], /^ {2}- @scope\/one: lines 50\.00% < 95%$/);
});

test("run takes the threshold from its argument", async () => {
  const summaries = new Map([
    ["one", summary(92)],
    ["two", summary(92)],
  ]);

  const packages = PACKAGES;
  assert.equal(
    await run(["90"], { packages, summaries, log: () => {}, error: () => {} }),
    0,
  );
  assert.equal(
    await run(["95"], { packages, summaries, log: () => {}, error: () => {} }),
    1,
  );
});

test("run falls back to the threshold in the environment", async () => {
  const summaries = new Map([
    ["one", summary(92)],
    ["two", summary(92)],
  ]);
  const previous = process.env.COVERAGE_THRESHOLD;
  process.env.COVERAGE_THRESHOLD = "90";
  try {
    assert.equal(
      await run([], {
        packages: PACKAGES,
        summaries,
        log: () => {},
        error: () => {},
      }),
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.COVERAGE_THRESHOLD;
    else process.env.COVERAGE_THRESHOLD = previous;
  }
});

test("run reads the summaries vitest wrote, and calls a package that wrote none missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-gate-"));
  try {
    mkdirSync(join(root, "cluster", "coverage"), { recursive: true });
    writeFileSync(
      join(root, "cluster", "coverage", "coverage-summary.json"),
      JSON.stringify({
        total: { lines: 99, statements: 99, functions: 99, branches: 99 },
        [`${root}/cluster/src/a.ts`]: {
          lines: 99,
          statements: 99,
          functions: 99,
          branches: 99,
        },
      }),
    );

    // The real package list, so the read path is exercised for all four entries
    // and the three that are absent report themselves.
    const summaryFor = await readSummary(root, "cluster");
    assert.equal(summaryFor.total.files, 1);
    assert.deepEqual(summaryFor.files[0].path, "cluster/src/a.ts");
    assert.equal(await readSummary(root, "federation"), null);

    const errors = [];
    const code = await run([], {
      root,
      log: () => {},
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.match(
      errors.join("\n"),
      /@agentix-e\/db-federation: coverage summary missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarise tolerates a report with no total row", () => {
  const rows = summarise(
    {
      "/repo/a.ts": {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
    "/repo",
  );

  assert.deepEqual(rows.total, {
    lines: 0,
    statements: 0,
    functions: 0,
    branches: 0,
    files: 1,
  });
});

test("the threshold defaults to 95 when neither the argument nor the environment sets one", async () => {
  const summaries = new Map([
    ["one", summary(94)],
    ["two", summary(94)],
  ]);
  const previous = process.env.COVERAGE_THRESHOLD;
  delete process.env.COVERAGE_THRESHOLD;
  try {
    assert.equal(
      await run([], {
        packages: PACKAGES,
        summaries,
        log: () => {},
        error: () => {},
      }),
      1,
    );
  } finally {
    if (previous !== undefined) process.env.COVERAGE_THRESHOLD = previous;
  }
});

test("the command line exits with the gate's verdict", () => {
  // An impossible threshold, so the verdict does not depend on which reports
  // happen to exist on the machine running the test.
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/coverage-gate.mjs"), "101"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 1);
  assert.match(child.stdout, /Coverage gate — threshold 101%/);
  assert.match(child.stderr, /Coverage gate FAILED/);
});
