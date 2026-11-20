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
 * What this script checks, per published package:
 *
 *   1. every `##`–`####` heading that opens with a backticked identifier names
 *      something the package exports from *any* entry point, or a public member
 *      of something it exports. Headings are the API surface a reader navigates
 *      by; prose is free to mention internals.
 *   2. every exported *value* (class, function, const, enum) of every published
 *      entry point is mentioned somewhere under the package's `docs/` tree. A
 *      reference page that omits a third of the surface sends the reader to the
 *      source, which is where the sketch above came from.
 *   3. every package that publishes a value ships a `docs/` tree at all.
 *   4. every named import in a fenced example resolves against the package and
 *      entry point it names. A snippet that cannot compile is a promise the
 *      reader cannot keep, and it is invisible to rule 1, which reads headings.
 *   5. a package index lists every package that exists under its `packages/`
 *      directory, and lists nothing else. `operations/README.md` called itself
 *      "21 packages" over a table of twenty rows: `federation` was published,
 *      tested and documented, and absent from the one page that says what the
 *      umbrella contains.
 *
 * Rules 2 and 3 are deliberately stated about the *package*, not about a
 * filename or a subpath. The two earlier versions of them were not, and both
 * turned out to be the same defect one layer out: rule 2 fired only on a file
 * named `api-reference.md`, which 12 of 14 packages did not have, so the
 * coverage duty applied to two packages and the other nine documented ones
 * between them published **50 values no page named**. Rule 3 did not exist at
 * all: ten packages shipped no documentation whatsoever — 17 further values —
 * and skipped every rule here, because the loop read a package's documents to
 * decide whether it had any.
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

/**
 * A backticked identifier anywhere in prose or a fenced block.
 *
 * A call or a generic instantiation counts as a mention: a page that writes
 * `` `createNodeDurableFileSystem(calls?)` `` is documenting that function, and
 * an earlier version of this pattern read it as no mention at all — the gate
 * then demanded a second, bare spelling of a name it had just been shown. What
 * does *not* count is a dotted path: `` `audit.v2` `` and `` `store.write` `` are
 * configuration values and method calls, not the module-level names this gate is
 * about, and treating their first segment as a mention would let a page cover a
 * symbol by accident.
 */
const INLINE_NAME = /`([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^`]*>)?(?:\([^`]*\))?`/g;

/** The workspace packages that ship a `docs/` tree. */
export function workspacePackages(root = ROOT) {
  // The three directories this repository happens to have were written here as a
  // list, which meant a fourth top-level package would be invisible to every rule in
  // this file — the same shape as the loop that read a package's documents to decide
  // whether it had any. The workspace file is the list; this reads it.
  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) return [];
  const patterns = [
    ...readFileSync(workspaceFile, "utf8").matchAll(
      /^\s*-\s*'?([^'\n#]+?)'?\s*$/gm,
    ),
  ].map((match) => match[1].trim());

  const dirs = [];
  for (const pattern of patterns) {
    let current = [root];
    for (const segment of pattern.split("/")) {
      const next = [];
      for (const base of current) {
        if (!existsSync(base)) continue;
        if (segment === "*" || segment === "**") {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== "node_modules")
              next.push(join(base, entry.name));
          }
        } else {
          const candidate = join(base, segment);
          if (existsSync(candidate)) next.push(candidate);
        }
      }
      current = next;
    }
    dirs.push(...current);
  }

  // A published surface is what an entry point is: a directory with no
  // `src/index.ts` publishes nothing to document, and `e2e` is one of those.
  return dirs
    .filter((abs) => existsSync(join(abs, "src", "index.ts")))
    .map((abs) => ({ dir: relative(root, abs).replaceAll("\\", "/"), abs }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Every entry point the package publishes, resolved from its `exports` map.
 *
 * The map is the promise; `src/` is where the source of that promise lives.
 * `./dist/x/Y.d.ts` maps back to `src/x/Y.ts`, and an entry whose target is a
 * directory index maps to `src/<key>/index.ts`.
 */
export function exportEntries(pkgAbs) {
  const manifest = JSON.parse(
    readFileSync(join(pkgAbs, "package.json"), "utf8"),
  );
  const entries = [];
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === "./package.json") continue;
    const types = typeof target === "string" ? target : target.types;
    if (typeof types !== "string") continue;
    const candidates = [
      types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts"),
      key === "."
        ? "src/index.ts"
        : join("src", key.replace(/^\.\//, ""), "index.ts"),
    ];
    const found = candidates
      .map((c) => join(pkgAbs, c))
      .find((abs) => existsSync(abs));
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
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

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
      (ts.SymbolFlags.Class |
        ts.SymbolFlags.Interface |
        ts.SymbolFlags.TypeAlias |
        ts.SymbolFlags.Enum)
    ) {
      for (const property of checker
        .getDeclaredTypeOfSymbol(symbol)
        .getProperties()) {
        members.add(property.getName());
      }
    }
  }

  return { exported, members, values };
}

/** Problems in one document, given the surface it documents. */
export function auditDocument({ text, file, surface }) {
  const problems = [];
  const known = (name) =>
    surface.exported.has(name) ||
    surface.members.has(name) ||
    NAVIGATION_HEADINGS.has(name);

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

  return problems;
}

export function describe(problem) {
  if (problem.kind === "unknown-symbol") {
    return (
      `${problem.file}:${problem.line} names \`${problem.name}\`, which the package ` +
      `does not export and no exported type declares`
    );
  }
  if (problem.kind === "no-docs") {
    return (
      `${problem.file} publishes ${problem.name} exported value(s) and has no ` +
      `\`docs/\` tree, so nothing here can document them`
    );
  }
  if (problem.kind === "unresolved-import") {
    return (
      `${problem.file}:${problem.line} tells the reader to import \`${problem.name}\` ` +
      `from "${problem.specifier}", which does not export it`
    );
  }
  if (problem.kind === "unknown-subpath") {
    return (
      `${problem.file}:${problem.line} imports from "${problem.specifier}", which is ` +
      `not a published entry point`
    );
  }
  if (problem.kind === "unknown-package") {
    return `${problem.file}:${problem.line} imports from "${problem.specifier}", which is not a package here`;
  }
  if (problem.kind === "missing-index-row") {
    return (
      `${problem.file} does not link \`./packages/${problem.name}/\`, a package that ` +
      `exists; a table that omits it is a package a reader cannot find from the front page`
    );
  }
  if (problem.kind === "stale-index-row") {
    return `${problem.file}:${problem.line} links \`./packages/${problem.name}/\`, which does not exist`;
  }
  if (problem.kind === "duplicate-index-row") {
    return `${problem.file}:${problem.line} links \`./packages/${problem.name}/\` a second time`;
  }
  return `${problem.file} never mentions \`${problem.name}\`, which ${problem.entryKey === "." ? "the package" : `the subpath \`${problem.entryKey}\``} exports`;
}

/**
 * Exported values that no page in the package mentions.
 *
 * Every entry point is judged, root included, and the duty is on the package as
 * a whole: `docs/architecture.md` may describe a class that `docs/api/` omits,
 * because a reader looking for it has somewhere to land. What is not allowed is
 * a value that appears in no page at all — that is a symbol only the source
 * knows about.
 */
export function undocumentedExports(surfaces, mentioned) {
  const findings = [];
  for (const { entry, surface } of surfaces) {
    for (const name of [...surface.values].sort()) {
      if (!mentioned.has(name)) findings.push({ entryKey: entry.key, name });
    }
  }
  return findings;
}

/** The scope every package in this repository publishes under. */
const SCOPE = "@agentix-e/";

/**
 * A named import in a fenced example.
 *
 * Only named imports are read: `import * as ns` and a default import make no
 * claim about a symbol name, and the claim is what this rule is about.
 */
const IMPORT_STATEMENT =
  /^[ \t]*import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{\s*([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gm;

/** `@agentix-e/db-operations-node/core/types` → `{ name, key }`. */
export function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const name = parts.slice(0, scoped ? 2 : 1).join("/");
  const rest = parts.slice(scoped ? 2 : 1);
  return { name, key: rest.length === 0 ? "." : `./${rest.join("/")}` };
}

/**
 * The package names, and every published name of every entry point.
 *
 * Built once per run: resolving an entry through the compiler costs a program,
 * and both the coverage rule and the import rule need the same answer.
 */
export function packageIndex(root = ROOT) {
  const index = new Map();
  for (const pkg of workspacePackages(root)) {
    const manifest = JSON.parse(
      readFileSync(join(pkg.abs, "package.json"), "utf8"),
    );
    if (typeof manifest.name !== "string") continue;
    const entries = new Map();
    for (const entry of exportEntries(pkg.abs)) {
      entries.set(entry.key, exportSurface(entry.path).exported);
    }
    index.set(manifest.name, { dir: pkg.dir, entries });
  }
  return index;
}

/**
 * Import statements in fenced examples that name something the package does not
 * export, or a specifier that resolves to nothing.
 *
 * This is the same claim `AC 79` makes by hand — *if the guide tells you to
 * import a name, the package exports it* — applied to every example in every
 * package's documentation. It was written after reading one snippet that told a
 * reader to `import { HealthOrchestrator, ComponentProbe }` from the health
 * package, which exports `componentProbe`: the example could not compile, and
 * the heading rule could not see it, because a fenced block has no headings.
 *
 * Specifiers outside this repository's scope are skipped. An example may
 * legitimately import `node:fs` or `@aws-sdk/client-s3`, and this gate knows
 * nothing about either.
 */
export function unresolvedImports(text, index) {
  const findings = [];
  for (const match of text.matchAll(IMPORT_STATEMENT)) {
    const specifier = match[2];
    if (!specifier.startsWith(SCOPE)) continue;

    const { name, key } = splitSpecifier(specifier);
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    const target = index.get(name);

    if (!target) {
      findings.push({ kind: "unknown-package", name, specifier, line });
      continue;
    }
    const surface = target.entries.get(key);
    if (!surface) {
      findings.push({
        kind: "unknown-subpath",
        name: specifier,
        specifier,
        line,
      });
      continue;
    }

    for (const raw of match[1].split(",")) {
      // `import { type ILogger }` is a named import of `ILogger`; the `type` is a
      // modifier on how it is imported, not part of the name. Reading it as part
      // of the name reported `type ILogger` as missing from a package that
      // exports it.
      const imported = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!imported) continue;
      if (!surface.has(imported)) {
        findings.push({
          kind: "unresolved-import",
          name: imported,
          specifier,
          line,
        });
      }
    }
  }
  return findings;
}

/**
 * Directory links in a package index: `` [`core`](./packages/core/) ``.
 *
 * The table is the map of an umbrella's contents. Its numbers are prose and
 * drift silently — `operations/README.md` announced "21 packages" above twenty
 * rows — but its rows are links, and those can be compared to the tree.
 */
const PACKAGE_LINK = /\]\(\.\/packages\/([A-Za-z0-9_.-]+)\/?\)/g;

/** The package directories a page links to, with the line each link is on. */
export function indexedPackages(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(PACKAGE_LINK))
      rows.push({ dir: match[1], line: index + 1 });
  });
  return rows;
}

/**
 * Every `<dir>/README.md` that sits beside a `<dir>/packages/` tree.
 *
 * Discovery is structural on purpose: the rule must apply to a workspace
 * nobody remembered to register, which is the only kind of workspace that
 * drifts. `node_modules` and dot-directories are skipped, as is the fixtures'
 * habit of writing a `packages/` directory without a README.
 */
export function indexedWorkspaces(root = ROOT) {
  const found = [];
  const consider = (base) => {
    const packagesDir = join(base, "packages");
    const readme = join(base, "README.md");
    if (existsSync(packagesDir) && existsSync(readme))
      found.push({ readme, packagesDir });
  };
  consider(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      entry.name === "node_modules"
    )
      continue;
    consider(join(root, entry.name));
  }
  return found.sort((a, b) => a.readme.localeCompare(b.readme));
}

/**
 * A package index that omits a package, names one that is gone, or repeats one.
 *
 * Both directions matter. A missing row is a package a reader cannot find from
 * the front page; a stale row is a link that 404s on the registry page; a
 * duplicate says the table was edited by appending. The three are the same
 * defect as a documented symbol the package never exported — a claim about the
 * code that nothing compared to the code.
 */
export function auditPackageIndex({ readme, packagesDir, root = ROOT }) {
  const failures = [];
  const actual = readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(packagesDir, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();

  const rows = indexedPackages(readFileSync(readme, "utf8"));
  const declared = new Set(rows.map((row) => row.dir));
  const file = relative(root, readme);

  for (const dir of actual) {
    if (!declared.has(dir))
      failures.push({ file, line: 0, name: dir, kind: "missing-index-row" });
  }

  const seen = new Set();
  for (const row of rows) {
    if (!actual.includes(row.dir)) {
      failures.push({
        file,
        line: row.line,
        name: row.dir,
        kind: "stale-index-row",
      });
    } else if (seen.has(row.dir)) {
      failures.push({
        file,
        line: row.line,
        name: row.dir,
        kind: "duplicate-index-row",
      });
    }
    seen.add(row.dir);
  }

  return {
    failures,
    notes: [
      `${file}: ${actual.length} package(s) on disk, ${declared.size} listed`,
    ],
  };
}

/**
 * Every finding and note for one package.
 *
 * Exported so the negative cases can be written against a fixture tree. A gate
 * whose only test is `run(ROOT) === 0` cannot tell "the tree is clean" from
 * "the rule never ran", and that distinction is the whole reason this file
 * exists.
 */
export function auditPackage(pkg, root = ROOT, index = packageIndex(root)) {
  const failures = [];
  const notes = [];

  const entries = exportEntries(pkg.abs);
  if (entries.length === 0) return { failures, notes };

  // Headings resolve against every entry point at once: a reference page may
  // document `./testing` beside the root, and a reader does not care which
  // import specifier a symbol comes from.
  const surfaces = entries.map((entry) => ({
    entry,
    surface: exportSurface(entry.path),
  }));
  const union = {
    exported: new Set(surfaces.flatMap(({ surface }) => [...surface.exported])),
    members: new Set(surfaces.flatMap(({ surface }) => [...surface.members])),
    values: new Set(surfaces.flatMap(({ surface }) => [...surface.values])),
  };

  const docs = markdownFiles(join(pkg.abs, "docs"));
  if (docs.length === 0) {
    // Ten packages reached this point with no documentation at all, and the
    // loop used to `continue` — a package without documents was a package
    // without obligations, which is the strongest possible incentive not to
    // write any.
    failures.push({
      file: pkg.dir,
      line: 0,
      name: String(union.values.size),
      kind: "no-docs",
    });
    return { failures, notes };
  }

  notes.push(
    `${pkg.dir}: ${entries.length} entry point(s), ${union.exported.size} exports, ${docs.length} document(s)`,
  );

  const texts = docs.map((file) => ({
    file,
    text: readFileSync(file, "utf8"),
  }));

  for (const { file, text } of texts) {
    failures.push(
      ...auditDocument({
        text,
        file: relative(root, file),
        surface: union,
      }),
    );
    for (const finding of unresolvedImports(text, index)) {
      failures.push({
        file: relative(root, file),
        line: finding.line,
        name: finding.name,
        specifier: finding.specifier,
        kind: finding.kind,
      });
    }
  }

  // A published value has to be mentioned somewhere under `docs/`, by
  // whichever page its author chose.
  const mentionedEverywhere = new Set(
    texts.flatMap(({ text }) => [...mentionedNames(text)]),
  );
  for (const finding of undocumentedExports(surfaces, mentionedEverywhere)) {
    failures.push({
      file: `${pkg.dir}: docs/`,
      line: 0,
      name: finding.name,
      entryKey: finding.entryKey,
      kind: "undocumented-export",
    });
  }

  // A package README is the first page a consumer sees on the registry, and its
  // examples are imports like any other. Ten packages in this workspace shipped
  // no README at all until iteration 54 — published to npm as a bare `dist/`.
  const readme = join(pkg.abs, "README.md");
  if (existsSync(readme)) {
    for (const finding of unresolvedImports(
      readFileSync(readme, "utf8"),
      index,
    )) {
      failures.push({
        file: relative(root, readme),
        line: finding.line,
        name: finding.name,
        specifier: finding.specifier,
        kind: finding.kind,
      });
    }
  }

  return { failures, notes };
}

/**
 * Print the verdict and return the exit code.
 *
 * Failures are printed through `describe()`, which is the only place a finding
 * becomes a sentence a person can act on; a test that never runs the printer
 * tests every rule and then ships a gate that says nothing.
 */
export function report(failures, notes, options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const verbose = options.verbose ?? VERBOSE;

  if (verbose) for (const note of notes) log(`  ${note}`);

  if (failures.length > 0) {
    error(`\n✗ docs-api: ${failures.length} finding(s)\n`);
    for (const failure of failures) error(`  ${describe(failure)}`);
    error(
      "\nAn API reference is a promise about the package. Either document what " +
        "the package exports, or export what you documented.\n",
    );
    return 1;
  }

  const scope = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
  log(`✓ docs-api: every documented symbol resolves${scope}`);
  return 0;
}

export function run(root = ROOT, options = {}) {
  const failures = [];
  const notes = [];

  const index = packageIndex(root);

  // The repository's own documentation names packages by specifier too, and
  // nothing read it: five imports in `docs/user-guide/operations.md` did not
  // resolve, in the page a new user is told to start with. These files belong
  // to no package — the guide imports from eight of them at once — so they are
  // checked for imports only, and their headings are left alone.
  const auditRootDocs = () => {
    for (const file of markdownFiles(join(root, "docs"))) {
      for (const finding of unresolvedImports(
        readFileSync(file, "utf8"),
        index,
      )) {
        failures.push({
          file: relative(root, file),
          line: finding.line,
          name: finding.name,
          specifier: finding.specifier,
          kind: finding.kind,
        });
      }
    }
  };

  for (const pkg of workspacePackages(root)) {
    const result = auditPackage(pkg, root, index);
    failures.push(...result.failures);
    notes.push(...result.notes);
  }

  auditRootDocs();

  // A package index is a claim about the tree, and the tree is the authority.
  for (const workspace of indexedWorkspaces(root)) {
    const result = auditPackageIndex({ ...workspace, root });
    failures.push(...result.failures);
    notes.push(...result.notes);
  }

  return report(failures, notes, options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
