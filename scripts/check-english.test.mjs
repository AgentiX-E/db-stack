/**
 * Tests for the English gate.
 *
 * A gate that is not itself tested is a script that prints "passed". These cases
 * pin the two ways it can be wrong: missing prose (a comment or title in CJK that
 * slips through) and crying wolf (a CJK fixture that the rule must leave alone).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { findCjk } from "./check-english.mjs";

const kinds = (text) => findCjk(text, "sample.ts").map((finding) => finding.kind);
const lines = (text) => findCjk(text, "sample.ts").map((finding) => finding.line);

test("reports a Chinese line comment", () => {
  assert.deepEqual(kinds("const a = 1; // 这是注释\n"), ["comment"]);
});

test("reports a Chinese JSDoc block on the line that has to change", () => {
  const text = "/**\n * English line.\n * 中文一行。\n */\nconst a = 1;\n";
  assert.deepEqual(lines(text), [3]);
});

test("reports a Chinese test title", () => {
  assert.deepEqual(kinds("it('AC-1: 无 active transition 时 abort 失败', () => {});\n"), ["title"]);
});

test("reports a Chinese describe title", () => {
  assert.deepEqual(kinds("describe('L0: abort 行为', () => {});\n"), ["title"]);
});

test("leaves a CJK payload in a string literal alone", () => {
  const text = "const payload = '审计日志';\nconst wider = `条目 ${payload}`;\n";
  assert.deepEqual(kinds(text), []);
});

test("does not mistake a URL in a string for a comment", () => {
  const text = 'const endpoint = "http://例え.example/path";\n';
  assert.deepEqual(kinds(text), []);
});

test("honours the opt-out marker on a comment line", () => {
  const text = "// 引用一个中文断言 english-ok\nconst a = 1;\n";
  assert.deepEqual(kinds(text), []);
});

test("a quote inside a comment does not desynchronise the scanner", () => {
  // The `"` here is prose, not a string opener. A naive regex scan starts a string
  // that never closes and then reports every later line as code, hiding the comment
  // on line 3 — which is exactly the bug this case pins.
  const text = '// the "quoted" word\nconst a = 1;\n// 仍然要被抓到\n';
  assert.deepEqual(lines(text), [3]);
});

test("escaped quotes inside a string do not end it early", () => {
  const text = 'const s = "a \\" b"; // 中文\n';
  assert.deepEqual(lines(text), [1]);
});

test("passes a file whose comments and titles are English", () => {
  const text = "/** A doc comment. */\nit('does the thing', () => {});\n// a plain comment\n";
  assert.deepEqual(kinds(text), []);
});

test("reads a YAML comment as a comment, and leaves a hash in a string alone", () => {
  assert.deepEqual(
    findCjk("# 这是一个 workflow 注释\nname: ci\n", "ci.yml").map((f) => f.kind),
    ["comment"],
  );
  assert.deepEqual(findCjk('run: echo "# 不是注释"\n', "ci.yml").length, 0);
});

test("reports CJK prose in a Markdown document", () => {
  const findings = findCjk("# Title\n\nThis paragraph is fine.\n\n这是中文正文。\n", "docs/note.md");
  assert.deepEqual(findings.map((f) => [f.kind, f.line]), [["prose", 5]]);
});

test("skips fenced code blocks in a Markdown document", () => {
  const text = "# Title\n\n```\nconst payload = '中文数据';\n```\n";
  assert.deepEqual(findCjk(text, "docs/note.md"), []);
});
