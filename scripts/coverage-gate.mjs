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
 * Usage: node scripts/coverage-gate.mjs [threshold=95]
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const THRESHOLD = Number(
  process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? 95,
);
const DIMENSIONS = ["lines", "statements", "functions", "branches"];
/** How many offending files to print before truncating the table. */
const MAX_LISTED = 60;

const PACKAGES = [
  { name: "@agentix-e/db-cluster", dir: "cluster" },
  { name: "@agentix-e/db-federation", dir: "federation" },
  { name: "@agentix-e/db-operations", dir: "operations" },
  // The end-to-end harness is production code by any useful definition: it
  // starts real processes, mints certificates and drives the TLS handshakes the
  // acceptance results depend on. Leaving it out of the gate meant its coverage
  // could rot silently; it is measured over `harness/**` only, because the
  // suites themselves are the instrument, not the subject.
  { name: "@agentix-e/db-stack-e2e (harness/**/*.ts)", dir: "e2e" },
];

const root = resolve(import.meta.dirname, "..");

function pct(entry) {
  return typeof entry === "number" ? entry : (entry?.pct ?? 0);
}

async function readSummary(dir) {
  const file = resolve(root, dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(await readFile(file, "utf8"));

  const total = raw.total ?? {};
  const rows = { total: {} };
  for (const dimension of DIMENSIONS)
    rows.total[dimension] = pct(total[dimension]);
  rows.total.files = Object.keys(raw).filter((key) => key !== "total").length;

  rows.files = [];
  for (const [path, entry] of Object.entries(raw)) {
    if (path === "total") continue;
    const row = { path: relative(root, path) };
    for (const dimension of DIMENSIONS) row[dimension] = pct(entry[dimension]);
    rows.files.push(row);
  }
  return rows;
}

/** The dimension a file is furthest below the floor on, for a one-line reason. */
function worst(row) {
  let name = DIMENSIONS[0];
  for (const dimension of DIMENSIONS)
    if (row[dimension] < row[name]) name = dimension;
  return name;
}

const failures = [];
const offending = [];
const lines = [];

lines.push(
  `Coverage gate — threshold ${THRESHOLD}% on ${DIMENSIONS.join(" / ")}, per package and per file`,
);
lines.push("");
lines.push(
  "| Package | Files | Lines | Statements | Functions | Branches | Result |",
);
lines.push(
  "|---------|------:|------:|-----------:|----------:|---------:|:------:|",
);

for (const pkg of PACKAGES) {
  const summary = await readSummary(pkg.dir);
  if (!summary) {
    lines.push(`| ${pkg.name} | — | — | — | — | — | ❌ no report |`);
    failures.push(
      `${pkg.name}: coverage summary missing (${pkg.dir}/coverage/coverage-summary.json)`,
    );
    continue;
  }

  const total = summary.total;
  const below = DIMENSIONS.filter((dimension) => total[dimension] < THRESHOLD);
  for (const dimension of below) {
    failures.push(
      `${pkg.name}: ${dimension} ${total[dimension].toFixed(2)}% < ${THRESHOLD}%`,
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
    const short = DIMENSIONS.filter((dimension) => row[dimension] < THRESHOLD);
    if (short.length === 0) continue;
    offending.push({ row, short });
    failures.push(
      `${row.path}: ${short.map((dimension) => `${dimension} ${row[dimension].toFixed(2)}%`).join(", ")} < ${THRESHOLD}%`,
    );
  }

  lines.push(
    `| ${pkg.name} | ${total.files} | ${total.lines.toFixed(2)}% | ${total.statements.toFixed(2)}% | ` +
      `${total.functions.toFixed(2)}% | ${total.branches.toFixed(2)}% | ${below.length === 0 ? "✅" : "❌"} |`,
  );
}

console.log(lines.join("\n"));

if (offending.length > 0) {
  const table = [
    "",
    `**${offending.length} file(s) below the floor.** A package average is not a measurement of its parts.`,
    "",
    "| File | Lines | Statements | Functions | Branches | Below on |",
    "|---|---:|---:|---:|---:|:--|",
  ];
  for (const { row, short } of offending.slice(0, MAX_LISTED)) {
    table.push(
      `| \`${row.path}\` | ${row.lines.toFixed(2)} | ${row.statements.toFixed(2)} | ` +
        `${row.functions.toFixed(2)} | ${row.branches.toFixed(2)} | ${short.length === 4 ? worst(row) : short.join(", ")} |`,
    );
  }
  if (offending.length > MAX_LISTED)
    table.push(`| … ${offending.length - MAX_LISTED} more | | | | | |`);
  console.log(table.join("\n"));
}

if (failures.length > 0) {
  console.error("\nCoverage gate FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  "\nCoverage gate passed: every dimension of every package and every file meets the threshold.",
);
