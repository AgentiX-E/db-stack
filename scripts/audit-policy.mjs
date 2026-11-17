#!/usr/bin/env node
/**
 * Dependency policy — production is held to zero, and an exception is only for the toolchain.
 *
 * `pnpm audit --audit-level high` answers one question: "is there a high advisory anywhere in the
 * tree?" That is the right question for a release and the wrong one for a repository, because the
 * tree contains two populations with different consequences. A vulnerable package that ships in the
 * runtime image is an incident; a vulnerable package that only ever runs Stryker over our own source
 * files is a chore — and the second kind cannot always be fixed on the day the advisory lands, since
 * a transitive dependency may have no patched release at all.
 *
 * The way that normally gets handled is `continue-on-error`, or an ignore list nobody reads again.
 * Both turn the gate into a comment. So this script splits the question in three:
 *
 *   1. **Production is held to zero.** Advisories reported by `pnpm audit --prod` fail the gate, and
 *      no allowlist entry can cover them. The list is checked *against* the production result rather
 *      than trusted, so silencing a shipped dependency is not something an entry can do.
 *   2. **A dev-tree advisory needs a named exception**, with a reason and the date it was reviewed,
 *      recorded in `package.json` under `auditPolicy.allow`.
 *   3. **An exception that matches nothing fails the gate.** An allowlist that silently rots is how a
 *      repository ends up exempting an advisory that was fixed two years ago — or, worse, exempting a
 *      CVE id that a future advisory reuses.
 *
 * Usage:  node scripts/audit-policy.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const allow = pkg.auditPolicy?.allow ?? [];

/** Severities the gate refuses to ship, and the ones it simply reports. */
const BLOCKING = new Set(['high', 'critical']);

/**
 * Advisories from one `pnpm audit` run, keyed by advisory id.
 *
 * `pnpm audit` exits non-zero when it finds anything, and the JSON still arrives on stdout, so the
 * failure path is the normal path here. An empty stdout with a non-zero exit is a different problem —
 * a registry that could not be reached, an offline runner — and is re-thrown rather than reported as
 * "no advisories", because a policy checker that passes when it could not look is a policy checker
 * that always passes.
 */
function advisories(args) {
  let stdout;
  try {
    stdout = execFileSync('pnpm', ['audit', '--json', ...args], { encoding: 'utf8', cwd: root });
  } catch (error) {
    stdout = error.stdout ?? '';
    if (stdout.trim() === '') throw error;
  }
  const report = JSON.parse(stdout);
  return new Map(Object.entries(report.advisories ?? {}).map(([id, a]) => [id, a]));
}

const all = advisories([]);
const production = advisories(['--prod']);
const allowedIds = new Set(allow.map((entry) => entry.advisory));

/** `GHSA-…` if the advisory has one, so an exception names something a human can look up. */
const idOf = (advisory) => advisory.github_advisory_id ?? `npm-${advisory.id}`;

const failures = [];
const exceptions = [];

for (const [id, advisory] of production) {
  if (BLOCKING.has(advisory.severity)) {
    failures.push(
      `production: ${advisory.module_name} — ${advisory.severity} — ${idOf(advisory)} — ` +
        `${advisory.title ?? 'no title'}. No exception can cover a dependency that ships.`,
    );
  }
}

for (const [id, advisory] of all) {
  if (!BLOCKING.has(advisory.severity)) continue;
  if (production.has(id)) continue;
  const name = idOf(advisory);
  const entry = allow.find((candidate) => candidate.advisory === name);
  if (!entry) {
    failures.push(
      `dev tree: ${advisory.module_name} — ${advisory.severity} — ${name} — ` +
        `${advisory.title ?? 'no title'}. Add an entry to auditPolicy.allow with a reason and the ` +
        'date it was reviewed, or fix the dependency.',
    );
    continue;
  }
  exceptions.push(`${advisory.module_name} (${name}) — ${entry.reason} — reviewed ${entry.reviewed}`);
}

for (const entry of allow) {
  const seen = [...all.values()].some((advisory) => idOf(advisory) === entry.advisory);
  if (!seen) {
    failures.push(
      `stale exception: ${entry.advisory} matches no advisory in the tree. Remove it, or the next ` +
        'advisory that reuses the id is exempt without anybody deciding that.',
    );
  }
}

if (exceptions.length > 0) {
  console.log('Allowlisted, dev tree only:');
  for (const line of exceptions) console.log(`  - ${line}`);
}

if (failures.length > 0) {
  console.error('Dependency policy failed:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `Dependency policy passed: ${production.size} advisories in the production tree, ` +
    `${exceptions.length} exception(s) in the dev tree.`,
);
