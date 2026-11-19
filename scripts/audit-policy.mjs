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
 * `evaluate()` takes the two advisory sets as data, so the three rules are tested against advisory
 * sets a case writes rather than against whatever the registry says today. `--from <file>` replays a
 * recorded audit, which is also what makes the command line itself testable offline.
 *
 * Usage:
 *   node scripts/audit-policy.mjs
 *   node scripts/audit-policy.mjs --from audit-recording.json
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);

/** Severities the gate refuses to ship, and the ones it simply reports. */
export const BLOCKING = new Set(["high", "critical"]);

/** `GHSA-…` if the advisory has one, so an exception names something a human can look up. */
export function idOf(advisory) {
  return advisory.github_advisory_id ?? `npm-${advisory.id}`;
}

/**
 * Advisories from one `pnpm audit` run, keyed by advisory id.
 *
 * `pnpm audit` exits non-zero when it finds anything, and the JSON still arrives on stdout, so the
 * failure path is the normal path here. An empty stdout with a non-zero exit is a different problem —
 * a registry that could not be reached, an offline runner — and is re-thrown rather than reported as
 * "no advisories", because a policy checker that passes when it could not look is a policy checker
 * that always passes.
 */
export function advisories(args, exec = execFileSync) {
  let stdout;
  try {
    stdout = exec("pnpm", ["audit", "--json", ...args], {
      encoding: "utf8",
      cwd: root,
    });
  } catch (error) {
    stdout = error.stdout ?? "";
    if (stdout.trim() === "") throw error;
  }
  return toMap(JSON.parse(stdout));
}

export function toMap(report) {
  return new Map(
    Object.entries(report.advisories ?? {}).map(([id, advisory]) => [
      id,
      advisory,
    ]),
  );
}

/**
 * The three rules, as one function of the two advisory sets.
 *
 * Returns `failures` (each a sentence that says what to do) and `exceptions` (the allowlisted
 * advisories that really are present, so the run reports what it excused rather than how many
 * entries the allowlist has).
 */
export function evaluate({ all, production, allow }) {
  const failures = [];
  const exceptions = [];

  for (const advisory of production.values()) {
    if (!BLOCKING.has(advisory.severity)) continue;
    failures.push(
      `production: ${advisory.module_name} — ${advisory.severity} — ${idOf(advisory)} — ` +
        `${advisory.title ?? "no title"}. No exception can cover a dependency that ships.`,
    );
  }

  for (const [id, advisory] of all) {
    if (!BLOCKING.has(advisory.severity)) continue;
    if (production.has(id)) continue;
    const name = idOf(advisory);
    const entry = allow.find((candidate) => candidate.advisory === name);
    if (!entry) {
      failures.push(
        `dev tree: ${advisory.module_name} — ${advisory.severity} — ${name} — ` +
          `${advisory.title ?? "no title"}. Add an entry to auditPolicy.allow with a reason and the ` +
          "date it was reviewed, or fix the dependency.",
      );
      continue;
    }
    exceptions.push(
      `${advisory.module_name} (${name}) — ${entry.reason} — reviewed ${entry.reviewed}`,
    );
  }

  for (const entry of allow) {
    const seen = [...all.values()].some(
      (advisory) => idOf(advisory) === entry.advisory,
    );
    if (!seen) {
      failures.push(
        `stale exception: ${entry.advisory} matches no advisory in the tree. Remove it, or the next ` +
          "advisory that reuses the id is exempt without anybody deciding that.",
      );
    }
  }

  return { failures, exceptions };
}

/** A recorded run, for `--from`: `{ "all": {...}, "production": {...} }` in `pnpm audit --json` shape. */
export function replay(path) {
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  return {
    all: toMap(recorded.all ?? recorded),
    production: toMap(recorded.production ?? {}),
  };
}

export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

export function run(argv, options) {
  const { log, error } = options;
  const allow =
    (
      options.pkg ??
      JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
    ).auditPolicy?.allow ?? [];

  const at = argv.indexOf("--from");
  let all;
  let production;
  if (at !== -1) {
    if (argv[at + 1] === undefined) {
      error("audit-policy: --from needs a path");
      return 2;
    }
    ({ all, production } = replay(argv[at + 1]));
  } else {
    // The reader is a parameter, and the command line is the only place that names
    // the live one. A default of `advisories` here would be a branch no test can
    // reach — reaching it means calling a registry — which is how a gate ends up
    // with one code path nobody has ever measured.
    const read = options.advisories;
    all = read([]);
    production = read(["--prod"]);
  }

  const { failures, exceptions } = evaluate({ all, production, allow });

  if (exceptions.length > 0) {
    log("Allowlisted, dev tree only:");
    for (const line of exceptions) log(`  - ${line}`);
  }

  if (failures.length > 0) {
    error("Dependency policy failed:");
    for (const line of failures) error(`  - ${line}`);
    return 1;
  }

  log(
    `Dependency policy passed: ${production.size} advisories in the production tree, ` +
      `${exceptions.length} exception(s) in the dev tree.`,
  );
  return 0;
}

if (isEntryPoint(process.argv[1])) {
  process.exit(
    run(process.argv.slice(2), {
      log: console.log,
      error: console.error,
      advisories,
    }),
  );
}
