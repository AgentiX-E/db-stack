#!/usr/bin/env node
/**
 * check-legacy-names — a retired package name is retired everywhere or nowhere.
 *
 * Twenty-one packages became three, and the old names are not going to be published again. Saying so
 * is a sentence in `CHANGELOG.md`, and a sentence is what a reader believes until the day a module
 * moves and nobody edits it. This gate is the compiler for that sentence:
 *
 *   1. **Every retired name has a row in `docs/migration-2.0.md`, and every row names a retired name.**
 *      A new module with no migration row is a consumer's `MODULE_NOT_FOUND`; a row for a name that
 *      never existed is a reader following a link to nothing.
 *   2. **Every row's target is a subpath `@agentix-e/db-node` actually exports, and the one its own
 *      module names.** The page cannot point at `@agentix-e/db-node/auditl` and still pass — and it
 *      cannot point `audit` at `core` either, which compiles and imports the wrong module.
 *   3. **No file in this repository imports a retired name.** The migration is not finished while the
 *      repository itself is an example of the old way — and a stray import is also how a test keeps
 *      passing against a package the release no longer builds.
 *
 * The retired set is derived rather than typed out twice: it is the module list of
 * `@agentix-e/db-node`'s `exports`, plus the umbrella. A module added to the package is therefore
 * *expected* to have a migration row, which is the direction that fails loudly instead of silently.
 *
 * Usage: node scripts/check-legacy-names.mjs [--quiet]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = "docs/migration-2.0.md";
const SCOPE = "db-operations";
/** Directories that hold code. `docs/` and `*.md` are prose and are allowed to name the old names. */
const CODE_ROOTS = [
  "node/src",
  "cluster/src",
  "federation/src",
  "e2e/tests",
  "e2e/harness",
  "scripts",
];

/**
 * The one file whose subject *is* the retired names, and therefore has to contain them.
 *
 * Skipped by name rather than by `*.test.mjs`, because a real import in a real test is exactly the
 * case this gate exists for.
 */
const SELF = new Set(["scripts/check-legacy-names.test.mjs"]);

/** `@agentix-e/db-operations-audit` and friends, one per module the node package exports. */
export function legacyNames(exports) {
  const modules = exports
    .filter((key) => key.startsWith("./") && key !== "./package.json")
    .map((key) => key.slice(2).split("/")[0]);
  return [
    `@agentix-e/${SCOPE}`,
    ...[...new Set(modules)].map((module) => `@agentix-e/${SCOPE}-${module}`),
  ];
}

/** A retired name, either the umbrella or one module's. */
const NAME = String.raw`@agentix-e/${SCOPE}(?:-[a-z][a-z0-9]*)?`;

/**
 * The migration rows of a page, in the order it lists them.
 *
 * A row is a table line: prose is allowed to name an old package (the page's own introduction does),
 * but only a row is a promise about where the import should go, so only a row is read back.
 */
export function rowsInPage(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const name = new RegExp(String.raw`\`(${NAME})\``).exec(line);
    if (name === null) continue;
    const target = /`@agentix-e\/db-node\/([^`]+)`/.exec(line);
    rows.push({ name: name[1], target: target === null ? null : target[1] });
  }
  return rows;
}

/**
 * Every problem the page has, given the retired set and the subpaths the package exports.
 *
 * Returned rather than thrown so the self-test can assert on the list instead of on an exit code.
 */
export function checkPage(text, legacy, subpaths) {
  const problems = [];
  const rows = rowsInPage(text);
  const covered = new Set(rows.map((row) => row.name));
  const saidSo = new Set();

  for (const name of legacy) {
    if (!covered.has(name))
      problems.push(`${PAGE} has no row for the retired name ${name}`);
  }

  for (const { name, target } of rows) {
    if (!legacy.includes(name)) {
      // A name that was never published has no target worth judging: the row is already wrong, and
      // reporting where it points would be a second sentence about a name that does not exist.
      if (saidSo.has(name)) continue;
      saidSo.add(name);
      problems.push(`${PAGE} names ${name}, which is not a retired name`);
      continue;
    }

    // The umbrella re-exported everything and is simply gone, so it has nowhere to point.
    if (name === `@agentix-e/${SCOPE}`) continue;

    const module = name.slice(`@agentix-e/${SCOPE}-`.length);
    if (target === null) {
      problems.push(
        `${PAGE} has a row for ${name} that points at no @agentix-e/db-node subpath`,
      );
    } else if (!subpaths.includes(`./${target}`)) {
      problems.push(
        `${PAGE} sends ${name} to @agentix-e/db-node/${target}, which is not an exported subpath`,
      );
    } else if (target !== module) {
      // Both halves exist, and the row still lies: a module that keeps its name pointed at a
      // different one is the quietest wrong answer of the three — it compiles.
      problems.push(
        `${PAGE} sends ${name} to @agentix-e/db-node/${target}, but the module keeps its name: ${module}`,
      );
    }
  }
  return problems;
}

/** Every line in `text` that imports a retired name, as `<file>:<line>`. */
export function importsInText(text, file, legacy) {
  const found = [];
  const pattern = new RegExp(
    String.raw`(?:from|require\(|import\()\s*['"](${NAME})['"]`,
    "g",
  );
  text.split("\n").forEach((line, index) => {
    // A specifier, not a mention: `from '…'`, `require('…')`, `import('…')`. A comment that names the
    // old package is documentation, and this gate is not a spell-checker.
    for (const match of line.matchAll(pattern)) {
      if (legacy.includes(match[1]))
        found.push(`${file}:${index + 1}: imports ${match[1]}`);
    }
  });
  return found;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(path, out);
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every problem in the tree rooted at `base`, in the order a reader would fix them.
 *
 * Takes the root rather than reading the module's own, so the gate can be pointed at a tree that is
 * wrong on purpose: a gate whose failures are only reachable by breaking the real repository is a gate
 * whose failures are untested. The count comes back with the problems so the success line and the
 * failures are two readings of one pass.
 */
export function checkTree(base) {
  const manifest = JSON.parse(
    readFileSync(join(base, "node/package.json"), "utf8"),
  );
  const subpaths = Object.keys(manifest.exports ?? {});
  const legacy = legacyNames(subpaths);
  const problems = checkPage(
    readFileSync(join(base, PAGE), "utf8"),
    legacy,
    subpaths,
  );

  for (const root of CODE_ROOTS) {
    const dir = join(base, root);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const name = relative(base, file).split(sep).join("/");
      if (SELF.has(name)) continue;
      problems.push(...importsInText(readFileSync(file, "utf8"), name, legacy));
    }
  }
  return { retired: legacy.length, problems };
}

/** The gate's failing output: one line per problem, on stderr, where a refusal belongs. */
export function report(problems, write = console.error) {
  for (const problem of problems) write(`✗ ${problem}`);
}

/**
 * One pass of the gate: read the tree, say what is wrong, answer with the exit code.
 *
 * The root and the two streams are parameters rather than globals so the failing path can be observed
 * without ending the test runner — a gate whose refusal is only reachable by spawning itself is a gate
 * whose refusal is only checked for its exit code. The code is *returned* for the same reason: the one
 * caller that exits is `main`.
 */
export function run(
  argv,
  { root = ROOT, log = console.log, write = console.error } = {},
) {
  const { retired, problems } = checkTree(root);

  if (problems.length > 0) {
    report(problems, write);
    return 1;
  }
  if (!argv.includes("--quiet")) {
    log(
      `✓ legacy-names: ${retired} retired names, each with a migration row that points at a real ` +
        `subpath, and no source file imports one`,
    );
  }
  return 0;
}

function main() {
  // `exitCode` rather than `exit`: the report is on stdout and has to be flushed.
  process.exitCode = run(process.argv);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();

export { ROOT, PAGE, SCOPE };
