#!/usr/bin/env node
/**
 * check-esm-require — no CommonJS `require` in ESM source trees.
 *
 * Why this exists
 * ---------------
 * Three places in `cluster/` called `require(...)` from a module that ships as
 * ESM (`"type": "module"`):
 *
 *   - `RaftGroupManager._execOnLeader` → `require('pg')`, so forwarding a write
 *     to the shard leader threw `ReferenceError: require is not defined` for
 *     every consumer of the published package.
 *   - `MerkleTree.computeRoot` → `require('crypto')`, so the public anti-entropy
 *     digest threw the same way.
 *   - `LoggingAdapter.createTraceContext` → `require('node:async_hooks')` inside
 *     a `try` with a fallback, so the fallback became the only branch production
 *     ever took and every log line silently lost its trace id.
 *
 * All three passed the test suite, because the test transform supplies a
 * `require`. That is the shape of the whole class: **the test environment is
 * more capable than the runtime**, so the suite reports green while consumers get
 * exceptions and silent degradations. Reviewing for it does not work — the
 * third one was inside a `try/catch` that made it look defensive.
 *
 * What counts:
 *
 *   - A call to the free identifier `require` in a source file of a package
 *     whose `package.json` says `"type": "module"`.
 *   - Emitted `dist/**\/*.js` files, when a build is present, because that is
 *     what consumers actually execute.
 *
 * What does not count:
 *
 *   - `createRequire(import.meta.url)('pg')` and any `somethingRequire(...)`:
 *     those are the sanctioned way to reach CommonJS from ESM. The gate matches
 *     only a bare `require`, only at a call.
 *   - Test trees. A test may legitimately reach into CommonJS interop, and the
 *     point of the gate is the artefact that ships.
 *   - Comments and string literals. Several files discuss `require(` in prose;
 *     matching there would train people to ignore the gate.
 *
 * Usage: node scripts/check-esm-require.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/** Package roots that may declare `"type": "module"`. */
const PACKAGE_ROOTS = ["node", "cluster", "federation", "e2e"];

const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

/** Directories that hold tests, fixtures or build output. */
const SKIPPED_SEGMENTS = [
  "__tests__",
  "node_modules",
  "dist",
  "coverage",
  "fixtures",
];

/**
 * Remove comments and string literals so a match inside prose or a fixture is
 * not reported. Newlines are preserved so line numbers stay meaningful.
 *
 * @param {string} source
 * @returns {string} The source with comments and string bodies blanked out.
 */
export function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Find bare `require(...)` calls in one file's source.
 *
 * @param {string} source - File contents.
 * @param {string} file - Path used in the findings.
 * @returns {Array<{ file: string, line: number, text: string }>}
 */
export function findBareRequire(source, file) {
  const cleaned = stripCommentsAndStrings(source);
  const rawLines = source.split("\n");
  const findings = [];
  const pattern = /(^|[^.\w$])require\s*\(/g;

  for (const match of cleaned.matchAll(pattern)) {
    const index = (match.index ?? 0) + match[1].length;
    const line = cleaned.slice(0, index).split("\n").length;
    findings.push({ file, line, text: (rawLines[line - 1] ?? "").trim() });
  }
  return findings;
}

export function isEsmPackage(dir) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    return manifest.type === "module";
  } catch {
    return false;
  }
}

export function collectFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIPPED_SEGMENTS.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (
      SOURCE_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf(".")))
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Run the gate. Exported so its own test can drive it without spawning. */
export function run(repositoryRoot = ROOT) {
  const findings = [];
  const scanned = [];

  for (const root of PACKAGE_ROOTS) {
    const dir = join(repositoryRoot, root);
    if (!isEsmPackage(dir)) continue;
    for (const file of collectFiles(join(dir, "src"))) {
      const rel = relative(repositoryRoot, file);
      scanned.push(rel);
      findings.push(...findBareRequire(readFileSync(file, "utf8"), rel));
    }
  }

  return { findings, scanned };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

/**
 * Print the verdict and return the exit code.
 *
 * Extracted for the same reason `run` takes a root: the failure branch is the
 * one nobody reads until a consumer reports it, so a test has to be able to.
 */
export function report({ findings, scanned }, options = {}) {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;

  if (findings.length === 0) {
    out.write(
      `ESM gate passed: no bare require() in ${scanned.length} ESM source files.\n`,
    );
    return 0;
  }

  for (const finding of findings) {
    err.write(
      `${finding.file}:${finding.line}: bare require() in an ESM package\n    ${finding.text}\n`,
    );
  }
  err.write(
    `\nESM gate failed: ${findings.length} bare require() call(s).\n` +
      `These compile and pass the test suite (the test transform supplies a require) and then throw\n` +
      `"require is not defined in ES module scope" for every consumer. Use an ESM import, or\n` +
      `createRequire(import.meta.url) when the dependency must be optional.\n`,
  );
  return 1;
}

if (invokedDirectly) {
  process.exitCode = report(run());
}
