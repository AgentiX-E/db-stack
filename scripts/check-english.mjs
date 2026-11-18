#!/usr/bin/env node
/**
 * check-english — every comment and test title is English.
 *
 * The repository rule is that comments, documentation and commit messages are
 * English. It was enforced by attention, and attention fails quietly: ten files in
 * three packages carried 167 lines of Chinese commentary, including the two lines
 * above the mock that simulates a slow membership change and the section headers of
 * a whole acceptance file. Nothing broke, so nothing noticed.
 *
 * A rule that is only checked when someone remembers is not a gate. This one fails
 * the build.
 *
 * What counts:
 *
 *   - **Comments** — `//`, `/* *\/` and JSDoc. Any CJK character is a finding.
 *   - **Test titles** — the first argument of `it`, `test`, `describe`, `suite` and
 *     `bench`. A title is the name a failure is reported under; a Chinese title in
 *     an English report is the same defect one layer out.
 *
 * What does not count:
 *
 *   - String literals elsewhere. Several suites feed CJK through the code on
 *     purpose — an audit log that must round-trip a multi-byte payload, a trace
 *     context with a non-ASCII field — and those fixtures are data, not prose.
 *   - A line that opts out with the marker below, for the case where a comment has
 *     to quote a CJK string to explain a test. An opt-out is a decision somebody
 *     signed; a silent exception is what this file exists to stop.
 *
 * Usage: node scripts/check-english.mjs [--verbose]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/** Where the rule applies: product and test sources, plus the workflow files. */
const TREES = [
  "cluster/src",
  "federation/src",
  "operations/packages",
  "e2e/src",
  ".github/workflows",
  "docs",
];

/** Documents that are read on their own, outside any tree. */
const LOOSE_DOCUMENTS = [
  "README.md",
  "cluster/README.md",
  "federation/README.md",
  "operations/README.md",
  "e2e/README.md",
];

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".jsx", ".tsx"];
const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];
const DOCUMENT_EXTENSIONS = [".md"];

/** Calls whose first argument is reported to a human and must therefore be English. */
const TITLE_CALLS = ["it", "test", "describe", "suite", "bench"];

/** Opt-out marker for the rare comment that has to quote CJK to make its point. */
const OPT_OUT = "english-ok";

/** Any CJK ideograph, kana, or the fullwidth punctuation that comes with them. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Every CJK finding in one file.
 *
 * @param {string} text File contents.
 * @param {string} file Path used in the report.
 * @returns {Array<{file: string, line: number, kind: 'comment' | 'title', text: string}>}
 */
export function findCjk(text, file) {
  if (DOCUMENT_EXTENSIONS.some((ext) => file.endsWith(ext))) return proseFindings(text, file);
  const findings = [];
  const lines = text.split("\n");
  // YAML and workflow files comment with `#`; TypeScript does not, and a `#` there
  // is a private field. The scanner is told which dialect it is reading rather than
  // guessing from the content.
  const hashComments = /\.ya?ml$/.test(file);
  for (const finding of commentFindings(text, file, hashComments)) findings.push(finding);
  for (const finding of titleFindings(text, file, lines)) findings.push(finding);
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

/**
 * CJK inside comments, found with a character scanner rather than a regex.
 *
 * A regex cannot tell a comment from a string, and `// inside a URL` and
 * `"// not a comment"` are one character apart. The scanner walks the file once and
 * only reports characters it reached while inside a comment.
 */
function commentFindings(text, file, hashComments) {
  const findings = [];
  const lineText = text.split("\n");
  let line = 1;
  let index = 0;

  const report = (kind) => {
    const source = lineText[line - 1] ?? "";
    if (source.includes(OPT_OUT)) return;
    if (!findings.some((f) => f.line === line && f.kind === kind)) {
      findings.push({ file, line, kind, text: source.trim() });
    }
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    // A string or template literal: skip it whole, honouring escapes.
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        if (text[index] === "\n") line += 1;
        index += 1;
      }
      continue;
    }

    if (hashComments && char === "#") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      if (CJK.test(text.slice(index, stop))) report("comment");
      index = stop;
      continue;
    }

    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      if (CJK.test(text.slice(index, stop))) report("comment");
      index = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      const body = text.slice(index, stop);
      if (CJK.test(body)) {
        // Report the first offending line inside the block, not the opener: a
        // forty-line doc comment should point at the line that has to change.
        const offset = body.search(CJK);
        const before = body.slice(0, offset).split("\n").length - 1;
        const saved = line;
        line += before;
        report("comment");
        line = saved;
      }
      line += body.split("\n").length - 1;
      index = stop;
      continue;
    }

    index += 1;
  }

  return findings;
}

/**
 * CJK in a Markdown document, outside fenced code blocks.
 *
 * Markdown has no comments, so the rule is the document: prose is English. Fenced
 * blocks are skipped because a sample transcript, a CLI session or a failure message
 * may legitimately quote whatever the product printed, including a CJK payload.
 */
function proseFindings(text, file) {
  const findings = [];
  let fenced = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.includes(OPT_OUT)) continue;
    if (CJK.test(line)) findings.push({ file, line: index + 1, kind: "prose", text: line.trim() });
  }
  return findings;
}

/** CJK inside the first string argument of a title call. */
function titleFindings(text, file, lines) {
  const findings = [];
  const pattern = new RegExp(
    `\\b(?:${TITLE_CALLS.join("|")})\\s*\\(\\s*(["'\`])([\\s\\S]*?)\\1`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const literal = match[2];
    // A template literal with an interpolation is not a title this rule can read;
    // skipping it is honest, and the call sites use plain strings.
    if (match[1] === "`" && literal.includes("${")) continue;
    if (!CJK.test(literal)) continue;
    const line = text.slice(0, match.index).split("\n").length;
    findings.push({ file, line, kind: "title", text: (lines[line - 1] ?? "").trim() });
  }
  return findings;
}

/** Every file the rule applies to, relative to the repository root. */
function targetFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const isSource = SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext));
      const isWorkflow = WORKFLOW_EXTENSIONS.some((ext) => entry.name.endsWith(ext));
      const isDocument = DOCUMENT_EXTENSIONS.some((ext) => entry.name.endsWith(ext));
      if (isSource || isWorkflow || isDocument) files.push(relative(ROOT, full));
    }
  };

  for (const tree of TREES) {
    const full = join(ROOT, tree);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // A tree that does not exist in this checkout is not a finding.
    }
  }
  for (const document of LOOSE_DOCUMENTS) {
    try {
      if (statSync(join(ROOT, document)).isFile()) files.push(document);
    } catch {
      // Absent in this checkout: not a finding.
    }
  }
  return files;
}

/** Run the gate. Exported so its own test can drive it without spawning. */
export function run() {
  const findings = [];
  for (const file of targetFiles()) {
    findings.push(...findCjk(readFileSync(join(ROOT, file), "utf8"), file));
  }
  return findings;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const findings = run();
  if (findings.length === 0) {
    process.stdout.write("English gate passed: no CJK in comments, test titles or document prose.\n");
  } else {
    for (const finding of findings) {
      process.stderr.write(`${finding.file}:${finding.line}: ${finding.kind} is not English\n    ${finding.text}\n`);
    }
    process.stderr.write(
      `\nEnglish gate failed: ${findings.length} line(s) of CJK in comments or test titles.\n` +
        `Comments and titles are English by rule; a fixture that needs CJK belongs in a string literal.\n`,
    );
    process.exitCode = 1;
  }
}
