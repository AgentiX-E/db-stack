#!/usr/bin/env node
/**
 * coverage-gate — enforce per-package *and* per-file coverage thresholds.
 *
 * Vitest writes `coverage/coverage-summary.json` per package. This gate reads
 * every summary and fails if any of lines / statements / functions / branches is
 * below the threshold for any package, or for any file inside one.
 *
 * Both levels are needed. A package total hides its own worst files: cluster sat
 * at 98 % while `LinearizabilityChecker` was at 75 %, and nothing noticed for two
 * iterations. The per-file floor is what makes "≥95 % per dimension" a claim
 * about the code rather than about its average.
 *
 * The judgement is separated from the reading on purpose. `evaluate()` takes the
 * summaries as data, so the rules can be tested against a summary that says
 * whatever a case needs it to say — a package with no files, a file below one
 * dimension, a missing report — without building a coverage run to produce it.
 *
 * Usage: node scripts/coverage-gate.mjs [threshold=95]
 */

import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIMENSIONS = ["lines", "statements", "functions", "branches"];
/** How many offending files to print before truncating the table. */
const MAX_LISTED = 60;

export const PACKAGES = [
  { name: "@agentix-e/db-cluster", dir: "cluster" },
  { name: "@agentix-e/db-federation", dir: "federation" },
  { name: "@agentix-e/db-node", dir: "node" },
  // The end-to-end harness is production code by any useful definition: it
  // starts real processes, mints certificates and drives the TLS handshakes the
  // acceptance results depend on. Leaving it out of the gate meant its coverage
  // could rot silently; it is measured over `harness/**` only, because the
  // suites themselves are the instrument, not the subject.
  { name: "@agentix-e/db-stack-e2e (harness/**/*.ts)", dir: "e2e" },
];

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

/** `pct` is a number in some reporters and `{ pct }` in others; both mean the same. */
export function pct(entry) {
  return typeof entry === "number" ? entry : (entry?.pct ?? 0);
}

/**
 * One package's summary, or `null` when the package produced no report.
 *
 * `null` is not "everything passed": `coverage` was never run for that package,
 * or its artifact never arrived, and a gate that reads a missing report as a
 * clean one is a gate that passes when the job that produces it failed.
 */
export async function readSummary(root, dir) {
  const file = resolve(root, dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) return null;
  return summarise(JSON.parse(await readFile(file, "utf8")), root);
}

/** The shape `evaluate()` reads, from the shape `vitest` writes. */
export function summarise(raw, root = DEFAULT_ROOT) {
  const total = raw.total ?? {};
  const rows = { total: {}, files: [] };
  for (const dimension of DIMENSIONS)
    rows.total[dimension] = pct(total[dimension]);
  rows.total.files = Object.keys(raw).filter((key) => key !== "total").length;

  for (const [path, entry] of Object.entries(raw)) {
    if (path === "total") continue;
    const row = { path: relative(root, path) };
    for (const dimension of DIMENSIONS) row[dimension] = pct(entry[dimension]);
    rows.files.push(row);
  }
  return rows;
}

/** The dimension a file is furthest below the floor on, for a one-line reason. */
export function worst(row) {
  let name = DIMENSIONS[0];
  for (const dimension of DIMENSIONS)
    if (row[dimension] < row[name]) name = dimension;
  return name;
}

/**
 * The whole judgement: a markdown table, an optional offending table, and the
 * failures that decide the exit code.
 */
export function evaluate(packages, summaries, threshold) {
  const failures = [];
  const offending = [];
  const lines = [
    `Coverage gate — threshold ${threshold}% on ${DIMENSIONS.join(" / ")}, per package and per file`,
    "",
    "| Package | Files | Lines | Statements | Functions | Branches | Result |",
    "|---------|------:|------:|-----------:|----------:|---------:|:------:|",
  ];

  for (const pkg of packages) {
    const summary = summaries.get(pkg.dir);
    if (!summary) {
      lines.push(`| ${pkg.name} | — | — | — | — | — | ❌ no report |`);
      failures.push(
        `${pkg.name}: coverage summary missing (${pkg.dir}/coverage/coverage-summary.json)`,
      );
      continue;
    }

    const total = summary.total;
    const below = DIMENSIONS.filter(
      (dimension) => total[dimension] < threshold,
    );
    for (const dimension of below) {
      failures.push(
        `${pkg.name}: ${dimension} ${total[dimension].toFixed(2)}% < ${threshold}%`,
      );
    }

    // A package whose report lists no files passes every dimension by having
    // nothing to measure. That is the shape a broken reporter takes, so it fails.
    if (total.files === 0) {
      failures.push(
        `${pkg.name}: the report contains no files, so nothing was measured`,
      );
    }

    for (const row of summary.files) {
      const short = DIMENSIONS.filter(
        (dimension) => row[dimension] < threshold,
      );
      if (short.length === 0) continue;
      offending.push({ row, short });
      failures.push(
        `${row.path}: ${short.map((dimension) => `${dimension} ${row[dimension].toFixed(2)}%`).join(", ")} < ${threshold}%`,
      );
    }

    lines.push(
      `| ${pkg.name} | ${total.files} | ${total.lines.toFixed(2)}% | ${total.statements.toFixed(2)}% | ` +
        `${total.functions.toFixed(2)}% | ${total.branches.toFixed(2)}% | ${below.length === 0 ? "✅" : "❌"} |`,
    );
  }

  let detail = null;
  if (offending.length > 0) {
    detail = [
      "",
      `**${offending.length} file(s) below the floor.** A package average is not a measurement of its parts.`,
      "",
      "| File | Lines | Statements | Functions | Branches | Below on |",
      "|---|---:|---:|---:|---:|:--|",
    ];
    for (const { row, short } of offending.slice(0, MAX_LISTED)) {
      detail.push(
        `| \`${row.path}\` | ${row.lines.toFixed(2)} | ${row.statements.toFixed(2)} | ` +
          `${row.functions.toFixed(2)} | ${row.branches.toFixed(2)} | ${short.length === 4 ? worst(row) : short.join(", ")} |`,
      );
    }
    if (offending.length > MAX_LISTED)
      detail.push(`| … ${offending.length - MAX_LISTED} more | | | | | |`);
  }

  return {
    table: lines.join("\n"),
    detail: detail?.join("\n") ?? null,
    failures,
  };
}

/**
 * The wall-clock time HEAD was committed, in milliseconds.
 *
 * A report written before this instant cannot describe the code now in the tree:
 * the suite that produced it ran against a different HEAD. The comparison is
 * deliberately coarse — seconds, not nanoseconds — because the point is to make a
 * stale read *visible*, not to turn the gate into a clock synchronisation check.
 * Returns `null` when git cannot answer (no repository, shallow clone), and a
 * caller that cannot get a HEAD time must not call any report stale.
 */
export function gitHeadTime(root, exec = execFileSync) {
  try {
    const out = exec("git", ["log", "-1", "--format=%cI"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * One row per package: the mtime of its report, or null when there is none.
 * `stat`, `exists` and `head` are injected so a case can drive a stale report,
 * a missing one and an unreadable HEAD without touching the filesystem or git.
 */
export async function readFreshness(root, packages, options = {}) {
  const stat = options.stat ?? statSync;
  const exists = options.exists ?? existsSync;
  const rows = [];
  for (const pkg of packages) {
    const file = resolve(root, pkg.dir, "coverage", "coverage-summary.json");
    let mtimeMs = null;
    if (exists(file)) {
      try {
        mtimeMs = stat(file).mtimeMs;
      } catch {
        mtimeMs = null;
      }
    }
    rows.push({ name: pkg.name, dir: pkg.dir, mtimeMs });
  }
  return rows;
}

/**
 * The freshness table. A report older than HEAD is named STALE; one written after
 * HEAD is fresh; a missing report and an unknown HEAD are reported without a
 * verdict, because neither is evidence about staleness.
 */
export function freshnessTable(rows, headMs) {
  const when = (ms) => (ms === null ? "unknown" : new Date(ms).toISOString());
  const lines = [
    "",
    "## Report freshness (report mtime vs HEAD commit time)",
    "",
    "| Package | Report mtime | Verdict |",
    "|---|---|:--|",
  ];
  for (const row of rows) {
    let verdict;
    if (row.mtimeMs === null) verdict = "no report";
    else if (headMs === null) verdict = "HEAD unavailable";
    else if (row.mtimeMs < headMs) verdict = "STALE — report predates HEAD";
    else verdict = "fresh";
    lines.push(`| ${row.name} | ${when(row.mtimeMs)} | ${verdict} |`);
  }
  lines.push(
    "",
    headMs === null
      ? "HEAD time unavailable; staleness was not judged."
      : `HEAD committed at ${when(headMs)}.`,
  );
  return lines.join("\n");
}

export async function run(argv = process.argv.slice(2), options = {}) {
  // `?? console.log` rather than a wrapper: a wrapper is a function defined in
  // this file that no test can reach without printing, and it exists only to
  // restate the signature.
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const root = options.root ?? DEFAULT_ROOT;
  const threshold = Number(argv[0] ?? process.env.COVERAGE_THRESHOLD ?? 95);

  const packages = options.packages ?? PACKAGES;
  const summaries = new Map();
  for (const pkg of packages) {
    summaries.set(
      pkg.dir,
      options.summaries?.get(pkg.dir) ?? (await readSummary(root, pkg.dir)),
    );
  }

  const { table, detail, failures } = evaluate(packages, summaries, threshold);
  log(table);
  if (detail) log(detail);

  // Make a stale report visible. The verdict above is unchanged — a fresh run
  // writes a fresh report — but an operator who invoked the gate without
  // regenerating first now sees *which* report predates HEAD rather than a green
  // table that cannot be trusted (P3-98).
  const freshness = options.freshness ?? (() => readFreshness(root, packages));
  const headMs =
    options.head !== undefined ? options.head() : gitHeadTime(root);
  log(freshnessTable(await freshness(), headMs));

  if (failures.length > 0) {
    error("\nCoverage gate FAILED:");
    for (const failure of failures) error(`  - ${failure}`);
    return 1;
  }

  log(
    "\nCoverage gate passed: every dimension of every package and every file meets the threshold.",
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await run());
}
