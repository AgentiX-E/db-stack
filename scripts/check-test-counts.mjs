#!/usr/bin/env node
/**
 * check-test-counts — the numbers a page states are the numbers a run produced.
 *
 * `operations/README.md` states its test totals four times: the headline, the
 * per-package table, the sentence under it, and the `npm test` line in the
 * testing section. It also states the unit/integration split. In iteration 54
 * those five statements disagreed with each other *and* with the runner — the
 * header said 3 149 cases in 146 files, the sentence said 2 956 in 128, the
 * truth was 3 155 in 147 — and per-package cells were wrong by an order of
 * magnitude in both directions (`core` 22 for 549, `audit` 20 for 209).
 *
 * Nothing compared them, because a number in prose has no compiler. This gate
 * is that compiler. It reads the machine-readable report the coverage job
 * already produces (`vitest --reporter=json`), counts cases per package and per
 * suite, and fails when any of the five statements disagrees.
 *
 * The rule is deliberately narrow: **only numbers that describe the run**. A
 * page may say "3 155" once and "2 824" once; it may not say 3 149 and mean
 * 3 155, because a reader who checks the claim finds it false and stops
 * believing the rest of the page.
 *
 * Usage:
 *   node scripts/check-test-counts.mjs [--report <path>] [--write]
 *
 * `--write` rewrites the numbers instead of failing, for the iteration that
 * changes the suite.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const PAGE = "operations/README.md";
const REPORT = "operations/coverage/test-report.json";
const SUITE = "src/__tests__/e2e/";

/** A count as a page writes it: `3 155`, `3,155`, `3155`, `2 824`. */
export function parseCount(text) {
  const digits = String(text).replace(/[\s,.\u00a0\u2009\u202f]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

/**
 * A count as this page writes it.
 *
 * The page groups thousands with a space — `3 155`, not `3155` and not
 * `3,155` — because that is how it was written when the numbers were true, and
 * a gate that reformats a page it was asked to check is a gate that makes noise
 * in every diff. `--write` emits exactly this shape.
 */
export function formatCount(value) {
  const digits = String(value);
  if (digits.length < 4) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Cases and files per package, and per suite, from one `vitest` JSON report.
 *
 * `owner` maps a test file to the package it belongs to; a file that maps to
 * nothing is returned under `unowned` rather than dropped, because a suite that
 * grows outside every package is a fact the page cannot describe and the gate
 * should not hide.
 */
export function measure(report, owner = packageOf) {
  const packages = new Map();
  const unowned = [];
  const suites = {
    unit: { files: 0, cases: 0 },
    integration: { files: 0, cases: 0 },
  };

  for (const file of report.testResults ?? []) {
    // A file that failed to collect reports `assertionResults: undefined` and
    // still counts as a file. Counting it as zero cases is the honest reading:
    // it contributed no test, and the run that produced this report was red.
    const cases = file.assertionResults?.length ?? 0;
    const name = owner(file.name);
    if (!name) {
      unowned.push({ path: file.name, cases });
    } else {
      const entry = packages.get(name) ?? { cases: 0, files: 0 };
      entry.cases += cases;
      entry.files += 1;
      packages.set(name, entry);
    }
    const suite = file.name.includes(SUITE) ? "integration" : "unit";
    suites[suite].files += 1;
    suites[suite].cases += cases;
  }

  const total = { cases: 0, files: 0 };
  for (const entry of packages.values()) {
    total.cases += entry.cases;
    total.files += entry.files;
  }
  for (const entry of unowned) {
    total.cases += entry.cases;
    total.files += 1;
  }

  return { packages, suites, total, unowned };
}

/** `operations/packages/core/src/…` → `core`, in either separator. */
function packageOf(file) {
  const match = /[/\\]packages[/\\]([^/\\]+)[/\\]/.exec(file);
  return match ? match[1] : null;
}

/**
 * Every place the page states a number the run decides.
 *
 * Each statement carries the pattern that finds it and the values it should
 * hold, **in the order its capture groups appear**. `describe` names the
 * statement in a finding, so the message reads like a sentence about the page
 * rather than an offset.
 */
export function statements(measured) {
  const { total, suites } = measured;
  return [
    {
      id: "headline",
      describe: (values) =>
        `${values[0]} packages, ${values[1]} test cases in ${values[2]} files`,
      // "21 packages, 3 155 test cases in 147 files"
      pattern:
        /(\d+)\s+packages,\s+([\d\s,.]+?)\s+test\s+cases\s+in\s+(\d+)\s+files/d,
      expected: [
        String(measured.packages.size),
        formatCount(total.cases),
        String(total.files),
      ],
    },
    {
      id: "total",
      describe: (values) =>
        `${values[0]} files and ${values[1]} tests, unit ${values[2]} files / ${values[3]}, ` +
        `integration ${values[4]} files / ${values[5]}`,
      // "reports 147 files and 3 155 tests, 0 failures (`test:unit`: 128 files /
      //  2 824; `test:integration`: 19 files / 331)"
      pattern:
        /reports\s+(\d+)\s+files\s+and\s+([\d\s,.]+?)\s+tests?,\s+0\s+failures[^(`]*\(`test:unit`:\s*(\d+)\s+files\s*\/\s*([\d\s,.]+?);\s*`test:integration`:\s*(\d+)\s+files\s*\/\s*([\d\s,.]+?)\)/d,
      expected: [
        String(total.files),
        formatCount(total.cases),
        String(suites.unit.files),
        formatCount(suites.unit.cases),
        String(suites.integration.files),
        formatCount(suites.integration.cases),
      ],
    },
    {
      id: "quick-start",
      describe: (values) =>
        `npm test runs ${values[0]} files, ${values[1]} tests`,
      // "npm test              # 147 files, 3 155 tests"
      pattern: /npm test\s+#\s*(\d+)\s+files,\s*([\d\s,.]+?)\s+tests/d,
      expected: [String(total.files), formatCount(total.cases)],
    },
  ];
}

const ROW =
  /^\|\s*\[`([a-z0-9][a-z0-9-]*)`\]\(\.\/packages\/\1\/\)\s*\|[^|]*\|\s*([\d\s,.]+?)\s*\|/dgm;

/**
 * Findings for one page.
 *
 * Returns `findings` (each with `line` and `message`) and `edits` (the rewrites
 * `--write` would apply), so a test can assert both without a temporary file.
 */
export function auditPage(text, measured) {
  const findings = [];
  const edits = [];

  const lineOf = (index) => text.slice(0, index).split("\n").length;

  for (const statement of statements(measured)) {
    const match = statement.pattern.exec(text);
    if (!match) {
      findings.push({
        line: 1,
        message:
          `no longer states ${statement.describe(statement.expected)} anywhere the gate reads it. ` +
          `A statement the gate cannot find is a statement it cannot check, so the page has to keep ` +
          `the sentence it makes a claim in.`,
      });
      continue;
    }

    for (let index = 0; index < statement.expected.length; index += 1) {
      const actual = match[index + 1];
      const expected = statement.expected[index];
      if (parseCount(actual) === parseCount(expected)) continue;
      findings.push({
        line: lineOf(match.index),
        message:
          `says \`${actual}\` where the run reports \`${expected}\` ` +
          `(${statement.describe(statement.expected)}).`,
      });
      // `indices` with the `d` flag are absolute offsets into the page, not
      // offsets into the match: adding `match.index` moved every edit forward
      // by the match's own position and rewrote prose the page never mentioned.
      if (match.indices) {
        const [start, end] = match.indices[index + 1];
        edits.push({ start, end, text: expected });
      }
    }
  }

  const rows = new Map();
  for (const row of text.matchAll(ROW)) {
    const name = row[1];
    if (rows.has(name)) {
      findings.push({
        line: lineOf(row.index),
        message: `lists \`${name}\` twice; the second row is a package the reader counts twice.`,
      });
      continue;
    }
    rows.set(name, {
      cases: row[2],
      line: lineOf(row.index),
      indices: row.indices[2],
    });
  }

  for (const [name, row] of rows) {
    const actual = measured.packages.get(name);
    if (!actual) {
      findings.push({
        line: row.line,
        message:
          `lists \`${name}\` with ${parseCount(row.cases)} test case(s), and no test file in the run ` +
          `lives under \`packages/${name}/\`.`,
      });
      continue;
    }
    if (parseCount(row.cases) !== actual.cases) {
      findings.push({
        line: row.line,
        message: `says \`${name}\` has ${parseCount(row.cases)} test case(s); the run reports ${actual.cases}.`,
      });
      const [start, end] = row.indices;
      edits.push({ start, end, text: String(actual.cases) });
    }
  }

  for (const [name, entry] of measured.packages) {
    if (rows.has(name)) continue;
    findings.push({
      line: 1,
      message: `has a package \`${name}\` with ${entry.cases} test case(s) and no row in the table.`,
    });
  }

  for (const file of measured.unowned) {
    findings.push({
      line: 1,
      message:
        `runs \`${relative(root, file.path)}\`, which belongs to no package, so no row can describe ` +
        `it and the table no longer adds up to the total.`,
    });
  }

  return { findings, edits };
}

/** Apply non-overlapping edits, right to left, without moving earlier offsets. */
export function applyEdits(text, edits) {
  let output = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

export function loadReport(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The command line, with its inputs and its two output streams injectable.
 *
 * A gate that can only be run as a process can only be tested by starting one,
 * and a test that starts a process asserts on formatted text. Passing the page,
 * the report and the sinks in turns every branch of this function into a case
 * that asserts a sentence.
 */
export function run(argv = process.argv.slice(2), options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const pagePath = options.page ?? resolve(root, PAGE);
  const write = options.write ?? argv.includes("--write");

  const at = argv.indexOf("--report");
  if (at !== -1 && argv[at + 1] === undefined) {
    error("✗ test-counts: --report needs a path");
    return 1;
  }
  const reportPath =
    options.report ??
    (at === -1 ? resolve(root, REPORT) : resolve(argv[at + 1]));

  const report = loadReport(reportPath);
  if (!report) {
    error(
      `✗ test-counts: no report at ${relative(root, reportPath)}.\n` +
        `The gate counts what a run measured, so it needs a run: ` +
        `\`pnpm --filter @agentix-e/db-operations run coverage\` writes one.`,
    );
    return 1;
  }

  const measured = measure(report);
  const text = readFileSync(pagePath, "utf8");
  const { findings, edits } = auditPage(text, measured);
  // A page inside the repository is named the way every other gate names it;
  // one the caller supplied is named by the path the caller supplied.
  const page = options.page ? pagePath : PAGE;

  if (write && edits.length > 0) {
    writeFileSync(pagePath, applyEdits(text, edits));
    log(`✎ test-counts: rewrote ${edits.length} number(s) in ${page}`);
    return 0;
  }

  if (findings.length > 0) {
    error(`✗ test-counts: ${findings.length} finding(s)\n`);
    for (const finding of findings)
      error(`  ${page}:${finding.line} ${finding.message}`);
    error(
      "\nA page that states a number is making a claim about a run. Either the number is right, " +
        "or the sentence that carries it goes.",
    );
    return 1;
  }

  log(
    `✓ test-counts: ${formatCount(measured.total.cases)} cases in ${measured.total.files} files ` +
      `over ${measured.packages.size} packages, and the page says so five times`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
