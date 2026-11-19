/**
 * Tests for the public-type gate.
 *
 * The gate exists because `FederationManager.replicate()` returned a type the
 * package never exported: callable, not nameable. A gate that only ever prints
 * "passed" would be the same defect one layer out, so these cases build the
 * smallest package that shows each shape and pin both directions — a type a
 * caller must name is reported, and every shape that is legitimately unexported
 * (a dependency's type, an anonymous object type, a method) is left alone.
 *
 * The last two cases run over the real repository, because a walk that silently
 * visits nothing reports perfect compliance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ts from "typescript";
import {
  auditPackage,
  entryExports,
  publishedEntries,
} from "./check-public-types.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A throwaway package: `files` maps a relative path to its contents. */
function fixturePackage(files) {
  const dir = mkdtempSync(join(tmpdir(), "public-types-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, "src", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function findings(dir) {
  const result = auditPackage(join(dir, "src", "index.ts"), `${dir}/`);
  return result.findings;
}

function withFixture(files, assertion) {
  const dir = fixturePackage(files);
  try {
    assertion(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports a return type the entry point never exports", () => {
  withFixture(
    {
      "index.ts": "export { start } from './start';\n",
      "start.ts": [
        "export interface Replicated { id: string }",
        "export function start(): Replicated { return { id: 'a' }; }",
      ].join("\n"),
    },
    (dir) => {
      const found = findings(dir);
      assert.equal(found.length, 1);
      assert.equal(found[0].name, "Replicated");
      assert.match(found[0].via, /start\(\):/);
    },
  );
});

test("accepts the same package once the type is exported", () => {
  withFixture(
    {
      "index.ts":
        "export { start } from './start';\nexport type { Replicated } from './start';\n",
      "start.ts": [
        "export interface Replicated { id: string }",
        "export function start(): Replicated { return { id: 'a' }; }",
      ].join("\n"),
    },
    (dir) => assert.deepEqual(findings(dir), []),
  );
});

test("accepts a type re-exported under a different name", () => {
  withFixture(
    {
      "index.ts":
        "export { start } from './start';\nexport type { Replicated as Entry } from './start';\n",
      "start.ts": [
        "export interface Replicated { id: string }",
        "export function start(): Replicated { return { id: 'a' }; }",
      ].join("\n"),
    },
    (dir) =>
      assert.deepEqual(
        findings(dir),
        [],
        "a rename still makes the type importable",
      ),
  );
});

test("reports a parameter type a caller must construct", () => {
  withFixture(
    {
      "index.ts": "export * from './options';\n",
      "options.ts": [
        "interface Options { retries: number }",
        "export function connect(options: Options): void { void options.retries; }",
      ].join("\n"),
    },
    (dir) => {
      const found = findings(dir);
      assert.deepEqual(
        found.map((f) => f.name),
        ["Options"],
      );
      assert.match(found[0].via, /connect\(options\)/);
    },
  );
});

test("walks through an unexported type into the types it names", () => {
  withFixture(
    {
      "index.ts": "export { start } from './start';\n",
      "start.ts": [
        "export interface Inner { id: string }",
        "export interface Middle { inner: Inner }",
        "export function start(): Middle { return { inner: { id: 'a' } }; }",
      ].join("\n"),
    },
    (dir) => {
      const names = findings(dir).map((f) => f.name);
      assert.ok(names.includes("Middle"), "the outer type is reported");
      assert.ok(
        names.includes("Inner"),
        "exporting Middle publishes Inner, so it is reported too",
      );
    },
  );
});

test("does not report a type declared by a dependency", () => {
  withFixture(
    {
      "index.ts": "export { start } from './start';\n",
      "start.ts": [
        "export function start(): Date { return new Date(); }",
        "export function fail(): Promise<Error> { return Promise.reject(new Error('x')); }",
      ].join("\n"),
    },
    (dir) => assert.deepEqual(findings(dir), []),
  );
});

test("does not report methods as if they were types", () => {
  withFixture(
    {
      "index.ts": "export { Client } from './client';\n",
      "client.ts": [
        "export class Client {",
        "  send(payload: string): void { void payload; }",
        "  get size(): number { return 1; }",
        "}",
      ].join("\n"),
    },
    (dir) =>
      assert.deepEqual(
        findings(dir),
        [],
        "a method is reachable through its object, not by import",
      ),
  );
});

test("does not report private or protected member types", () => {
  withFixture(
    {
      "index.ts": "export { Client } from './client';\n",
      "client.ts": [
        "interface Secret { token: string }",
        "export class Client {",
        "  private readonly secret: Secret = { token: 'a' };",
        "  get token(): string { return this.secret.token; }",
        "}",
      ].join("\n"),
    },
    (dir) => assert.deepEqual(findings(dir), []),
  );
});

test("reports a constructor parameter type", () => {
  withFixture(
    {
      "index.ts": "export { Store } from './store';\n",
      "store.ts": [
        "interface StoreConfig { file: string }",
        "export class Store {",
        "  constructor(private readonly config: StoreConfig) {}",
        "  get file(): string { return this.config.file; }",
        "}",
      ].join("\n"),
    },
    (dir) => {
      const found = findings(dir);
      assert.deepEqual(
        found.map((f) => f.name),
        ["StoreConfig"],
        "a parameter property is named in the constructor signature",
      );
    },
  );
});

test("reports each missing type once, not once per mention", () => {
  withFixture(
    {
      "index.ts": "export * from './api';\n",
      "api.ts": [
        "interface Shared { id: string }",
        "export function a(): Shared { return { id: 'a' }; }",
        "export function b(): Shared[] { return []; }",
      ].join("\n"),
    },
    (dir) => assert.equal(findings(dir).length, 1),
  );
});

test("resolves the export surface of a real package", () => {
  const entry = resolve(ROOT, "cluster", "src", "index.ts");
  const program = auditPackage(entry, resolve(ROOT, "cluster") + "/");
  assert.ok(
    program.exported > 100,
    `expected a real surface, got ${program.exported}`,
  );
});

test("finds the workspace packages, and finds more than one", () => {
  // A walk over zero packages reports perfect compliance for the same reason a
  // walk over zero documents does.
  const packages = [
    "cluster",
    "federation",
    "operations/packages/security",
    "operations/packages/backup",
  ];
  for (const dir of packages) {
    const result = auditPackage(
      resolve(ROOT, dir, "src", "index.ts"),
      resolve(ROOT, dir) + "/",
    );
    assert.ok(result.exported > 0, `${dir} resolved no exports`);
  }
});

test("does not report an anonymous object type", () => {
  withFixture(
    {
      "index.ts": "export { describe } from './describe';\n",
      "describe.ts":
        "export function describe(): { id: string } { return { id: 'a' }; }\n",
    },
    (dir) =>
      assert.deepEqual(findings(dir), [], "an inline shape needs no import"),
  );
});

test("reports a union arm declared by the package", () => {
  withFixture(
    {
      "index.ts": "export { mode } from './mode';\n",
      "mode.ts": [
        "type Mode = 'fast' | 'slow';",
        "export function mode(): Mode { return 'fast'; }",
      ].join("\n"),
    },
    (dir) => {
      assert.deepEqual(
        findings(dir).map((f) => f.name),
        ["Mode"],
      );
    },
  );
});

test("counts a renamed export as one export", () => {
  withFixture(
    {
      "index.ts": "export { value as renamed } from './value';\n",
      "value.ts": "export const value = 1;\n",
    },
    (dir) => {
      const result = auditPackage(join(dir, "src", "index.ts"), `${dir}/`);
      assert.equal(result.exported, 1);
      assert.deepEqual(result.findings, []);
    },
  );
});

test("maps every published subpath back to the source file it is built from", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-types-exports-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./testing": {
            types: "./dist/testing/index.d.ts",
            import: "./dist/testing/index.js",
          },
          "./package.json": "./package.json",
        },
      }),
    );
    const entries = publishedEntries(dir);
    assert.deepEqual(
      entries.map((entry) => [
        entry.subpath,
        entry.source.endsWith("/src/testing/index.ts"),
      ]),
      [
        [".", false],
        ["./testing", true],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a subpath whose types are exported by the root instead", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-types-union-"));
  try {
    mkdirSync(join(dir, "src", "testing"), { recursive: true });
    writeFileSync(
      join(dir, "src", "index.ts"),
      "export { start } from './start';\nexport type { Replicated } from './start';\n",
    );
    writeFileSync(
      join(dir, "src", "start.ts"),
      "export interface Replicated { id: string }\nexport function start(): Replicated { return { id: 'a' }; }\n",
    );
    writeFileSync(
      join(dir, "src", "testing", "index.ts"),
      "export { start } from '../start';\n",
    );

    const root = join(dir, "src", "index.ts");
    const subpath = join(dir, "src", "testing", "index.ts");
    const program = ts.createProgram([root, subpath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
    });

    const alone = auditPackage(subpath, `${dir}/`, { program });
    assert.deepEqual(
      alone.findings.map((f) => f.name),
      ["Replicated"],
      "judged on its own, the subpath names a type it does not export",
    );

    const withRoot = auditPackage(subpath, `${dir}/`, {
      program,
      elsewhere: entryExports(program, root).symbols,
    });
    assert.deepEqual(
      withRoot.findings,
      [],
      "a consumer importing the subpath can still import the type from the root",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
