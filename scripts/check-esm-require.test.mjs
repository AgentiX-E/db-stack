/**
 * Tests for the ESM `require` gate.
 *
 * A gate that is not itself tested is a script that prints "passed". These cases
 * pin the two ways it can be wrong: missing a real call (the defect class it
 * exists for) and crying wolf (prose, fixtures, and the sanctioned
 * `createRequire` form, all of which must be left alone). The last case asserts
 * the gate is looking at something at all — a gate that scans zero files reports
 * perfect compliance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectFiles,
  findBareRequire,
  isEsmPackage,
  report,
  run,
  stripCommentsAndStrings,
} from "./check-esm-require.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const hits = (text) => findBareRequire(text, "sample.ts");

test("reports a bare require call", () => {
  assert.equal(hits("const { Client } = require('pg');\n").length, 1);
});

test("reports a bare require inside a function", () => {
  assert.equal(
    hits("export function f() {\n  return require('crypto');\n}\n").length,
    1,
  );
});

test("reports the line the call is on, not the line the match started", () => {
  const text =
    "/**\n * A block comment.\n */\nconst x = 1;\nconst y = require('pg');\n";
  assert.deepEqual(
    hits(text).map((f) => f.line),
    [5],
  );
});

test("leaves a require mentioned in a line comment alone", () => {
  assert.deepEqual(
    hits("// const { Client } = require('pg');\nconst x = 1;\n"),
    [],
  );
});

test("leaves a require mentioned in a block comment alone", () => {
  assert.deepEqual(
    hits("/* require('pg') is not allowed here */\nconst x = 1;\n"),
    [],
  );
});

test("leaves a require inside a string literal alone", () => {
  assert.deepEqual(hits("const message = \"require('pg') is missing\";\n"), []);
  assert.deepEqual(hits("const template = `run require('pg') to see`;\n"), []);
});

test("leaves createRequire(import.meta.url) alone", () => {
  assert.deepEqual(
    hits(
      "const nodeRequire = createRequire(import.meta.url);\nnodeRequire('pg');\n",
    ),
    [],
  );
});

test("leaves a member call named require alone", () => {
  assert.deepEqual(hits("loader.require('pg');\n"), []);
});

test("leaves an identifier that merely ends in require alone", () => {
  assert.deepEqual(hits("nodeRequire('pg');\n"), []);
});

test("reports every occurrence, not just the first", () => {
  assert.equal(hits("require('a');\nconst b = require('b');\n").length, 2);
});

test("stripCommentsAndStrings preserves line count", () => {
  const text = "// one\n/* two\nthree */\nconst s = 'x';\n";
  assert.equal(
    stripCommentsAndStrings(text).split("\n").length,
    text.split("\n").length,
  );
});

test("the repository itself is clean, and the gate is looking at real files", () => {
  const { findings, scanned } = run();
  assert.deepEqual(findings, []);
  assert.ok(
    scanned.length > 100,
    `expected a real tree, scanned ${scanned.length} files`,
  );
});

test("a package directory with no readable manifest is not an ESM package", () => {
  const root = mkdtempSync(join(tmpdir(), "esm-pkg-"));
  try {
    mkdirSync(join(root, "cluster"), { recursive: true });
    assert.equal(isEsmPackage(join(root, "cluster")), false);

    writeFileSync(join(root, "cluster", "package.json"), "{ not json");
    assert.equal(isEsmPackage(join(root, "cluster")), false);

    writeFileSync(
      join(root, "cluster", "package.json"),
      JSON.stringify({ name: "x" }),
    );
    assert.equal(isEsmPackage(join(root, "cluster")), false);

    writeFileSync(
      join(root, "cluster", "package.json"),
      JSON.stringify({ type: "module" }),
    );
    assert.equal(isEsmPackage(join(root, "cluster")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collection skips build output and keeps only source files", () => {
  const root = mkdtempSync(join(tmpdir(), "esm-collect-"));
  try {
    const write = (path) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "export {};\n");
    };
    write("src/a.ts");
    write("src/nested/b.mts");
    write("src/nested/c.json");
    write("src/dist/d.ts");
    write("src/node_modules/e.ts");

    const files = collectFiles(join(root, "src"))
      .map((file) => file.slice(root.length + 1))
      .sort();

    assert.deepEqual(files, ["src/a.ts", "src/nested/b.mts"]);
    assert.deepEqual(collectFiles(join(root, "absent")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run scans only the packages that declare themselves ESM", () => {
  const root = mkdtempSync(join(tmpdir(), "esm-run-"));
  try {
    const write = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("cluster/package.json", JSON.stringify({ type: "module" }));
    write("cluster/src/a.ts", "const x = require('fs');\n");
    // Not ESM, so it is out of scope for a gate about ESM scopes.
    write("federation/package.json", JSON.stringify({ name: "cjs" }));
    write("federation/src/b.ts", "const x = require('fs');\n");

    const { findings, scanned } = run(root);

    assert.deepEqual(scanned, ["cluster/src/a.ts"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report writes the pass sentence with the number of files scanned", () => {
  const out = [];
  const code = report(
    { findings: [], scanned: ["a", "b", "c"] },
    { out: { write: (line) => out.push(line) } },
  );

  assert.equal(code, 0);
  assert.deepEqual(out, [
    "ESM gate passed: no bare require() in 3 ESM source files.\n",
  ]);
});

test("report writes every finding and the consumer-facing reason, and returns 1", () => {
  const err = [];
  const code = report(
    {
      findings: [
        { file: "cluster/src/a.ts", line: 4, text: "const x = require('fs');" },
      ],
      scanned: ["a"],
    },
    { err: { write: (line) => err.push(line) } },
  );

  assert.equal(code, 1);
  assert.equal(
    err[0],
    "cluster/src/a.ts:4: bare require() in an ESM package\n    const x = require('fs');\n",
  );
  assert.match(err[1], /require is not defined in ES module scope/);
});

test("the command line exits 0 on this repository", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-esm-require.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0);
  assert.match(child.stdout, /ESM gate passed/);
});
