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
import { spawnSync } from "node:child_process";

import ts from "typescript";
import {
  auditPackage,
  entryExports,
  publishedEntries,
  run,
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

/** A package directory built from `{ path: contents }`, removed afterwards. */
function withPackage(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "public-types-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("publishedEntries maps each declared target back to the source it is built from", () => {
  withPackage(
    {
      "package.json": JSON.stringify({
        exports: {
          "./package.json": "./package.json",
          "./shorthand": "./dist/shorthand.js",
          ".": { types: "./dist/index.d.ts" },
          "./sub": { import: "./dist/sub/index.js" },
          "./nothing": { default: "./dist/nothing.js" },
          "./no-types": { types: "./dist/types/index.d.ts" },
        },
      }),
    },
    (dir) => {
      const entries = publishedEntries(dir).map((entry) => [
        entry.subpath,
        entry.declared,
        entry.source.slice(dir.length + 1),
      ]);

      assert.deepEqual(entries, [
        [".", "./dist/index.d.ts", "src/index.ts"],
        ["./sub", "./dist/sub/index.js", "src/sub/index.ts"],
        ["./no-types", "./dist/types/index.d.ts", "src/types/index.ts"],
      ]);
    },
  );
});

test("a package that publishes no exports map has no entries", () => {
  withPackage({ "package.json": JSON.stringify({ name: "x" }) }, (dir) => {
    assert.deepEqual(publishedEntries(dir), []);
  });
});

test("run reports a subpath whose declared target has no source file", () => {
  const lines = [];
  const errors = [];
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./present": { types: "./dist/present/index.d.ts" },
          "./shard": { types: "./dist/shard/index.d.ts" },
        },
      }),
      "cluster/src/index.ts": "export const a = 1;\n",
      "cluster/src/present/index.ts": "export const b = 2;\n",
    },
    (dir) => {
      const code = run(dir, {
        log: (line) => lines.push(line),
        error: (line) => errors.push(line),
        verbose: true,
      });

      assert.equal(code, 1);
      assert.match(errors[0], /✗ public-types: 1 finding\(s\)/);
      assert.match(
        errors[1],
        /^  cluster: publishes `\.\/shard` but \.\/dist\/shard\/index\.d\.ts has no source file$/,
      );
      // The note says what was measured, which is how a reader knows the gate
      // looked at the subpath at all.
      assert.match(
        lines[0],
        /^  cluster: 1 exports, 2 entry\(s\), 0 unnameable type\(s\)$/,
      );
    },
  );
});

test("run reports a type a public signature names and no published entry exports", () => {
  const errors = [];
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "interface Hidden { id: string }",
        "export function make(): Hidden { return { id: 'x' }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      const code = run(dir, {
        error: (line) => errors.push(line),
        log: () => {},
      });

      assert.equal(code, 1);
      // The sentence and its evidence are one message: what is named, where it
      // was named, and which signature named it.
      assert.match(
        errors[1],
        /^  cluster: `Hidden` appears in a public signature but no published entry exports it \(src\/index\.ts\)\n      via make\(\):/,
      );
      assert.match(
        errors[2],
        /A type a consumer has to name must be importable from a published entry/,
      );
    },
  );
});

test("run passes a package whose signatures only name exported types", () => {
  const lines = [];
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts":
        "export interface Shown { id: string }\nexport function make(): Shown { return { id: 'x' }; }\n",
    },
    (dir) => {
      const code = run(dir, { log: (line) => lines.push(line) });

      assert.equal(code, 0);
      assert.match(
        lines[0],
        /✓ public-types: every type named by a public signature is exportable from a published entry \(1 packages\)/,
      );
    },
  );
});

test("the command line exits 0 on this workspace", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-public-types.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0);
  assert.match(
    child.stdout,
    /✓ public-types: every type named by a public signature/,
  );
});

test("a default export is not a type a consumer has to name", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "export default class Thing { id = 'x'; }",
        "export interface Shown { id: string }",
        "export function make(): Shown { return { id: 'x' }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      const lines = [];
      const code = run(dir, { log: (line) => lines.push(line) });

      assert.equal(code, 0);
      assert.match(
        lines[0],
        /exportable from a published entry \(1 packages\)/,
      );
    },
  );
});

test("a namespace-qualified type is judged by the name a consumer would import", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "export namespace Shapes {",
        "  export interface Point { x: number }",
        "}",
        "export function origin(): Shapes.Point { return { x: 0 }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      const code = run(dir, { log: () => {}, error: () => {} });

      assert.equal(code, 0);
    },
  );
});

test("run with no options at all still reports a verdict", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": "export const a = 1;\n",
    },
    (dir) => {
      // The defaults (`?? console.log`) are the path every invocation takes; the
      // capture is the process's own console, replaced for the duration.
      const written = [];
      const original = console.log;
      console.log = (line) => written.push(line);
      try {
        assert.equal(run(dir), 0);
      } finally {
        console.log = original;
      }
      assert.match(written[0], /✓ public-types/);
    },
  );
});

test("an internal name the compiler reserves is not a type a consumer can name", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "interface __Internal { id: string }",
        "export function make(): __Internal { return { id: 'x' }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      assert.equal(run(dir, { log: () => {}, error: () => {} }), 0);
    },
  );
});

test("a type another package declares is that package's business", () => {
  withPackage(
    {
      "vendor/index.d.ts": "export interface Foreign { id: string }\n",
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "import type { Foreign } from '../../vendor/index';",
        "export function make(): Foreign { return { id: 'x' }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      // The declaration lives outside the package, so no entry of this package
      // could sensibly export it.
      assert.equal(run(dir, { log: () => {}, error: () => {} }), 0);
    },
  );
});

test("a method that returns a hidden type is reported through the class", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "interface Hidden { id: string }",
        "export class Store {",
        "  load(): Hidden { return { id: 'x' }; }",
        "  seed(value: Hidden): void { void value; }",
        "}",
        "",
      ].join("\n"),
    },
    (dir) => {
      const errors = [];
      assert.equal(
        run(dir, { log: () => {}, error: (line) => errors.push(line) }),
        1,
      );
      assert.match(errors[1], /`Hidden` appears in a public signature/);
      // The first finding is the method's return type; the parameter is the same
      // type, and the walker reports a symbol once rather than once per mention.
      assert.equal(
        errors.filter((line) => line.includes("appears in a public signature"))
          .length,
        1,
      );
    },
  );
});

test("a function-typed member is a signature the walker reads", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "interface Hidden { id: string }",
        "export interface Ports {",
        "  load: () => Hidden;",
        "  save(value: Hidden): void;",
        "}",
        "export class Store implements Ports {",
        "  constructor(readonly ports: Ports) {}",
        "  load(): Hidden { return { id: 'x' }; }",
        "  save(value: Hidden): void { void value; }",
        "}",
        "",
      ].join("\n"),
    },
    (dir) => {
      const errors = [];
      assert.equal(
        run(dir, { log: () => {}, error: (line) => errors.push(line) }),
        1,
      );
      assert.match(errors[1], /`Hidden` appears in a public signature/);
    },
  );
});

test("an entry point that cannot be loaded is an error, not a silent pass", () => {
  withPackage({}, (dir) => {
    assert.throws(
      () =>
        auditPackage(
          join(dir, "cluster", "src", "index.ts"),
          join(dir, "cluster"),
        ),
      /cannot load/,
    );
  });
});

test("an entry with no module symbol is an error, not a package with no surface", () => {
  // A file with no `export` has no module symbol, so there is no surface to
  // read at all. That is a package who pushed the wrong entry, and saying so is
  // better than reporting "0 exports" as if the package were fine.
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": "const internal = 1;\nvoid internal;\n",
    },
    (dir) => {
      assert.throws(() => run(dir, { log: () => {} }), /no module symbol/);
    },
  );
});

test("types a consumer never names are not findings", () => {
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "export function nothing(): void {}",
        "export function unknownValue(): unknown { return 1; }",
        "export function identity<T>(value: T): T { return value; }",
        "export function fail(): never { throw new Error('x'); }",
        "export function asRecord(): Record<string, number> { return {}; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      assert.equal(run(dir, { log: () => {}, error: () => {} }), 0);
    },
  );
});

test("call signatures, constructors and index members are all walked", () => {
  // Every shape a published type can take, in one package: a callable
  // interface, an interface whose member is itself a function, a class with a
  // constructor, and an index signature whose property has no declaration.
  withPackage(
    {
      "cluster/package.json": JSON.stringify({
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
      "cluster/src/index.ts": [
        "interface Hidden { id: string }",
        "export interface Callable { (id: string): Hidden }",
        "export interface Registry {",
        "  make: (id: string) => Hidden;",
        "  [key: string]: unknown;",
        "}",
        "export class Store {",
        "  constructor(readonly registry: Registry) {}",
        "  build(): Hidden { return { id: 'x' }; }",
        "}",
        "export const callable: Callable = ((id: string) => ({ id })) as Callable;",
        "export function make(): Hidden { return { id: 'x' }; }",
        "",
      ].join("\n"),
    },
    (dir) => {
      const errors = [];
      assert.equal(
        run(dir, { log: () => {}, error: (line) => errors.push(line) }),
        1,
      );
      assert.match(errors[1], /`Hidden` appears in a public signature/);
    },
  );
});
