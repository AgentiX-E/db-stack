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
import { resolve } from "node:path";

import {
  auditDocument,
  exportEntries,
  exportSurface,
  markdownFiles,
  mentionedNames,
  run,
  symbolicHeadings,
  undocumentedSubpathExports,
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
    requireFullCoverage: false,
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

test("requires an api-reference page to mention every exported value", () => {
  const problems = audit("### `RaftGroup`\n", { requireFullCoverage: true });
  assert.deepEqual(problems, []);
});

test("reports an exported value the api-reference page never mentions", () => {
  const problems = audit("Nothing here.\n", { requireFullCoverage: true });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "undocumented-export");
  assert.equal(problems[0].name, "RaftGroup");
});

test("does not require coverage of type-only exports", () => {
  const problems = audit("### `RaftGroup`\n", { requireFullCoverage: true });
  assert.equal(problems.filter((p) => p.name === "applyLag").length, 0);
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

test("names the subpath values no page mentions", () => {
  const surfaces = [
    { entry: { key: "." }, surface: { values: new Set(["Root"]) } },
    { entry: { key: "./testing" }, surface: { values: new Set(["Documented", "Forgotten"]) } },
  ];

  const findings = undocumentedSubpathExports(surfaces, new Set(["Root", "Documented"]));
  assert.deepEqual(findings, [{ entryKey: "./testing", name: "Forgotten" }]);

  // The root is checked by `api-reference.md` instead; it must not appear twice.
  assert.equal(
    findings.some((finding) => finding.name === "Root"),
    false,
  );
});

test("the real repository passes, subpaths included", () => {
  // A gate that only ever prints "passed" is the same defect one layer out.
  // This runs the whole rule set over the working tree.
  assert.equal(run(ROOT), 0);
});
