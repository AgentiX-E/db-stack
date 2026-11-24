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
 * With no arguments it audits every page in `TARGETS`. `--report` points the
 * first of them at another report, which is how a test reaches the branch.`
 *
 * `--write` rewrites the numbers instead of failing, for the iteration that
 * changes the suite.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

/**
 * Every page that states a test total, and the report that decides it.
 *
 * The gate used to know two paths — `node/README.md` and its report — and the
 * other two packages drifted by hundreds of cases with nothing looking: the
 * cluster page claimed 2 116 cases in 131 files while the suite ran 2 350 in
 * 144, and the federation page claimed 363 in 29 while it ran past a thousand.
 * A constant per page is a constant per page to forget, so the pages are a table.
 *
 * `shapes` names the sentence shapes a page uses, because the three pages are
 * not written the same way and rewriting a page to fit a gate is the wrong
 * direction. `modules` is the node page: a headline, a split sentence, a
 * quick-start line and a table of twenty modules. `summary` is the other two: a
 * bold line that totals the suite and the comment beside the command that runs
 * it.
 */
export const TARGETS = [
  {
    page: "node/README.md",
    report: "node/coverage/test-report.json",
    shapes: "modules",
  },
  {
    page: "cluster/README.md",
    report: "cluster/coverage/test-report.json",
    shapes: "summary",
  },
  {
    page: "federation/README.md",
    report: "federation/coverage/test-report.json",
    shapes: "summary",
  },
];

// The integration suite, wherever a package keeps it. It was `src/__tests__/e2e/`
// while every module was its own package; the modules now sit one level deeper
// (`packages/node/src/core/__tests__/e2e/`), and a constant that still required the
// suite to start immediately under `src/` reported zero integration files for a
// suite of nineteen.
const SUITE = "/__tests__/e2e/";

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

/**
 * The module a file counts towards.
 *
 * Two layouts, one function. While the modules were twenty-one packages a file
 * looked like `operations/packages/<package>/src/<module>/…` and the interesting
 * segment was the one after `packages/`. Now they are twenty directories inside
 * one package — `node/src/<module>/…` — and it is the one after `src/`.
 *
 * `packages/` is tried first so a path that still names the old layout (the
 * fixtures in this file's own tests do) resolves the way it always did; a path
 * with no `packages/` segment falls through to `src/`, which is what every real
 * file in this repository now looks like.
 */
function packageOf(file) {
  const nested = /[/\\]packages[/\\]([^/\\]+)[/\\]/.exec(file);
  if (nested) return nested[1];
  const flat = /[/\\]src[/\\]([^/\\]+)[/\\]/.exec(file);
  return flat ? flat[1] : null;
}

/**
 * The two sentences a package page uses when it states one total.
 *
 * A page that lists no modules has nothing to reconcile between a table and a
 * total; what it can get wrong is the total itself, in the two places it says it.
 * Both are checked, because a page that is right in one and wrong in the other
 * is the shape every drift in this repository has had.
 */
export function summaryStatements(total) {
  return [
    {
      id: "summary",
      describe: (values) => `${values[0]} test files, ${values[1]} tests`,
      // "- **131 test files, 2 116 tests** — unit, integration, boundary, …"
      pattern: /-\s*\*\*(\d+)\s+test\s+files,\s*([\d\s,.]+?)\s+tests\*\*/d,
      expected: [String(total.files), formatCount(total.cases)],
    },
    {
      id: "command",
      describe: (values) => `${values[0]} tests, ${values[1]} test files`,
      // "pnpm test                  # 2 116 tests, 131 test files"
      pattern:
        /(?:npm|pnpm) test\s+#\s*([\d\s,.]+?)\s+tests?,\s*(\d+)\s+test\s+files/d,
      expected: [formatCount(total.cases), String(total.files)],
    },
  ];
}

/**
 * Every place the page states a number the run decides.
/**
 * Every place the page states a number the run decides.
 *
 * Each statement carries the pattern that finds it and the values it should
 * hold, **in the order its capture groups appear**. `describe` names the
 * statement in a finding, so the message reads like a sentence about the page
 * rather than an offset.
 */
export function statements(measured, shapes = "modules") {
  const { total, suites } = measured;
  if (shapes === "summary") return summaryStatements(total);
  return [
    {
      id: "headline",
      describe: (values) =>
        `${values[0]} modules, ${values[1]} test cases in ${values[2]} files`,
      // "20 modules, 2 951 test cases in 143 files". `packages` is still accepted:
      // this gate outlived the layout that made it read that way.
      pattern:
        /(\d+)\s+(?:packages|modules),\s+([\d\s,.]+?)\s+test\s+cases\s+in\s+(\d+)\s+files/d,
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
  /^\|\s*\[`([a-z0-9][a-z0-9-]*)`\]\(\.\/(?:packages|src)\/\1\/\)\s*\|[^|]*\|\s*([\d\s,.]+?)\s*\|/dgm;

/**
 * Findings for one page.
 *
 * Returns `findings` (each with `line` and `message`) and `edits` (the rewrites
 * `--write` would apply), so a test can assert both without a temporary file.
 */
export function auditPage(text, measured, options = {}) {
  const shapes = options.shapes ?? "modules";
  const findings = [];
  const edits = [];

  const lineOf = (index) => text.slice(0, index).split("\n").length;

  for (const statement of statements(measured, shapes)) {
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

  // A page with no module table has nothing to reconcile row by row; running the
  // table pass over it would report every module in the run as a row the page
  // forgot, which is twenty findings about a table the page never claimed.
  if (shapes !== "modules") return { findings, edits };

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
  // The tree is a parameter for the same reason the streams are: the default
  // report path is a branch, and the only way to reach it from a test is to point
  // the gate at a tree instead of at this one.
  const base = options.root ?? root;
  const write = options.write ?? argv.includes("--write");

  const at = argv.indexOf("--report");
  if (at !== -1 && argv[at + 1] === undefined) {
    error("✗ test-counts: --report needs a path");
    return 1;
  }
  const override = options.report ?? (at === -1 ? null : resolve(argv[at + 1]));

  // A caller that names a page is auditing a page; a caller that does not is
  // auditing the repository, which is every page in the table. `--report` is the
  // escape hatch for the first page in it, which is the page the gate was written
  // for and the one anybody reaching for the flag means.
  const targets =
    options.targets ??
    (options.page
      ? [
          {
            page: options.page,
            // `--report` is how a caller with a page reaches the branch without
            // naming a report twice; a target with no report at all is a crash,
            // not a finding, so the fallback is the flag rather than undefined.
            report: options.report ?? override,
            shapes: options.shapes ?? "modules",
          },
        ]
      : TARGETS.map((target, index) =>
          index === 0 && override ? { ...target, report: override } : target,
        ));

  const audited = [];
  const missing = [];
  for (const target of targets) {
    const pagePath = options.page ? options.page : resolve(base, target.page);
    const reportPath = isAbsolute(target.report)
      ? target.report
      : resolve(base, target.report);

    const report = loadReport(reportPath);
    if (!report) {
      missing.push({ target, reportPath });
      continue;
    }

    const measured = measure(report);
    const text = readFileSync(pagePath, "utf8");
    const { findings, edits } = auditPage(text, measured, {
      shapes: target.shapes,
    });
    audited.push({
      // A page inside the repository is named the way every other gate names it;
      // one the caller supplied is named by the path the caller supplied.
      page: options.page ? pagePath : target.page,
      pagePath,
      shapes: target.shapes,
      measured,
      findings,
      edits,
    });
  }

  if (missing.length > 0) {
    const named = missing
      .map(({ reportPath }) => relative(base, reportPath))
      .join(", ");
    const first = missing[0].reportPath;
    error(
      `✗ test-counts: no report at ${named}.\n` +
        `The gate counts what a run measured, so it needs a run: ` +
        `\`${coverageCommand(base, first)}\` writes one.`,
    );
    return 1;
  }

  const edits = audited.flatMap((entry) => entry.edits);
  if (write && edits.length > 0) {
    for (const entry of audited) {
      if (entry.edits.length === 0) continue;
      writeFileSync(
        entry.pagePath,
        applyEdits(readFileSync(entry.pagePath, "utf8"), entry.edits),
      );
      log(
        `✎ test-counts: rewrote ${entry.edits.length} number(s) in ${entry.page}`,
      );
    }
    return 0;
  }

  const findings = audited.flatMap((entry) =>
    entry.findings.map((finding) => ({ ...finding, page: entry.page })),
  );
  if (findings.length > 0) {
    error(`✗ test-counts: ${findings.length} finding(s)\n`);
    for (const finding of findings)
      error(`  ${finding.page}:${finding.line} ${finding.message}`);
    error(
      "\nA page that states a number is making a claim about a run. Either the number is right, " +
        "or the sentence that carries it goes.",
    );
    return 1;
  }

  for (const entry of audited) {
    const { total, packages } = entry.measured;
    if (entry.shapes === "modules") {
      log(
        `✓ test-counts: ${formatCount(total.cases)} cases in ${total.files} files ` +
          `over ${packages.size} modules, and the page says so five times`,
      );
    } else {
      log(
        `✓ test-counts: ${entry.page} says ${formatCount(total.cases)} cases in ${total.files} files`,
      );
    }
  }
  return 0;
}

/**
 * The command that writes the report the gate is missing.
 *
 * A gate that says "run coverage" is a gate whose reader has to work out which
 * package. The report path already names it: `cluster/coverage/test-report.json`
 * is written by the filter whose package is `db-cluster`.
 */
export function coverageCommand(base, reportPath) {
  const dir = relative(base, reportPath).split(sep)[0];
  return `pnpm --filter @agentix-e/db-${dir || "node"} run coverage`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
