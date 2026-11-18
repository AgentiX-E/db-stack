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

import {
  findBareRequire,
  stripCommentsAndStrings,
  run,
} from "./check-esm-require.mjs";

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
