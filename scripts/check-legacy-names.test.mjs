/**
 * Tests for the retired-package-name gate.
 *
 * A migration page is prose, and prose about a package list goes stale the first time a module moves.
 * The gate is what makes the page a claim rather than a note, so these cases pin it in both
 * directions: it must catch a retired name with no row, a row whose target is not an exported
 * subpath, a row whose target is an exported subpath belonging to a *different* module (the quietest
 * of the wrong answers — it compiles), and a source file that still imports one — and it must leave
 * the shapes a real page and real code use alone, including prose that mentions an old name.
 *
 * The last two cases run it over the real repository: one asserts the retired set is derived from the
 * package's own exports (a gate over an empty list reports perfect compliance), the other asserts the
 * real page and the real tree pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  checkPage,
  checkTree,
  importsInText,
  legacyNames,
  report,
  rowsInPage,
  run,
} from "./check-legacy-names.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = "docs/migration-2.0.md";
const UMBRELLA = "@agentix-e/db-operations";
const EXPORTS = [".", "./core", "./audit", "./backup", "./package.json"];
const LEGACY = legacyNames(EXPORTS);
const SUBPATHS = EXPORTS;

/** `@agentix-e/db-operations-audit` -> `audit`. */
function moduleOf(name) {
  return name.slice(UMBRELLA.length + 1);
}

/** One migration row, of the shape the real page uses. */
function row(name) {
  return name === UMBRELLA
    ? `| \`${name}\` | nothing — it re-exported every module and is gone |`
    : `| \`${name}\` | \`@agentix-e/db-node/${moduleOf(name)}\` |`;
}

/** A page with a row for every retired name and nothing else. */
function page(rows = LEGACY.map(row)) {
  return ["# Migration", "| Before | After |", "| --- | --- |", ...rows].join(
    "\n",
  );
}

test("the retired set is derived from the package, not typed twice", () => {
  // Three modules in the manifest, so three names plus the umbrella — and `./package.json` and the
  // root entry are not modules.
  assert.deepEqual(LEGACY, [
    "@agentix-e/db-operations",
    "@agentix-e/db-operations-core",
    "@agentix-e/db-operations-audit",
    "@agentix-e/db-operations-backup",
  ]);
  // A module list that grew is the case that has to fail loudly, so it is the one asserted first —
  // including a module whose name is not all letters.
  assert.equal(
    legacyNames([".", "./audit", "./audit2"]).includes(
      "@agentix-e/db-operations-audit2",
    ),
    true,
  );
});

test("a complete page has nothing to report", () => {
  assert.deepEqual(checkPage(page(), LEGACY, SUBPATHS), []);
});

test("a retired name with no row is reported", () => {
  const problems = checkPage(page(LEGACY.slice(1).map(row)), LEGACY, SUBPATHS);
  assert.deepEqual(problems, [
    `${PAGE} has no row for the retired name ${LEGACY[0]}`,
  ]);
});

test("a row for a name that was never published is reported once", () => {
  const ghost =
    "| `@agentix-e/db-operations-ghost` | `@agentix-e/db-node/ghost` |";
  const problems = checkPage(
    page([...LEGACY.map(row), ghost, ghost]),
    LEGACY,
    SUBPATHS,
  );
  assert.deepEqual(problems, [
    `${PAGE} names @agentix-e/db-operations-ghost, which is not a retired name`,
  ]);
});

test("a row pointing at a subpath the package does not export is reported", () => {
  const rows = LEGACY.map((name) =>
    name === "@agentix-e/db-operations-audit"
      ? `| \`${name}\` | \`@agentix-e/db-node/auditl\` |`
      : row(name),
  );
  assert.deepEqual(checkPage(page(rows), LEGACY, SUBPATHS), [
    `${PAGE} sends @agentix-e/db-operations-audit to @agentix-e/db-node/auditl, which is not an exported subpath`,
  ]);
});

test("a row pointing at another module's subpath is reported", () => {
  // `core` is exported, so the subpath check alone would pass this row: the migration would compile
  // and import the wrong module. That is the failure this case exists for.
  const rows = LEGACY.map((name) =>
    name === "@agentix-e/db-operations-audit"
      ? `| \`${name}\` | \`@agentix-e/db-node/core\` |`
      : row(name),
  );
  assert.deepEqual(checkPage(page(rows), LEGACY, SUBPATHS), [
    `${PAGE} sends @agentix-e/db-operations-audit to @agentix-e/db-node/core, but the module keeps its name: audit`,
  ]);
});

test("a row with no target at all is reported", () => {
  const rows = LEGACY.map((name) =>
    name === "@agentix-e/db-operations-backup"
      ? `| \`${name}\` | moved somewhere |`
      : row(name),
  );
  assert.deepEqual(checkPage(page(rows), LEGACY, SUBPATHS), [
    `${PAGE} has a row for @agentix-e/db-operations-backup that points at no @agentix-e/db-node subpath`,
  ]);
});

test("rows are the table lines, in order, with duplicates; prose is not a row", () => {
  const text = [
    "`@agentix-e/db-operations-audit` is the old name, mentioned here in prose.",
    "```diff",
    "-import { a } from '@agentix-e/db-operations-backup';",
    "```",
    "| Before | After |",
    "| --- | --- |",
    "| `@agentix-e/db-operations-audit` | `@agentix-e/db-node/audit` |",
    "| `@agentix-e/db-operations-audit` | `@agentix-e/db-node/audit` |",
  ].join("\n");

  assert.deepEqual(rowsInPage(text), [
    { name: "@agentix-e/db-operations-audit", target: "audit" },
    { name: "@agentix-e/db-operations-audit", target: "audit" },
  ]);
  // The umbrella row of a real page carries no `@agentix-e/db-node` target, and that is not an error
  // for the umbrella — it has nowhere to go.
  assert.deepEqual(rowsInPage(row(UMBRELLA)), [
    { name: UMBRELLA, target: null },
  ]);
});

test("an import of a retired name is reported with its position", () => {
  const source = [
    "import { a } from '@agentix-e/db-operations-audit';",
    "const b = require('@agentix-e/db-operations-backup');",
  ].join("\n");
  assert.deepEqual(importsInText(source, "node/src/x.ts", LEGACY), [
    "node/src/x.ts:1: imports @agentix-e/db-operations-audit",
    "node/src/x.ts:2: imports @agentix-e/db-operations-backup",
  ]);
});

test("a comment, a subpath import, a current name and a retired-looking name are all left alone", () => {
  const source = [
    "// the old name was '@agentix-e/db-operations-audit', and the new one is a subpath",
    "import { b } from '@agentix-e/db-node/audit';",
    "import { c } from '@agentix-e/db-cluster';",
    "// and `@agentix-e/db-operations-nothing` was never published",
  ].join("\n");
  // The comment is prose about the past; the two imports are the present; the last name is not one
  // of the retired ones, so importing it is a typo for a different gate to find.
  assert.deepEqual(importsInText(source, "node/src/x.ts", LEGACY), []);
});

test("the retired set of the real package is at least twenty modules and an umbrella", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "node/package.json"), "utf8"),
  );
  const legacy = legacyNames(Object.keys(manifest.exports ?? {}));
  assert.ok(
    legacy.length >= 21,
    `the retired set is ${legacy.length} names, and twenty modules plus the umbrella is the floor`,
  );
});

/** A tree on disk that the gate can be pointed at: a manifest, a page, and code. */
function fixture(t, { rows, sources = {}, extra = {} }) {
  const root = mkdtempSync(join(tmpdir(), "legacy-names-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    "node/package.json": JSON.stringify({
      exports: { ".": "./dist/index.js", "./core": "./dist/core.js" },
    }),
    [PAGE]: page(rows ?? [row(UMBRELLA), row("@agentix-e/db-operations-core")]),
    ...sources,
    ...extra,
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

test("a tree whose code imports a retired name is reported by file and line", (t) => {
  const root = fixture(t, {
    sources: {
      "node/src/x.ts": "import { a } from '@agentix-e/db-operations-core';\n",
      "cluster/src/y.ts": "export { b } from '@agentix-e/db-operations';\n",
    },
  });

  const { retired, problems } = checkTree(root);
  assert.equal(
    retired,
    2,
    "the umbrella and the one module the fixture exports",
  );
  // Node's tree is walked first, so its finding comes first: the order is the gate's, not the
  // filesystem's.
  assert.deepEqual(problems, [
    "node/src/x.ts:1: imports @agentix-e/db-operations-core",
    "cluster/src/y.ts:1: imports @agentix-e/db-operations",
  ]);
});

test("a tree with no code at all is judged on its page alone", (t) => {
  // The six code roots are absent from the fixture, which is the case a fresh clone with a broken
  // page still has to answer: silence from a directory that is not there is not a pass or a failure.
  const root = fixture(t, {});
  assert.deepEqual(checkTree(root), { retired: 2, problems: [] });
});

test("build output and installed dependencies are not the tree's own code", (t) => {
  const named = "import { a } from '@agentix-e/db-operations-core';\n";
  const root = fixture(t, {
    sources: {
      "node/src/dist/z.ts": named,
      "node/src/node_modules/pkg/index.js": named,
      "node/src/readme.txt": named,
    },
  });
  assert.deepEqual(checkTree(root).problems, []);
});

test("the gate's own test file, and only that file, is allowed to name the old packages", (t) => {
  const named =
    "const source = \"import { a } from '@agentix-e/db-operations-core';\";\n";
  const root = fixture(t, {
    sources: {
      "scripts/check-legacy-names.test.mjs": named,
      "scripts/other.test.mjs": named,
    },
  });
  // A real import in a real test is exactly what the gate is for, so the exemption is one file by
  // name rather than every `*.test.mjs`.
  assert.deepEqual(checkTree(root).problems, [
    "scripts/other.test.mjs:1: imports @agentix-e/db-operations-core",
  ]);
});

test("a failing gate prints one line per problem, and nothing when there is nothing to say", () => {
  const lines = [];
  report(["a", "b"], (line) => lines.push(line));
  assert.deepEqual(lines, ["✗ a", "✗ b"]);

  lines.length = 0;
  report([], (line) => lines.push(line));
  assert.deepEqual(lines, []);
});

test("a pass answers 0 and says what it read; --quiet answers 0 in silence", (t) => {
  const root = fixture(t, {});
  const log = [];
  assert.equal(run([], { root, log: (line) => log.push(line) }), 0);
  assert.deepEqual(log, [
    "✓ legacy-names: 2 retired names, each with a migration row that points at a real subpath, and no source file imports one",
  ]);

  log.length = 0;
  assert.equal(run(["--quiet"], { root, log: (line) => log.push(line) }), 0);
  assert.deepEqual(log, []);
});

test("a refusal answers 1, prints every problem and calls no success line", (t) => {
  const root = fixture(t, {
    sources: {
      "node/src/x.ts": "import a from '@agentix-e/db-operations-core';\n",
    },
  });
  const lines = [];
  const log = [];
  const code = run([], {
    root,
    write: (line) => lines.push(line),
    log: (line) => log.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(lines, [
    "✗ node/src/x.ts:1: imports @agentix-e/db-operations-core",
  ]);
  assert.deepEqual(log, [], "a gate that failed has nothing to congratulate");
});

test("the command line exits 0 on a clean repository and says what it read", () => {
  const child = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/check-legacy-names.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0);
  assert.match(child.stdout, /^✓ legacy-names: 21 retired names/m);
});

test("the command line goes quiet when asked to", () => {
  const child = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/check-legacy-names.mjs"), "--quiet"],
    {
      encoding: "utf8",
    },
  );

  // CI prints enough; `--quiet` is how a composite gate keeps one line per gate.
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
});

test("the command line exits 1 and names every problem when the repository disagrees with the page", (t) => {
  // The child reads the repository it is run from, so the failure has to be staged in a copy: a
  // sibling script that imports an old name, in a tree that is otherwise this one.
  const root = mkdtempSync(join(tmpdir(), "legacy-names-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    "node/package.json",
    PAGE,
    "scripts/check-legacy-names.mjs",
  ]) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(ROOT, name)));
  }
  writeFileSync(
    join(root, "scripts/imports-old-name.mjs"),
    "import a from '@agentix-e/db-operations-audit';\n",
  );

  const child = spawnSync(
    process.execPath,
    [join(root, "scripts/check-legacy-names.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.equal(
    child.stderr.trim(),
    "✗ scripts/imports-old-name.mjs:1: imports @agentix-e/db-operations-audit",
  );
  assert.equal(child.stdout, "", "a failing gate prints no success line");
});

test("the real page and the real tree pass", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "node/package.json"), "utf8"),
  );
  const exports = Object.keys(manifest.exports ?? {});
  const text = readFileSync(join(ROOT, "docs/migration-2.0.md"), "utf8");
  assert.deepEqual(checkPage(text, legacyNames(exports), exports), []);
  assert.deepEqual(checkTree(ROOT).problems, []);
});
