#!/usr/bin/env node
/**
 * check-script-coverage — the gates measure the repository; this measures the gates.
 *
 * `pnpm test:scripts` has run 99 cases for several iterations, and until now
 * nobody could say what they covered. Running the suite with Node's own coverage
 * answered the question the wrong way round: the report listed **six** files,
 * because a coverage report names the files that were loaded, and six of the
 * thirteen gate scripts are never loaded by any test. A suite can therefore lose
 * all coverage of a script and the report gets *shorter*, not redder — the same
 * shape as the documentation gate that skipped packages with no `docs/`.
 *
 * So the rule here is not "each file that appears in the report meets the floor".
 * It is:
 *
 *   1. every `scripts/*.mjs` file is *accounted for* — either it appears in the
 *      report, or it is listed in `UNMEASURED` with a reason and a roadmap id;
 *   2. every measured file meets 95 % on lines, branches and functions;
 *   3. an entry in either list that is no longer true fails the gate: a debt
 *      that was paid must be deleted, and a debt that grew must be seen.
 *
 * The third rule is what keeps the lists from becoming decoration. `audit-policy`
 * learned the same lesson about a stale advisory allowlist: an exception nobody
 * re-checks is an exception that outlives its reason.
 *
 * Usage:
 *   node scripts/check-script-coverage.mjs            # run the suite and judge it
 *
 * There is no mode that judges a *previous* run, and that is deliberate: a saved
 * coverage table is a claim about a moment that has passed. The numbers this gate
 * acts on are the numbers the suite just produced.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const FLOOR = 95;

/**
 * Scripts no test loads, and why.
 *
 * This is a debt list, not an allowlist: `check` below fails when an entry is
 * paid, so the only way to keep a line here is to keep the reason true. It is
 * empty, and empty is the state worth defending: `check-package.mjs` was the last
 * entry, and it was there because importing it *ran* the check.
 */
export const UNMEASURED = [];

/**
 * Files that are measured and below the floor, with the number recorded.
 *
 * The recorded value is a ratchet: the gate fails when the file drops beneath
 * it, and fails when the file reaches the floor without the entry being
 * deleted. `--report` prints the current numbers so the entry can be updated.
 */
export const BELOW_FLOOR = [
  {
    file: "package-targets.mjs",
    // Functions, not lines. The uncovered code is three `behaviour` closures and
    // nothing else: they call the built artefact, the Quality job has no `dist/`,
    // and a fixture standing in for the artefact would be a test of the fixture.
    // They run in the E2E job, after `pnpm build`, where there is something to
    // call. Functions is the dimension that names that debt exactly and cannot
    // move for a reason unrelated to it — a line count for a data table shifts
    // with which cases read it, and a ratchet that wobbles teaches people to
    // re-record it without reading it.
    dimension: "functions",
    measured: 0,
    reason:
      "three `behaviour` closures call the built artefact, so the only process that can reach them is " +
      "one that has `dist/`",
    roadmap: "P3-46",
  },
];

const DIMENSIONS = ["lines", "branches", "functions"];

/** Every file this gate is about: the scripts, minus the tests themselves. */
export function scripts(root = ROOT) {
  return readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort();
}

/**
 * Rows of the coverage table Node prints after a `--experimental-test-coverage`
 * run.
 *
 * `#  check-english.mjs | 100.00 | 96.81 | 100.00 |` — the leading `#` and the
 * variable spacing are Node's, and the last column (uncovered line ranges) is
 * optional and not read.
 */
export function parseTable(output) {
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match =
      /^#\s+(\S+\.mjs)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s*\|/.exec(
        line,
      );
    if (!match) continue;
    rows.set(match[1], {
      lines: Number(match[2]),
      branches: Number(match[3]),
      functions: Number(match[4]),
    });
  }
  return rows;
}

/**
 * The judgement, as a function of what was measured.
 *
 * `rows` maps a script file name to its three percentages; `files` is what is on
 * disk. Everything the gate decides is decided here, so a test can write a row
 * instead of producing one.
 */
export function check(files, rows, options = {}) {
  const floor = options.floor ?? FLOOR;
  const unmeasured = options.unmeasured ?? UNMEASURED;
  const belowFloor = options.belowFloor ?? BELOW_FLOOR;

  const findings = [];
  const debt = [];

  const listed = new Map(unmeasured.map((entry) => [entry.file, entry]));
  const excused = new Map(belowFloor.map((entry) => [entry.file, entry]));

  for (const file of files) {
    const row = rows.get(file);
    if (!row) {
      const entry = listed.get(file);
      if (!entry) {
        findings.push(
          `${file}: no test loads it, so nothing measured it. A gate with no test is a script ` +
            `that prints "passed".`,
        );
        continue;
      }
      debt.push(`${file}: unmeasured (${entry.roadmap}) — ${entry.reason}`);
      continue;
    }

    // The entry is paid: the file is measured now, so the excuse has to go.
    if (listed.has(file)) {
      findings.push(
        `${file}: is listed as unmeasured and appears in the coverage report. The debt is paid — ` +
          `delete the entry from UNMEASURED.`,
      );
      continue;
    }

    const short = DIMENSIONS.filter((dimension) => row[dimension] < floor);
    const entry = excused.get(file);

    if (short.length === 0) {
      if (entry) {
        findings.push(
          `${file}: now meets the floor on every dimension (${DIMENSIONS.map((d) => `${d} ${row[d].toFixed(2)}`).join(", ")}). ` +
            `Delete its entry from BELOW_FLOOR — a paid debt that stays on the books hides the next one.`,
        );
      }
      continue;
    }

    if (!entry) {
      findings.push(
        `${file}: ${short.map((dimension) => `${dimension} ${row[dimension].toFixed(2)}%`).join(", ")} < ${floor}%`,
      );
      continue;
    }

    const current = row[entry.dimension];
    if (current + 0.005 < entry.measured) {
      findings.push(
        `${file}: ${entry.dimension} fell from the recorded ${entry.measured.toFixed(2)}% to ` +
          `${current.toFixed(2)}%. A debt may not grow.`,
      );
      continue;
    }
    debt.push(
      `${file}: ${entry.dimension} ${current.toFixed(2)}% (floor ${floor}%, recorded ${entry.measured.toFixed(2)}%) — ${entry.roadmap}`,
    );
  }

  for (const entry of unmeasured) {
    if (files.includes(entry.file)) continue;
    findings.push(
      `${entry.file}: listed as unmeasured and there is no such script. Remove the entry.`,
    );
  }
  for (const entry of belowFloor) {
    if (files.includes(entry.file)) continue;
    findings.push(
      `${entry.file}: recorded below the floor and there is no such script. Remove the entry.`,
    );
  }

  return { findings, debt };
}

/**
 * Set for the suite this gate starts.
 *
 * A suite cannot contain a case that runs the suite again — the recursion has no
 * floor. So the case that exercises this gate end to end stands down when it
 * finds this marker, which is only ever set by `measure` for the run it started.
 */
export const NESTED = "SCRIPT_COVERAGE_NESTED";

/** Run the suite under Node's coverage and return its output. */
export function measure(root = ROOT, options = {}) {
  const exec = options.exec ?? execFileSync;
  const tests = readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join(root, "scripts", name));

  // A coverage run must not inherit the test-runner context of whoever started
  // it. Node marks its test children with `NODE_TEST_CONTEXT`, and a child that
  // inherits the marker believes it *is* that child: it skips every file and
  // measures nothing. The result is a report with no rows for a suite that ran
  // perfectly — the failure looks like missing coverage, not like recursion.
  const env = { ...process.env, [NESTED]: "1" };
  delete env.NODE_TEST_CONTEXT;

  try {
    return exec(
      process.execPath,
      [
        "--test",
        "--experimental-test-coverage",
        "--test-coverage-include=scripts/*.mjs",
        "--test-coverage-exclude=scripts/*.test.mjs",
        ...tests,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
    );
  } catch (error) {
    // A failing test is a failing gate, and its output is the only explanation.
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const failed = /^# fail (\d+)/m.exec(output);
    if (!failed) throw error;
    return `${output}\n__TESTS_FAILED__\n`;
  }
}

/**
 * Whether this module was started as the program.
 *
 * Spelled out rather than inlined at the bottom of the file, because the check
 * itself is a branch, and a gate that no test can start is a gate whose last
 * line is unmeasured.
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

/**
 * Judge one run and say so.
 *
 * The two sinks are parameters, not defaults. A gate that hides `console` behind
 * `?? console.log` has a branch only the command line can reach, so the one code
 * path a measured run can never touch is the one every reader is most likely to
 * change. Here the command line is the only place that names `console`, and it is
 * three lines at the bottom of the file.
 */
export function run(options) {
  const { log, error } = options;
  const root = options.root ?? ROOT;

  const output = options.output ?? measure(root, options);
  if (output.includes("__TESTS_FAILED__")) {
    error(output.replace("__TESTS_FAILED__", "").trimEnd());
    error(
      "\n✗ script-coverage: the suite did not pass, so there is nothing to measure.",
    );
    return 1;
  }

  const rows = parseTable(output);
  const files = scripts(root);
  const { findings, debt } = check(files, rows, options);

  log(
    // The percentage is a property of the engine that counted it. V8's branch
    // accounting changed between two 22.x minors: this suite reported `audit-policy`
    // at 95.45 % branches on 22.13.1 and 93.48 % on 22.23.4, from the same commit
    // and the same cases. A number without its ruler is not comparable, so the ruler
    // is printed with it.
    `Script coverage on ${process.version} — floor ${options.floor ?? FLOOR}% on ${DIMENSIONS.join(" / ")}, ${files.length} script(s)`,
  );
  log("");
  log("| Script | Lines | Branches | Functions |");
  log("|---|---:|---:|---:|");
  for (const file of files) {
    const row = rows.get(file);
    log(
      row
        ? `| \`${file}\` | ${row.lines.toFixed(2)} | ${row.branches.toFixed(2)} | ${row.functions.toFixed(2)} |`
        : `| \`${file}\` | — | — | — |`,
    );
  }

  if (debt.length > 0) {
    log("");
    log(`**${debt.length} known gap(s), each with a roadmap id.**`);
    for (const line of debt) log(`  - ${line}`);
  }

  if (findings.length > 0) {
    error(`\n✗ script-coverage: ${findings.length} finding(s)\n`);
    for (const finding of findings) error(`  ${finding}`);
    error(
      "\nA gate is an instrument, and an unmeasured instrument is a claim. Test it, or list it " +
        "with a reason and a roadmap id — silence is the one answer this gate does not accept.",
    );
    return 1;
  }

  log(
    `\n✓ script-coverage: ${files.length} scripts accounted for, ${debt.length} known gap(s)`,
  );
  return 0;
}

if (isEntryPoint(process.argv[1])) {
  process.exit(run({ log: console.log, error: console.error }));
}
