/**
 * Tests for the documentation-versus-exports gate.
 *
 * The gate exists because two API reference pages described packages that were
 * never written. A gate that only ever prints "passed" would be the same defect
 * one layer out, so these cases pin both directions: it must catch a heading
 * naming a symbol the package does not export, and it must leave the shapes a
 * real reference page uses — member headings, modifier-prefixed signatures,
 * navigation headings — alone.
 *
 * The last two cases run the gate over the real repository: one asserts it
 * scans something (a gate over zero documents reports perfect compliance), the
 * other asserts the compiler really resolves the export surface rather than
 * returning an empty set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  auditDocument,
  auditPackage,
  auditPackageIndex,
  describe,
  report,
  exportEntries,
  exportSurface,
  markdownFiles,
  mentionedNames,
  packageIndex,
  run,
  splitSpecifier,
  symbolicHeadings,
  undocumentedExports,
  unresolvedImports,
  workspacePackages,
} from "./check-docs-api.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const surface = {
  exported: new Set(["RaftGroup", "applyLag"]),
  members: new Set(["propose", "stop"]),
  values: new Set(["RaftGroup"]),
};

const audit = (text, options = {}) =>
  auditDocument({
    text,
    file: "docs/sample.md",
    surface,
    ...options,
  });

test("reads a heading that opens with a backticked type name", () => {
  assert.deepEqual(symbolicHeadings("### `RaftGroup`\n"), [
    { name: "RaftGroup", line: 1 },
  ]);
});

test("reads a heading whose signature starts with a modifier", () => {
  assert.deepEqual(symbolicHeadings("### `async stop(): Promise<void>`\n"), [
    { name: "stop", line: 1 },
  ]);
  assert.deepEqual(symbolicHeadings("### `static reset(): void`\n"), [
    { name: "reset", line: 1 },
  ]);
  assert.deepEqual(symbolicHeadings("### `readonly size: number`\n"), [
    { name: "size", line: 1 },
  ]);
});

test("ignores headings that do not open with a backticked identifier", () => {
  assert.deepEqual(
    symbolicHeadings("## How the pieces fit\n### Constructor\n"),
    [],
  );
});

test("reports the line the heading is on", () => {
  const text = "# Title\n\nIntro.\n\n### `RaftGroup`\n";
  assert.deepEqual(
    symbolicHeadings(text).map((h) => h.line),
    [5],
  );
});

test("collects names mentioned in inline code", () => {
  const names = mentionedNames(
    "Uses `RaftGroup` and `applyLag`, not `RaftGroup` again.\n",
  );
  assert.deepEqual([...names].sort(), ["RaftGroup", "applyLag"]);
});

test("a call or a generic instantiation is a mention of its name", () => {
  // `createNodeDurableFileSystem(calls?)` documents that function. The pattern
  // used to read it as no mention at all, so the page was told to spell the name
  // a second time — a demand produced by the reader, not by the documents.
  const names = mentionedNames(
    "`parseCronField(expr)` and `register<T>(handler)`\n",
  );
  assert.deepEqual([...names].sort(), ["parseCronField", "register"]);
});

test("a dotted path is not a mention of its first segment", () => {
  // `audit.v2` is a file prefix and `store.write` is a method call. Reading
  // their first segment as a mention would let a page cover a symbol by
  // accident, which is the failure direction that matters: a gate must not go
  // green on a document that never named the export.
  assert.deepEqual(
    [...mentionedNames("`audit.v2` and `store.write` and `a.b.c`\n")],
    [],
  );
});

test("accepts a heading naming an exported symbol", () => {
  assert.deepEqual(audit("### `RaftGroup`\n"), []);
});

test("accepts a heading naming a member of an exported type", () => {
  assert.deepEqual(audit("### `propose`\n"), []);
});

test("accepts navigation headings", () => {
  assert.deepEqual(audit("### Constructor\n### Methods\n### Interfaces\n"), []);
});

test("rejects a heading naming a symbol the package never exports", () => {
  const problems = audit("### `FederationEngine`\n");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "unknown-symbol");
  assert.equal(problems[0].name, "FederationEngine");
  assert.equal(problems[0].line, 1);
});

test("rejects a typo in an exported name", () => {
  assert.equal(audit("### `RaftGrup`\n").length, 1);
});

test("reports an exported value no page mentions", () => {
  // The duty is on the package, not on a filename: for two years it fired only
  // on `api-reference.md`, which twelve of fourteen packages did not have.
  const surfaces = [
    {
      entry: { key: "." },
      surface: { values: new Set(["RaftGroup", "applyLag"]) },
    },
  ];
  const findings = undocumentedExports(surfaces, new Set(["applyLag"]));
  assert.deepEqual(findings, [{ entryKey: ".", name: "RaftGroup" }]);
});

test("does not require coverage of type-only exports", () => {
  // A type is documented by the signature that names it; a value is a thing a
  // reader can call, and one that appears in no page is one they cannot find.
  const surfaces = [
    { entry: { key: "." }, surface: { values: new Set(["RaftGroup"]) } },
  ];
  const findings = undocumentedExports(surfaces, new Set());
  assert.deepEqual(
    findings.map((finding) => finding.name),
    ["RaftGroup"],
  );
});

test("judges the root and every subpath, and says which one", () => {
  const surfaces = [
    { entry: { key: "." }, surface: { values: new Set(["Root"]) } },
    {
      entry: { key: "./testing" },
      surface: { values: new Set(["Documented", "Forgotten"]) },
    },
  ];

  const findings = undocumentedExports(surfaces, new Set(["Documented"]));
  assert.deepEqual(findings, [
    { entryKey: ".", name: "Root" },
    { entryKey: "./testing", name: "Forgotten" },
  ]);
});

test("accepts a value mentioned on any page of the package", () => {
  // `docs/architecture.md` may carry a class the `docs/api/` page omits; a
  // reader looking for it still has somewhere to land.
  const surfaces = [
    { entry: { key: "." }, surface: { values: new Set(["RaftGroup"]) } },
  ];
  assert.deepEqual(undocumentedExports(surfaces, new Set(["RaftGroup"])), []);
});

test("finds the packages that ship docs", () => {
  const dirs = workspacePackages(ROOT).map((pkg) => pkg.dir);
  assert.ok(dirs.includes("cluster"), `expected cluster in ${dirs.join(", ")}`);
  assert.ok(dirs.includes("federation"));
  assert.ok(dirs.some((dir) => dir.startsWith("operations/packages/")));
});

test("finds the documents, and finds more than one", () => {
  const docs = markdownFiles(resolve(ROOT, "cluster", "docs"));
  assert.ok(
    docs.length >= 1,
    "a gate over zero documents reports perfect compliance",
  );
  assert.ok(docs.some((file) => file.endsWith("api-reference.md")));
});

test("resolves the export surface through the compiler", () => {
  const cluster = exportSurface(resolve(ROOT, "cluster", "src", "index.ts"));
  assert.ok(cluster.exported.has("RaftGroup"));
  assert.ok(cluster.exported.has("RaftAdapter"));
  assert.ok(cluster.members.has("proposeAndWait"));
  assert.ok(cluster.values.has("RaftGroup"));

  const federation = exportSurface(
    resolve(ROOT, "federation", "src", "index.ts"),
  );
  assert.ok(federation.exported.has("FederationManager"));
  assert.equal(
    federation.exported.has("FederationEngine"),
    false,
    "the class the old reference page documented never existed",
  );
});

test("resolves re-exported namespaces, not just local declarations", () => {
  const operations = exportSurface(
    resolve(ROOT, "operations", "src", "index.ts"),
  );
  assert.ok(operations.exported.size > 0);
  assert.ok(operations.exported.has("core"));
});

test("resolves every published entry point, not just the package root", () => {
  // The gate used to read `src/index.ts` and stop there, so everything a
  // subpath published went unchecked — thirteen symbols of harness that a
  // downstream package is expected to import.
  const cluster = exportEntries(resolve(ROOT, "cluster"));
  const keys = cluster.map((entry) => entry.key);
  assert.ok(keys.includes("."), "the root is an entry point");
  assert.ok(
    keys.includes("./testing"),
    "the harness subpath is an entry point",
  );
  for (const entry of cluster) {
    assert.ok(
      entry.path.endsWith(".ts"),
      `${entry.key} resolves to a source file`,
    );
  }

  const federation = exportEntries(resolve(ROOT, "federation"));
  assert.ok(federation.some((entry) => entry.key === "./testing"));
});

test("a subpath publishes what it means to, not a whole module", () => {
  // `./transport` used to point at the module file, which publishes every
  // module-level export of it — including `retryDelayMs`, marked `@internal`.
  // A tag that the package's own subpath contradicts is not a decision.
  const entry = exportEntries(resolve(ROOT, "federation")).find(
    (candidate) => candidate.key === "./transport",
  );
  assert.ok(entry, "./transport is published");
  const surface = exportSurface(entry.path);
  assert.ok(
    surface.exported.has("TcpSecureTransport"),
    "the transport is published",
  );
  assert.equal(
    surface.exported.has("retryDelayMs"),
    false,
    "an @internal helper is not part of the published surface",
  );
});

test("the real repository passes, subpaths included", () => {
  // A gate that only ever prints "passed" is the same defect one layer out.
  // This runs the whole rule set over the working tree.
  assert.equal(run(ROOT), 0);
});

// ── The rules, against trees that must fail them ──────────────────
//
// Every case below is a package that breaks a rule. Without them the suite
// proves only that the working tree is clean, which is equally consistent with
// a rule that never fires — and one of these rules spent two years never
// firing, so that is not a hypothetical.

const MANIFEST = JSON.stringify({
  name: "@agentix-e/db-fixture",
  exports: { ".": { types: "./dist/index.d.ts" } },
});

/** A throwaway package tree; returns the root the package sits under. */
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-api-fixture-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = join(root, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

test("a package that publishes a value and ships no docs is a finding", (t) => {
  const root = fixtureTree({
    "cluster/package.json": MANIFEST,
    "cluster/src/index.ts": "export class RaftGroup {}\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage(
    { dir: "cluster", abs: join(root, "cluster") },
    root,
  );
  assert.deepEqual(failures, [
    { file: "cluster", line: 0, name: "1", kind: "no-docs" },
  ]);
});

test("a documented package that forgets one value names it and its entry point", (t) => {
  const root = fixtureTree({
    "cluster/package.json": MANIFEST,
    "cluster/src/index.ts":
      "export class Documented {}\nexport class Forgotten {}\n",
    "cluster/docs/api-reference.md":
      "# API\n\n### `Documented`\n\nUse `Documented`.\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage(
    { dir: "cluster", abs: join(root, "cluster") },
    root,
  );
  assert.deepEqual(
    failures.map((failure) => [failure.kind, failure.name, failure.entryKey]),
    [["undocumented-export", "Forgotten", "."]],
  );
  assert.equal(failures[0].file, "cluster: docs/");
});

test("a subpath value no page mentions is reported against that subpath", (t) => {
  const root = fixtureTree({
    "cluster/package.json": JSON.stringify({
      name: "@agentix-e/db-fixture",
      exports: {
        ".": { types: "./dist/index.d.ts" },
        "./testing": { types: "./dist/testing/index.d.ts" },
      },
    }),
    "cluster/src/index.ts": "export class Root {}\n",
    "cluster/src/testing/index.ts":
      "export function awaitAgreement(): void {}\n",
    "cluster/docs/api-reference.md": "# API\n\n### `Root`\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage(
    { dir: "cluster", abs: join(root, "cluster") },
    root,
  );
  assert.deepEqual(
    failures.map((failure) => [failure.kind, failure.name, failure.entryKey]),
    [["undocumented-export", "awaitAgreement", "./testing"]],
  );
});

test("a heading naming a symbol the package does not export fails the package", (t) => {
  const root = fixtureTree({
    "cluster/package.json": MANIFEST,
    "cluster/src/index.ts": "export class RaftGroup {}\n",
    "cluster/docs/api-reference.md": "### `RaftGrup`\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage(
    { dir: "cluster", abs: join(root, "cluster") },
    root,
  );

  // Two findings, and both are true: the heading names a symbol that does not
  // exist, and the misspelling is why the real name is mentioned nowhere.
  const heading = failures.find((failure) => failure.kind === "unknown-symbol");
  assert.deepEqual([heading.name, heading.line], ["RaftGrup", 1]);
  assert.ok(
    failures.some(
      (failure) =>
        failure.kind === "undocumented-export" && failure.name === "RaftGroup",
    ),
    "the misspelling is also why nothing mentions RaftGroup",
  );
});

test("a package with no published entry point is not judged", (t) => {
  // The operations aggregator ships types and a namespace; a package that
  // publishes nothing has no surface to document and must not be dragged in.
  const root = fixtureTree({
    "cluster/package.json": JSON.stringify({ name: "@agentix-e/db-fixture" }),
    "cluster/src/index.ts": "export type Shape = { a: 1 };\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root),
    {
      failures: [],
      notes: [],
    },
  );
});

// ── Imports in fenced examples ────────────────────────────────────
//
// `operations/docs/getting-started.md` told a reader to
// `import { HealthOrchestrator, ComponentProbe }` from the health package, which
// exports `componentProbe`. The example could not compile, and the heading rule
// cannot see it — a fenced block has no headings.

const REAL_TREE_INDEX = packageIndex(ROOT);

test("a documented name the package does not export is reported", () => {
  const findings = unresolvedImports(
    '```ts\nimport { HealthOrchestrator, ComponentProbe } from "@agentix-e/db-operations-node/health";\n```\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.name]),
    [["unresolved-import", "ComponentProbe"]],
  );
});

test("a subpath that is not published is reported", () => {
  const findings = unresolvedImports(
    'import { X } from "@agentix-e/db-operations-node/core/internal";\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.name]),
    [["unknown-subpath", "@agentix-e/db-operations-node/core/internal"]],
  );
});

test("a package that is not in this repository is reported", () => {
  const findings = unresolvedImports(
    'import { X } from "@agentix-e/db-nope";\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ["unknown-package"],
  );
});

test("an import from outside this repository's scope is left alone", () => {
  // An example may legitimately import `node:fs` or an SDK, and this gate knows
  // nothing about either.
  const findings = unresolvedImports(
    'import { readFileSync } from "node:fs";\nimport { S3Client } from "@aws-sdk/client-s3";\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(findings, []);
});

test("a specifier splits into a package name and an entry key", () => {
  // The package name is the scope plus one segment; everything after it is an
  // entry key. It used to be the whole string, because every package had exactly
  // one entry — and a gate that cannot see a subpath cannot check that the
  // subpath exists.
  assert.deepEqual(splitSpecifier("@agentix-e/db-operations-node"), {
    name: "@agentix-e/db-operations-node",
    key: ".",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-operations-node/core"), {
    name: "@agentix-e/db-operations-node",
    key: "./core",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-operations-node/core/types"), {
    name: "@agentix-e/db-operations-node",
    key: "./core/types",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-cluster/testing"), {
    name: "@agentix-e/db-cluster",
    key: "./testing",
  });
});

test("the line number of a bad import is the line the reader sees", () => {
  const findings = unresolvedImports(
    '# Title\n\nIntro.\n\n```ts\nimport { Nope } from "@agentix-e/db-operations-node/core";\n```\n',
    REAL_TREE_INDEX,
  );
  assert.equal(findings[0].line, 6);
});

test("the repository's own documentation is checked too", (t) => {
  // `docs/user-guide/operations.md` imports from eight packages at once and
  // belongs to none of them, so the per-package pass never sees it. Five of its
  // imports did not resolve, in the page a new user is told to start with.
  const build = (importLine) => {
    const root = fixtureTree({
      "pnpm-workspace.yaml": "packages:\n  - cluster\n",
      "cluster/package.json": MANIFEST,
      "cluster/src/index.ts": "export class RaftGroup {}\n",
      "cluster/docs/api-reference.md": "### `RaftGroup`\n",
      "docs/guide.md": `# Guide\n\n\`\`\`ts\n${importLine}\n\`\`\`\n`,
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };

  assert.equal(
    run(build('import { RaftGroup } from "@agentix-e/db-fixture";')),
    0,
  );
  assert.equal(
    run(build('import { RaftGroup, Missing } from "@agentix-e/db-fixture";')),
    1,
    "an unresolvable import in the guide has to fail the gate",
  );
});

test("every kind of finding has a sentence that says what to do about it", () => {
  // `describe` is where a rule becomes advice. A finding printed as
  // "[object Object]" is a gate that ran and told nobody anything.
  assert.equal(
    describe({ kind: "unknown-symbol", file: "a.md", line: 4, name: "Foo" }),
    "a.md:4 names `Foo`, which the package does not export and no exported type declares",
  );
  assert.match(
    describe({ kind: "no-docs", file: "pkg-x", name: 6 }),
    /^pkg-x publishes 6 exported value\(s\) and has no `docs\/` tree/,
  );
  assert.match(
    describe({
      kind: "unresolved-import",
      file: "a.md",
      line: 2,
      name: "Counter",
      specifier: "@s/m",
    }),
    /^a\.md:2 tells the reader to import `Counter` from "@s\/m", which does not export it/,
  );
  assert.match(
    describe({
      kind: "unknown-subpath",
      file: "a.md",
      line: 2,
      specifier: "@s/m/nope",
    }),
    /^a\.md:2 imports from "@s\/m\/nope", which is not a published entry point/,
  );
  assert.match(
    describe({
      kind: "unknown-package",
      file: "a.md",
      line: 2,
      specifier: "@s/nope",
    }),
    /which is not a package here$/,
  );
  assert.match(
    describe({
      kind: "missing-index-row",
      file: "README.md",
      name: "federation",
    }),
    /does not link `\.\/packages\/federation\/`, a package that exists/,
  );
  assert.match(
    describe({
      kind: "stale-index-row",
      file: "README.md",
      line: 9,
      name: "gone",
    }),
    /^README\.md:9 links `\.\/packages\/gone\/`, which does not exist$/,
  );
  assert.match(
    describe({
      kind: "duplicate-index-row",
      file: "README.md",
      line: 9,
      name: "core",
    }),
    /^README\.md:9 links `\.\/packages\/core\/` a second time$/,
  );
  assert.equal(
    describe({
      kind: "undocumented-export",
      file: "p: docs/",
      name: "applyLag",
      entryKey: ".",
    }),
    "p: docs/ never mentions `applyLag`, which the package exports",
  );
  assert.equal(
    describe({
      kind: "undocumented-export",
      file: "p: docs/",
      name: "applyLag",
      entryKey: "./beta",
    }),
    "p: docs/ never mentions `applyLag`, which the subpath `./beta` exports",
  );
});

test("the package index is compared to the directory in both directions", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-api-"));
  try {
    const packagesDir = join(root, "packages");
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(packagesDir, name), { recursive: true });
      writeFileSync(join(packagesDir, name, "package.json"), "{}");
    }
    mkdirSync(join(packagesDir, "not-a-package"), { recursive: true });

    const readme = join(root, "README.md");
    writeFileSync(
      readme,
      [
        "| [`alpha`](./packages/alpha/) | ✅ |",
        "| [`gone`](./packages/gone/) | ✅ |",
      ].join("\n"),
    );

    const { failures, notes } = auditPackageIndex({
      readme,
      packagesDir,
      root,
    });

    assert.deepEqual(
      failures.map((failure) => [failure.kind, failure.name]),
      [
        ["missing-index-row", "beta"],
        ["stale-index-row", "gone"],
      ],
    );
    // A directory with no manifest is not a package, so it is neither missing
    // from the table nor reported as stale.
    assert.deepEqual(notes, ["README.md: 2 package(s) on disk, 2 listed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a table that links the same package twice is a table edited by appending", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-api-"));
  try {
    const packagesDir = join(root, "packages");
    mkdirSync(join(packagesDir, "alpha"), { recursive: true });
    writeFileSync(join(packagesDir, "alpha", "package.json"), "{}");

    const readme = join(root, "README.md");
    writeFileSync(
      readme,
      [
        "| [`alpha`](./packages/alpha/) | ✅ |",
        "| [`alpha`](./packages/alpha/) | ✅ |",
      ].join("\n"),
    );

    const { failures } = auditPackageIndex({ readme, packagesDir, root });

    assert.deepEqual(
      failures.map((failure) => [failure.kind, failure.line]),
      [["duplicate-index-row", 2]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report prints the notes, then the verdict", () => {
  const out = [];
  const code = report([], ["a: 1 package", "b: 2 packages"], {
    log: (line) => out.push(line),
    verbose: false,
  });

  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.equal(
    out[0],
    "✓ docs-api: every documented symbol resolves (a: 1 package; b: 2 packages)",
  );
});

test("report prints every finding through describe(), and returns 1", () => {
  const err = [];
  const code = report(
    [
      { kind: "unknown-symbol", file: "a.md", line: 4, name: "Foo" },
      { kind: "missing-index-row", file: "README.md", name: "federation" },
    ],
    [],
    { error: (line) => err.push(line) },
  );

  assert.equal(code, 1);
  assert.match(err[0], /✗ docs-api: 2 finding\(s\)/);
  assert.match(err[1], /^  a\.md:4 names `Foo`/);
  assert.match(err[2], /^  README\.md does not link/);
  assert.match(err.at(-1), /An API reference is a promise about the package/);
});

test("report with a clean run and no notes says so without parentheses", () => {
  const out = [];
  const code = report([], [], { log: (line) => out.push(line) });

  assert.equal(code, 0);
  assert.deepEqual(out, ["✓ docs-api: every documented symbol resolves"]);
});

test("report prints the notes in verbose mode before the verdict", () => {
  const out = [];
  report([], ["one"], { log: (line) => out.push(line), verbose: true });

  assert.deepEqual(out, [
    "  one",
    "✓ docs-api: every documented symbol resolves (one)",
  ]);
});

test("a package README is judged like any other page", () => {
  // The README is what the registry shows first, and its examples are imports
  // like any other. Ten packages shipped none until iteration 54; this case is
  // the rule that now reads the ones that exist.
  const root = mkdtempSync(join(tmpdir(), "docs-api-"));
  try {
    const pkg = join(root, "cluster");
    const write = (path, text) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(root, "pnpm-workspace.yaml"), "packages:\n  - cluster\n");
    write(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@agentix-e/db-cluster",
        exports: { ".": "./dist/index.d.ts" },
      }),
    );
    write(
      join(pkg, "src", "index.ts"),
      "export const RaftGroup = 1;\nexport function applyLag() {}\n",
    );
    write(
      join(pkg, "docs", "api", "gate.md"),
      "# API\n\n`RaftGroup` is the entry; call `applyLag()` after a snapshot.\n\n" +
        '```ts\nimport { Missing } from "@agentix-e/db-cluster";\n```\n',
    );
    write(
      join(pkg, "README.md"),
      '```ts\nimport { RaftGroup, Nope } from "@agentix-e/db-cluster";\n```\n',
    );

    const packages = workspacePackages(root);
    assert.deepEqual(
      packages.map((entry) => entry.dir),
      ["cluster"],
    );

    const { failures } = auditPackage(packages[0], root, packageIndex(root));

    // One finding per page: the docs tree and the README are read the same way,
    // which is the rule iteration 54 added after ten packages shipped no README.
    assert.deepEqual(
      failures.map((failure) => [
        failure.kind,
        failure.name,
        failure.file.split("/").at(-1),
      ]),
      [
        ["unresolved-import", "Missing", "gate.md"],
        ["unresolved-import", "Nope", "README.md"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package that publishes nothing is not judged", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-api-"));
  try {
    const pkg = join(root, "cluster");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - cluster\n",
    );
    writeFileSync(join(pkg, "src", "index.ts"), "export const internal = 1;\n");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@agentix-e/db-cluster" }),
    );

    const [entry] = workspacePackages(root);
    assert.deepEqual(auditPackage(entry, root, packageIndex(root)), {
      failures: [],
      notes: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages are discovered from the workspace file, globs and all", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-api-"));
  try {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - cluster\n  - operations/packages/*\n",
    );
    for (const dir of ["core", "health"]) {
      const abs = join(root, "operations", "packages", dir);
      mkdirSync(join(abs, "src"), { recursive: true });
      writeFileSync(join(abs, "src", "index.ts"), "export const x = 1;\n");
      writeFileSync(
        join(abs, "package.json"),
        JSON.stringify({ name: `@agentix-e/db-${dir}` }),
      );
    }
    // A directory without an index is not a package with an API surface.
    mkdirSync(join(root, "operations", "packages", "empty"), {
      recursive: true,
    });

    // `cluster` is listed in the workspace file and has no `src/index.ts` here, so it
    // is not a package with a surface; the glob is expanded, not guessed at.
    assert.deepEqual(
      workspacePackages(root).map((entry) => entry.dir),
      ["operations/packages/core", "operations/packages/health"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exports map is read in the three shapes it is written in", (t) => {
  const root = fixtureTree({
    // No `exports` at all: a package that publishes nothing is not a package whose
    // entries can be resolved, and the gate has nothing to say about it.
    "plain/package.json": JSON.stringify({ name: "plain" }),
    "plain/src/index.ts": "export const value = 1;\n",
    // A string target names the file directly; a subpath key resolves through its
    // own directory when the string does not exist.
    "stringy/package.json": JSON.stringify({
      name: "stringy",
      exports: { ".": "./dist/index.d.ts", "./beta": "./dist/beta.d.ts" },
    }),
    "stringy/src/index.ts": "export const value = 1;\n",
    "stringy/src/beta/index.ts": "export const beta = 1;\n",
    // A conditional target with no `types` is a runtime-only export: it names no
    // declaration, so there is no entry for the documentation rules to compare.
    "runtime/package.json": JSON.stringify({
      name: "runtime",
      exports: { ".": { import: "./dist/index.mjs" } },
    }),
    "runtime/src/index.ts": "export const value = 1;\n",
    // `./package.json` is the manifest, not an entry point.
    "manifest/package.json": JSON.stringify({
      name: "manifest",
      exports: {
        ".": { types: "./dist/index.d.ts" },
        "./package.json": "./package.json",
      },
    }),
    "manifest/src/index.ts": "export const value = 1;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(exportEntries(join(root, "plain")), []);
  assert.deepEqual(exportEntries(join(root, "runtime")), []);
  assert.deepEqual(
    exportEntries(join(root, "stringy")).map((entry) => entry.key),
    [".", "./beta"],
  );
  assert.deepEqual(
    exportEntries(join(root, "manifest")).map((entry) => entry.key),
    ["."],
  );
});

test("a specifier is split at the scope when there is one, and at the first segment when there is not", () => {
  assert.deepEqual(splitSpecifier("@agentix-e/db-cluster/shard"), {
    name: "@agentix-e/db-cluster",
    key: "./shard",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-cluster"), {
    name: "@agentix-e/db-cluster",
    key: ".",
  });
  // A package published without a scope is `name`, not `name/segment`: reading the
  // first two segments would invent a scope it never had.
  assert.deepEqual(splitSpecifier("left-pad/sub"), {
    name: "left-pad",
    key: "./sub",
  });
  assert.deepEqual(splitSpecifier("left-pad"), { name: "left-pad", key: "." });
});

test("a manifest with no name is not an entry in the index, and a default export is not a name", (t) => {
  const root = fixtureTree({
    // The workspace file is what makes them packages; a directory is not one.
    "pnpm-workspace.yaml": "packages:\n  - named\n  - unnamed\n",
    "named/package.json": JSON.stringify({
      name: "@agentix-e/db-named",
      exports: { ".": { types: "./dist/index.d.ts" } },
    }),
    "named/src/index.ts":
      "export class Present {}\nexport default function main() { return 1; }\n",
    "unnamed/package.json": JSON.stringify({ exports: {} }),
    "unnamed/src/index.ts": "export const whatever = 1;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const index = packageIndex(root);

  assert.deepEqual([...index.keys()], ["@agentix-e/db-named"]);
  // `default` is a name a consumer can write only through the default import form,
  // so the coverage rule does not require a page to mention it.
  assert.deepEqual(
    [...index.get("@agentix-e/db-named").entries.get(".")],
    ["Present"],
  );
});
