#!/usr/bin/env node
/**
 * coverage-gate — enforce per-package, per-dimension coverage thresholds.
 *
 * Vitest writes `coverage/coverage-summary.json` per package. This gate reads
 * every summary and fails if *any* of lines / statements / functions / branches
 * is below the threshold for *any* package. A single aggregate number is not
 * enough: a package can hide an untested area behind a well-tested one.
 *
 * Usage: node scripts/coverage-gate.mjs [threshold=95]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const THRESHOLD = Number(process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? 95);
const DIMENSIONS = ['lines', 'statements', 'functions', 'branches'];

const PACKAGES = [
  { name: '@agentix-e/db-cluster', dir: 'cluster' },
  { name: '@agentix-e/db-federation', dir: 'federation' },
  { name: '@agentix-e/db-operations', dir: 'operations' },
  // The end-to-end harness is production code by any useful definition: it
  // starts real processes, mints certificates and drives the TLS handshakes the
  // acceptance results depend on. Leaving it out of the gate meant its coverage
  // could rot silently; it is measured over `harness/**` only, because the
  // suites themselves are the instrument, not the subject.
  { name: '@agentix-e/db-stack-e2e (harness/**/*.ts)', dir: 'e2e' },
];

const root = resolve(import.meta.dirname, '..');

function pct(entry) {
  return typeof entry === 'number' ? entry : (entry?.pct ?? 0);
}

async function readSummary(dir) {
  const file = resolve(root, dir, 'coverage', 'coverage-summary.json');
  if (!existsSync(file)) return null;
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const total = raw.total ?? {};
  const rows = {};
  for (const dimension of DIMENSIONS) rows[dimension] = pct(total[dimension]);
  rows.files = Object.keys(raw).filter((k) => k !== 'total').length;
  return rows;
}

const failures = [];
const lines = [];

lines.push(`Coverage gate — threshold ${THRESHOLD}% on ${DIMENSIONS.join(' / ')}`);
lines.push('');
lines.push('| Package | Files | Lines | Statements | Functions | Branches | Result |');
lines.push('|---------|------:|------:|-----------:|----------:|---------:|:------:|');

for (const pkg of PACKAGES) {
  const summary = await readSummary(pkg.dir);
  if (!summary) {
    lines.push(`| ${pkg.name} | — | — | — | — | — | ❌ no report |`);
    failures.push(`${pkg.name}: coverage summary missing (${pkg.dir}/coverage/coverage-summary.json)`);
    continue;
  }

  const below = DIMENSIONS.filter((d) => summary[d] < THRESHOLD);
  for (const dimension of below) {
    failures.push(`${pkg.name}: ${dimension} ${summary[dimension].toFixed(2)}% < ${THRESHOLD}%`);
  }

  lines.push(
    `| ${pkg.name} | ${summary.files} | ${summary.lines.toFixed(2)}% | ${summary.statements.toFixed(2)}% | ` +
      `${summary.functions.toFixed(2)}% | ${summary.branches.toFixed(2)}% | ${below.length === 0 ? '✅' : '❌'} |`,
  );
}

console.log(lines.join('\n'));

if (failures.length > 0) {
  console.error('\nCoverage gate FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nCoverage gate passed: every dimension of every package meets the threshold.');
