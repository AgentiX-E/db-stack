#!/usr/bin/env node
/**
 * check-docs-api — an API reference may only name symbols the package exports.
 *
 * `federation/docs/api-reference.md` documented a package that does not exist.
 * Five of its sections were types nobody ever wrote (`FederationEngine`,
 * `FederationConfig`, `DataChange`, `PipelineBuilder`, `HeartbeatStatus`), the
 * `OutboxStore` constructor it printed took an `IDatabase` and a table name
 * while the real one takes an `OutboxStoreConfig`, its `DedupRing` had
 * `checkAndMark`/`reset` where the real one has `put`/`sweep`, its `HLC` exposed
 * `wallClock` where the type has `wallTime: bigint`, and its error hierarchy
 * listed eleven error classes in a package that defines none. Every one of
 * those names type-checked in a reader's head and nowhere else: the page was a
 * design sketch from before the package was built, and no build step ever
 * compared it to the code.
 *
 * That is the same defect class as a `require` call in an ESM module — text
 * that is validated by the reader and by nothing else. It cannot be fixed by
 * reading more carefully; the fix is to make the comparison mechanical.
 *
 * What this script checks, per package that has a `docs/` tree:
 *
 *   1. every `##`–`####` heading that opens with a backticked identifier names
 *      something the package exports from *any* entry point, or a public member
 *      of something it exports. Headings are the API surface a reader navigates
 *      by; prose is free to mention internals.
 *   2. every file named `api-reference.md` mentions every exported *value*
 *      (class, function, const, enum) of the package root at least once. A
 *      reference page that omits a third of the surface sends the reader to the
 *      source, which is where the sketch above came from.
 *   3. every published subpath (`./testing`, `./raft`, …) mentions each of its
 *      own exported values somewhere under `docs/`. The first version of this
 *      script read `src/index.ts` and nothing else, so the thirteen symbols
 *      `@agentix-e/db-cluster/testing` publishes — the harness a downstream
 *      package is expected to build against — were checked by no gate at all.
 *      A subpath nobody documents is a subpath nobody can use.
 *
 * The export surface is read through the TypeScript compiler, not by pattern
 * matching: `export * as core from …` and re-exported aliases have to resolve,
 * and a regex over `index.ts` cannot do that.
 *
 * Usage: node scripts/check-docs-api.mjs [--verbose]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

/**
 * Headings that are navigational rather than symbolic. They are section
 * dividers, and none of them is meant to resolve to a declaration.
 */
const NAVIGATION_HEADINGS = new Set([
  "Constructor",
  "Constructors",
  "Methods",
  "Properties",
  "Interfaces",
  "Implementations",
  "Types",
  "Events",
  "Options",
  "Overview",
  "Usage",
]);

/**
 * Opening fence of a backticked heading: `### `Name`` or `### `Name(x): T``.
 *
 * Modifiers are skipped so that a heading written as ``### `async start(): Promise<void>` ``
 * is read as being about `start`, not about `async`.
 */
const HEADING_PATTERN =
  /^#{2,4}[ \t]+`(?:(?:async|static|readonly|public|private|protected|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)/;

/** A backticked identifier anywhere in prose or a fenced block. */
const INLINE_NAME = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;

/** The workspace packages that ship a `docs/` tree. */
export function workspacePackages(root = ROOT) {
  const packages = ["cluster", "federation", "operations"];
  const opsRoot = join(root, "operations", "packages");
  if (existsSync(opsRoot)) {
    for (const entry of readdirSync(opsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) packages.push(join("operations", "packages", entry.name));
    }
  }
  return packages
    .map((dir) => ({ dir, abs: join(root, dir) }))
    .filter((pkg) => existsSync(join(pkg.abs, "src", "index.ts")));
}

/**
 * Every entry point the package publishes, resolved from its `exports` map.
 *
 * The map is the promise; `src/` is where the source of that promise lives.
 * `./dist/x/Y.d.ts` maps back to `src/x/Y.ts`, and an entry whose target is a
 * directory index maps to `src/<key>/index.ts`.
 */
export function exportEntries(pkgAbs) {
  const manifest = JSON.parse(readFileSync(join(pkgAbs, "package.json"), "utf8"));
  const entries = [];
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === "./package.json") continue;
    const types = typeof target === "string" ? target : target.types;
    if (typeof types !== "string") continue;
    const candidates = [
      types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts"),
      key === "." ? "src/index.ts" : join("src", key.replace(/^\.\//, ""), "index.ts"),
    ];
    const found = candidates.map((c) => join(pkgAbs, c)).find((abs) => existsSync(abs));
    if (found) entries.push({ key, path: found });
  }
  return entries;
}

/** Every markdown file under `<pkg>/docs`, recursively. */
export function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

/**
 * Headings that name a symbol, with the line they are on.
 *
 * Only the leading identifier of the heading counts: `### `register<T>(…)`` is
 * about `register`, and the signature after it is prose the gate does not try
 * to parse.
 */
export function symbolicHeadings(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = HEADING_PATTERN.exec(line);
    if (match) found.push({ name: match[1], line: index + 1 });
  });
  return found;
}

/** Identifiers mentioned in inline code anywhere in the document. */
export function mentionedNames(text) {
  const names = new Set();
  for (const match of text.matchAll(INLINE_NAME)) names.add(match[1]);
  return names;
}

/**
 * The package's export surface, resolved through the compiler.
 *
 * Returns the exported names and, separately, the public member names of every
 * exported class and interface, because a reference page documents members as
 * headings too.
 */
export function exportSurface(entryPath) {
  const program = ts.createProgram([entryPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryPath);
  if (!source) throw new Error(`cannot load ${entryPath}`);

  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`no module symbol for ${entryPath}`);

  const exported = new Set();
  const members = new Set();
  const values = new Set();

  const unwrap = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  for (const raw of checker.getExportsOfModule(moduleSymbol)) {
    const name = raw.getName();
    if (name === "default") continue;
    exported.add(name);

    const symbol = unwrap(raw);
    const flags = symbol.flags;
    if (
      flags &
      (ts.SymbolFlags.Class |
        ts.SymbolFlags.Function |
        ts.SymbolFlags.Enum |
        ts.SymbolFlags.Variable)
    ) {
      values.add(name);
    }
    if (
      flags &
      (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum)
    ) {
      for (const property of checker.getDeclaredTypeOfSymbol(symbol).getProperties()) {
        members.add(property.getName());
      }
    }
  }

  return { exported, members, values };
}

/** Problems in one document, given the surface it documents. */
export function auditDocument({ text, file, surface, requireFullCoverage }) {
  const problems = [];
  const known = (name) =>
    surface.exported.has(name) || surface.members.has(name) || NAVIGATION_HEADINGS.has(name);

  for (const heading of symbolicHeadings(text)) {
    if (!known(heading.name)) {
      problems.push({
        file,
        line: heading.line,
        name: heading.name,
        kind: "unknown-symbol",
      });
    }
  }

  if (requireFullCoverage) {
    const mentioned = mentionedNames(text);
    for (const name of [...surface.values].sort()) {
      if (!mentioned.has(name)) {
        problems.push({ file, line: 0, name, kind: "undocumented-export" });
      }
    }
  }

  return problems;
}

function describe(problem) {
  if (problem.kind === "unknown-symbol") {
    return (
      `${problem.file}:${problem.line} names \`${problem.name}\`, which the package ` +
      `does not export and no exported type declares`
    );
  }
  if (problem.kind === "undocumented-subpath-export") {
    return `${problem.file} never mentions \`${problem.name}\`, which the subpath publishes`;
  }
  return `${problem.file} never mentions \`${problem.name}\`, which the package exports`;
}

/**
 * Subpath values no page mentions.
 *
 * A subpath is a second promise on the same package, and until this rule existed
 * the gate read `src/index.ts` and stopped: `@agentix-e/db-cluster/testing`
 * published fifteen symbols — a whole harness a downstream package is expected
 * to build against — and not one of them was checked. A published symbol nobody
 * documents is a symbol nobody can find.
 */
export function undocumentedSubpathExports(surfaces, mentioned) {
  const findings = [];
  for (const { entry, surface } of surfaces) {
    if (entry.key === ".") continue;
    for (const name of [...surface.values].sort()) {
      if (!mentioned.has(name)) findings.push({ entryKey: entry.key, name });
    }
  }
  return findings;
}

export function run(root = ROOT) {
  const failures = [];
  const notes = [];

  for (const pkg of workspacePackages(root)) {
    const docs = markdownFiles(join(pkg.abs, "docs"));
    if (docs.length === 0) continue;

    const entries = exportEntries(pkg.abs);
    if (entries.length === 0) continue;

    // Headings resolve against every entry point at once: a reference page may
    // document `./testing` beside the root, and a reader does not care which
    // import specifier a symbol comes from.
    const surfaces = entries.map((entry) => ({ entry, surface: exportSurface(entry.path) }));
    const union = {
      exported: new Set(surfaces.flatMap(({ surface }) => [...surface.exported])),
      members: new Set(surfaces.flatMap(({ surface }) => [...surface.members])),
      values: new Set(surfaces.flatMap(({ surface }) => [...surface.values])),
    };

    notes.push(
      `${pkg.dir}: ${entries.length} entry point(s), ${union.exported.size} exports, ${docs.length} document(s)`,
    );

    const rootEntry = surfaces.find(({ entry }) => entry.key === ".");
    const texts = docs.map((file) => ({ file, text: readFileSync(file, "utf8") }));

    for (const { file, text } of texts) {
      failures.push(
        ...auditDocument({
          text,
          file: relative(root, file),
          surface: union,
          // `api-reference.md` must cover the package root in full.
          requireFullCoverage: false,
        }),
      );
      if (file.endsWith("api-reference.md") && rootEntry) {
        failures.push(
          ...auditDocument({
            text,
            file: relative(root, file),
            surface: rootEntry.surface,
            requireFullCoverage: true,
          }),
        );
      }
    }

    // A published subpath has to be mentioned somewhere under `docs/`, by
    // whichever page its author chose.
    const mentionedEverywhere = new Set(
      texts.flatMap(({ text }) => [...mentionedNames(text)]),
    );
    for (const finding of undocumentedSubpathExports(surfaces, mentionedEverywhere)) {
      failures.push({
        file: `${pkg.dir}: docs/ (subpath ${finding.entryKey})`,
        line: 0,
        name: finding.name,
        kind: "undocumented-subpath-export",
      });
    }
  }

  if (VERBOSE) for (const note of notes) console.log(`  ${note}`);

  if (failures.length > 0) {
    console.error(`\n✗ docs-api: ${failures.length} finding(s)\n`);
    for (const failure of failures) console.error(`  ${describe(failure)}`);
    console.error(
      "\nAn API reference is a promise about the package. Either document what " +
        "the package exports, or export what you documented.\n",
    );
    return 1;
  }

  const scope = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
  console.log(`✓ docs-api: every documented symbol resolves${scope}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
