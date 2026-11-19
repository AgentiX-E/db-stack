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
  assert.deepEqual(symbolicHeadings("### `RaftGroup`\n"), [{ name: "RaftGroup", line: 1 }]);
});

test("reads a heading whose signature starts with a modifier", () => {
  assert.deepEqual(symbolicHeadings("### `async stop(): Promise<void>`\n"), [
    { name: "stop", line: 1 },
  ]);
  assert.deepEqual(symbolicHeadings("### `static reset(): void`\n"), [{ name: "reset", line: 1 }]);
  assert.deepEqual(symbolicHeadings("### `readonly size: number`\n"), [{ name: "size", line: 1 }]);
});

test("ignores headings that do not open with a backticked identifier", () => {
  assert.deepEqual(symbolicHeadings("## How the pieces fit\n### Constructor\n"), []);
});

test("reports the line the heading is on", () => {
  const text = "# Title\n\nIntro.\n\n### `RaftGroup`\n";
  assert.deepEqual(symbolicHeadings(text).map((h) => h.line), [5]);
});

test("collects names mentioned in inline code", () => {
  const names = mentionedNames("Uses `RaftGroup` and `applyLag`, not `RaftGroup` again.\n");
  assert.deepEqual([...names].sort(), ["RaftGroup", "applyLag"]);
});

test("a call or a generic instantiation is a mention of its name", () => {
  // `createNodeDurableFileSystem(calls?)` documents that function. The pattern
  // used to read it as no mention at all, so the page was told to spell the name
  // a second time — a demand produced by the reader, not by the documents.
  const names = mentionedNames("`parseCronField(expr)` and `register<T>(handler)`\n");
  assert.deepEqual([...names].sort(), ["parseCronField", "register"]);
});

test("a dotted path is not a mention of its first segment", () => {
  // `audit.v2` is a file prefix and `store.write` is a method call. Reading
  // their first segment as a mention would let a page cover a symbol by
  // accident, which is the failure direction that matters: a gate must not go
  // green on a document that never named the export.
  assert.deepEqual([...mentionedNames("`audit.v2` and `store.write` and `a.b.c`\n")], []);
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
  const surfaces = [{ entry: { key: "." }, surface: { values: new Set(["RaftGroup", "applyLag"]) } }];
  const findings = undocumentedExports(surfaces, new Set(["applyLag"]));
  assert.deepEqual(findings, [{ entryKey: ".", name: "RaftGroup" }]);
});

test("does not require coverage of type-only exports", () => {
  // A type is documented by the signature that names it; a value is a thing a
  // reader can call, and one that appears in no page is one they cannot find.
  const surfaces = [{ entry: { key: "." }, surface: { values: new Set(["RaftGroup"]) } }];
  const findings = undocumentedExports(surfaces, new Set());
  assert.deepEqual(findings.map((finding) => finding.name), ["RaftGroup"]);
});

test("judges the root and every subpath, and says which one", () => {
  const surfaces = [
    { entry: { key: "." }, surface: { values: new Set(["Root"]) } },
    { entry: { key: "./testing" }, surface: { values: new Set(["Documented", "Forgotten"]) } },
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
  const surfaces = [{ entry: { key: "." }, surface: { values: new Set(["RaftGroup"]) } }];
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
  assert.ok(docs.length >= 1, "a gate over zero documents reports perfect compliance");
  assert.ok(docs.some((file) => file.endsWith("api-reference.md")));
});

test("resolves the export surface through the compiler", () => {
  const cluster = exportSurface(resolve(ROOT, "cluster", "src", "index.ts"));
  assert.ok(cluster.exported.has("RaftGroup"));
  assert.ok(cluster.exported.has("RaftAdapter"));
  assert.ok(cluster.members.has("proposeAndWait"));
  assert.ok(cluster.values.has("RaftGroup"));

  const federation = exportSurface(resolve(ROOT, "federation", "src", "index.ts"));
  assert.ok(federation.exported.has("FederationManager"));
  assert.equal(
    federation.exported.has("FederationEngine"),
    false,
    "the class the old reference page documented never existed",
  );
});

test("resolves re-exported namespaces, not just local declarations", () => {
  const operations = exportSurface(resolve(ROOT, "operations", "src", "index.ts"));
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
  assert.ok(keys.includes("./testing"), "the harness subpath is an entry point");
  for (const entry of cluster) {
    assert.ok(entry.path.endsWith(".ts"), `${entry.key} resolves to a source file`);
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
  assert.ok(surface.exported.has("TcpSecureTransport"), "the transport is published");
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

  const { failures } = auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root);
  assert.deepEqual(failures, [{ file: "cluster", line: 0, name: "1", kind: "no-docs" }]);
});

test("a documented package that forgets one value names it and its entry point", (t) => {
  const root = fixtureTree({
    "cluster/package.json": MANIFEST,
    "cluster/src/index.ts": "export class Documented {}\nexport class Forgotten {}\n",
    "cluster/docs/api-reference.md": "# API\n\n### `Documented`\n\nUse `Documented`.\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root);
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
    "cluster/src/testing/index.ts": "export function awaitAgreement(): void {}\n",
    "cluster/docs/api-reference.md": "# API\n\n### `Root`\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { failures } = auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root);
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

  const { failures } = auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root);

  // Two findings, and both are true: the heading names a symbol that does not
  // exist, and the misspelling is why the real name is mentioned nowhere.
  const heading = failures.find((failure) => failure.kind === "unknown-symbol");
  assert.deepEqual([heading.name, heading.line], ["RaftGrup", 1]);
  assert.ok(
    failures.some((failure) => failure.kind === "undocumented-export" && failure.name === "RaftGroup"),
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

  assert.deepEqual(auditPackage({ dir: "cluster", abs: join(root, "cluster") }, root), {
    failures: [],
    notes: [],
  });
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
    '```ts\nimport { HealthOrchestrator, ComponentProbe } from "@agentix-e/db-operations-health";\n```\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.name]),
    [["unresolved-import", "ComponentProbe"]],
  );
});

test("a subpath that is not published is reported", () => {
  const findings = unresolvedImports(
    'import { X } from "@agentix-e/db-operations-core/internal";\n',
    REAL_TREE_INDEX,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.name]),
    [["unknown-subpath", "@agentix-e/db-operations-core/internal"]],
  );
});

test("a package that is not in this repository is reported", () => {
  const findings = unresolvedImports('import { X } from "@agentix-e/db-nope";\n', REAL_TREE_INDEX);
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
  assert.deepEqual(splitSpecifier("@agentix-e/db-operations-core"), {
    name: "@agentix-e/db-operations-core",
    key: ".",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-operations-core/types"), {
    name: "@agentix-e/db-operations-core",
    key: "./types",
  });
  assert.deepEqual(splitSpecifier("@agentix-e/db-cluster/testing"), {
    name: "@agentix-e/db-cluster",
    key: "./testing",
  });
});

test("the line number of a bad import is the line the reader sees", () => {
  const findings = unresolvedImports(
    '# Title\n\nIntro.\n\n```ts\nimport { Nope } from "@agentix-e/db-operations-core";\n```\n',
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
      "cluster/package.json": MANIFEST,
      "cluster/src/index.ts": "export class RaftGroup {}\n",
      "cluster/docs/api-reference.md": "### `RaftGroup`\n",
      "docs/guide.md": `# Guide\n\n\`\`\`ts\n${importLine}\n\`\`\`\n`,
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };

  assert.equal(run(build('import { RaftGroup } from "@agentix-e/db-fixture";')), 0);
  assert.equal(
    run(build('import { RaftGroup, Missing } from "@agentix-e/db-fixture";')),
    1,
    "an unresolvable import in the guide has to fail the gate",
  );
});
