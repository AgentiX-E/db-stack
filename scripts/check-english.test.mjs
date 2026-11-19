/**
 * Tests for the English gate.
 *
 * A gate that is not itself tested is a script that prints "passed". These cases
 * pin the two ways it can be wrong: missing prose (a comment or title in CJK that
 * slips through) and crying wolf (a CJK fixture that the rule must leave alone).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { findCjk, report, run, targetFiles } from "./check-english.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const kinds = (text) =>
  findCjk(text, "sample.ts").map((finding) => finding.kind);
const lines = (text) =>
  findCjk(text, "sample.ts").map((finding) => finding.line);

test("reports a Chinese line comment", () => {
  assert.deepEqual(kinds("const a = 1; // 这是注释\n"), ["comment"]);
});

test("reports a Chinese JSDoc block on the line that has to change", () => {
  const text = "/**\n * English line.\n * 中文一行。\n */\nconst a = 1;\n";
  assert.deepEqual(lines(text), [3]);
});

test("reports a Chinese test title", () => {
  assert.deepEqual(
    kinds("it('AC-1: 无 active transition 时 abort 失败', () => {});\n"),
    ["title"],
  );
});

test("reports a Chinese describe title", () => {
  assert.deepEqual(kinds("describe('L0: abort 行为', () => {});\n"), ["title"]);
});

test("leaves a CJK payload in a string literal alone", () => {
  const text =
    "const payload = '审计日志';\nconst wider = `条目 ${payload}`;\n";
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
  const text =
    "/** A doc comment. */\nit('does the thing', () => {});\n// a plain comment\n";
  assert.deepEqual(kinds(text), []);
});

test("reads a YAML comment as a comment, and leaves a hash in a string alone", () => {
  assert.deepEqual(
    findCjk("# 这是一个 workflow 注释\nname: ci\n", "ci.yml").map(
      (f) => f.kind,
    ),
    ["comment"],
  );
  assert.deepEqual(findCjk('run: echo "# 不是注释"\n', "ci.yml").length, 0);
});

test("reports CJK prose in a Markdown document", () => {
  const findings = findCjk(
    "# Title\n\nThis paragraph is fine.\n\n这是中文正文。\n",
    "docs/note.md",
  );
  assert.deepEqual(
    findings.map((f) => [f.kind, f.line]),
    [["prose", 5]],
  );
});

test("skips fenced code blocks in a Markdown document", () => {
  const text = "# Title\n\n```\nconst payload = '中文数据';\n```\n";
  assert.deepEqual(findCjk(text, "docs/note.md"), []);
});

test("the rule applies to sources, workflows and documents, and skips build output", () => {
  const root = mkdtempSync(join(tmpdir(), "english-"));
  try {
    const write = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("cluster/src/a.ts", "// 源码注释\n");
    write("cluster/src/a.test.ts", "// fine\n");
    write(".github/workflows/ci.yml", "# 工作流注释\n");
    write("docs/guide.md", "正文一行。\n");
    write("README.md", "标题\n");
    write("cluster/dist/ignored.ts", "// 构建产物\n");
    write("cluster/node_modules/pkg/index.ts", "// 依赖\n");
    write("cluster/coverage/report.ts", "// 覆盖率产物\n");

    const files = targetFiles(root).sort();
    assert.deepEqual(files, [
      ".github/workflows/ci.yml",
      "README.md",
      "cluster/src/a.test.ts",
      "cluster/src/a.ts",
      "docs/guide.md",
    ]);

    // And the files it selected are the files it reports on: a short list here
    // would make the gate quiet rather than the repository English.
    const findings = run(root);
    assert.deepEqual(findings.map((finding) => finding.file).sort(), [
      ".github/workflows/ci.yml",
      "README.md",
      "cluster/src/a.ts",
      "docs/guide.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tree that is not in this checkout is not a finding", () => {
  const root = mkdtempSync(join(tmpdir(), "english-"));
  try {
    assert.deepEqual(targetFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report writes the pass sentence and returns 0", () => {
  const out = [];
  const code = report([], { out: { write: (line) => out.push(line) } });

  assert.equal(code, 0);
  assert.deepEqual(out, [
    "English gate passed: no CJK in comments, test titles or document prose.\n",
  ]);
});

test("report writes every finding and the count, and returns 1", () => {
  const err = [];
  const code = report(
    [
      { file: "a.ts", line: 2, kind: "comment", text: "// 注释" },
      { file: "a.ts", line: 9, kind: "title", text: "it('标题')" },
    ],
    { err: { write: (line) => err.push(line) } },
  );

  assert.equal(code, 1);
  assert.equal(err[0], "a.ts:2: comment is not English\n    // 注释\n");
  assert.match(err[1], /a\.ts:9: title is not English/);
  assert.match(err[2], /English gate failed: 2 line\(s\) of CJK/);
});

test("the repository's own trees are English", () => {
  // The gate's reason to exist, asserted where it applies: sources, workflows
  // and the twenty-one packages' documents.
  assert.deepEqual(run(), []);
});

test("the command line exits 0 on a clean repository", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-english.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0);
  assert.match(child.stdout, /English gate passed/);
});

test("findings come back in line order even when the title is above the comment", () => {
  const text = "it('标题一', () => {});\nconst a = 1;\n// 注释在后面\n";
  const findings = findCjk(text, "sample.ts");

  assert.deepEqual(
    findings.map((finding) => [finding.line, finding.kind]),
    [
      [1, "title"],
      [3, "comment"],
    ],
  );
});

test("two CJK comments on one line are one finding, not two", () => {
  const text = "/* 块注释 */ const a = 1; // 行注释\n";

  assert.deepEqual(findCjk(text, "sample.ts"), [
    {
      file: "sample.ts",
      line: 1,
      kind: "comment",
      text: "/* 块注释 */ const a = 1; // 行注释",
    },
  ]);
});

test("a comment on the last line with no trailing newline is still a comment", () => {
  assert.deepEqual(kinds("const a = 1;\n// 末尾没有换行"), ["comment"]);
  assert.deepEqual(
    findCjk("name: ci\n# 末尾没有换行", "ci.yml").map(
      (finding) => finding.kind,
    ),
    ["comment"],
  );
});

test("an unterminated block comment runs to the end of the file", () => {
  assert.deepEqual(kinds("const a = 1;\n/* 没有结束\n仍然在注释里"), [
    "comment",
  ]);
});

test("a template literal that spans lines does not make its lines look like code", () => {
  const text = "const payload = `\n中文载荷\n`;\n// 真正的注释\n";

  assert.deepEqual(lines(text), [4]);
});
