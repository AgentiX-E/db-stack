#!/usr/bin/env node
/**
 * check-doc-examples — a fenced example has to type-check against the API it names.
 *
 * `check-docs-api` compares *imports* to the export surface, which catches a
 * page that tells the reader to import a name the package does not publish. It
 * cannot see the next line. `operations/README.md` opened with an example that
 * imported four existing names and then:
 *
 *   - constructed `new InMemoryLogger({ level: 'info' })` where the constructor
 *     takes `(component: string, maxEntries: number)`;
 *   - registered a probe with `health.register(...)`, a method the orchestrator
 *     does not have;
 *   - called `health.runAllChecks()`, which does not exist either;
 *   - built a `BackupManager` from `{ storage, schedule }`, an options object
 *     nothing accepts.
 *
 * Every one of those lines is a promise about the API, and every one of them is
 * false. A reader who pastes the block gets a stack of compiler errors, and the
 * gate that was supposed to protect them had already gone green — because the
 * imports resolved. That is the same defect as the reference page that
 * documented classes that were never written, one step further from the text
 * that is easy to check.
 *
 * What this script checks: every fenced ```ts / ```typescript block in every
 * page under `docs/`, `<module>/docs/`, `<module>/packages/**` and every package
 * `README.md` is concatenated into a single module and type-checked, with
 * `@agentix-e/*` specifiers mapped to the packages' *sources* rather than their
 * built `dist/`, so a stale build cannot certify a page.
 *
 * ## What a fragment is allowed to be wrong about
 *
 * Documentation snippets are fragments. They refer to values the surrounding
 * prose introduces (`const status = await health.check(storage)` where
 * `storage` was described above the block), they sketch class shapes without
 * method bodies (`class RaftGroup { propose(cmd: Command): Promise<Result>; }`),
 * and they leave types implicit. Those are not claims, so this gate does not
 * judge them: diagnostics about *undeclared names*, *implicit any*, *missing
 * implementations*, *uninitialised properties* and *unresolved modules* are
 * dropped.
 *
 * What it does judge is the shape of every claim a snippet makes about a
 * declared value: a property that does not exist (TS2339 / TS2551), an argument
 * that cannot be passed (TS2345 / TS2322), a call with the wrong number of
 * arguments (TS2554), an object literal with a key the target does not declare
 * or missing one it requires (TS2353 / TS2561), a member that was never
 * exported under that name (TS2724), a non-callable that is called (TS2349).
 * A fragment cannot make those true by being a fragment.
 *
 * ## Why every block is its own module
 *
 * A page may repeat a binding name across blocks (`const registry = …` in three
 * examples). Concatenated, the second declaration is a duplicate identifier,
 * TypeScript resets it to `any`, and every claim about it stops being checkable —
 * a false green produced by the gate's own assembling. Worse, one page's
 * `class HAFailoverDetector` became the type of `new InMemoryDeadlockDetector()`
 * on a page about deadlock detection.
 *
 * So a block is the unit: the unit a reader copies, and the only unit whose
 * meaning the page controls from inside. Each block is written as its own module
 * and judged alone. A snippet that builds on a value the prose introduced is
 * still read — it simply cannot be judged *about* that value, because the name is
 * not declared in the block, and "cannot find name" is not a claim.
 *
 * ## Why the judged list is asserted, not described
 *
 * The paragraph above used to say TS2322 was judged while `JUDGED_CODES` did not
 * contain it — so `const zz: number = "not a number"` passed, and three pages
 * that assigned a promise where a probe result was declared passed with it. The
 * list is the contract; the prose is a comment. `check-doc-examples.test.mjs`
 * reads the names out of this comment and fails if one of them is missing from
 * the list, so the two cannot drift again.
 *
 * Usage: node scripts/check-doc-examples.mjs [--verbose]
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  exportEntries,
  markdownFiles,
  workspacePackages,
} from "./check-docs-api.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

/**
 * The diagnostics that mean "this snippet is wrong about the API".
 *
 * Each code here is a claim, not an incompleteness. The exclusions are listed
 * in the file header; the reason they are exclusions and not findings is that
 * every documented fragment is allowed to leave them open, and a gate that
 * reports them would be turned off within a week.
 */
export const JUDGED_CODES = new Map([
  [2322, "a value cannot be assigned to the type it is declared as"],
  [2339, "property does not exist on the type"],
  [2345, "argument cannot be passed to this parameter"],
  [2349, "this expression is not callable"],
  [2353, "object literal has a key the target does not declare"],
  [2551, "property does not exist (did you mean another?)"],
  [2554, "wrong number of arguments"],
  [2559, "call and declaration signatures do not match"],
  [2560, "provided too many type arguments"],
  [2561, "object literal is missing a required property"],
  [2724, "the module has no member with that name"],
]);

/** Opening fence of a TypeScript example. */
const FENCE = /```(?:ts|typescript)[ \t]*\r?\n([\s\S]*?)```/g;

/** A complete `import … from "…"` statement, possibly spanning several lines. */
const IMPORT_STATEMENT =
  /^[ \t]*import\s+(?:type\s+)?[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm;

/** Line number (1-based) of an offset in a text. */
function lineAt(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

/**
 * The pages this gate reads: the repository guide, every module's `docs/`, and
 * every page inside a package — `docs/`, `README.md`, and anything else
 * markdown that ships.
 *
 * `dist/` and `node_modules/` are excluded: the first is generated, the second
 * belongs to somebody else.
 */
export function documentedPages(root = ROOT) {
  const pages = new Set(markdownFiles(join(root, "docs")));
  for (const pkg of workspacePackages(root)) {
    for (const file of markdownFiles(pkg.abs)) pages.add(file);
  }
  return [...pages].sort();
}

/**
 * One page's fenced blocks as a compilable module, plus the line each emitted
 * line came from.
 *
 * Import statements are lifted to the top of the file — a snippet that imports
 * mid-block still declares the same things — and the lines they occupied are
 * left blank, so the mapping back to the page survives the rewrite.
 */
export function exampleSource(file, text, offset = 0) {
  const imports = [];
  const body = [];
  const map = [];

  for (const fence of text.matchAll(FENCE)) {
    const block = fence[1];
    const blockStart =
      offset + lineAt(text, fence.index + fence[0].indexOf(block));
    const lines = block.split(/\r?\n/);
    const lifted = new Set();

    for (const statement of block.matchAll(IMPORT_STATEMENT)) {
      const lineOffset =
        block.slice(0, statement.index).split(/\r?\n/).length - 1;
      const span = statement[0].split(/\r?\n/).length;
      for (let index = 0; index < span; index += 1)
        lifted.add(lineOffset + index);
      imports.push({
        text: statement[0].trim(),
        file,
        line: blockStart + lineOffset,
        span,
      });
    }

    lines.forEach((line, index) => {
      if (lifted.has(index)) return;
      body.push(line);
      map.push({ file, line: blockStart + index });
    });

    // Each block ends where its author stopped writing. Without a separator the
    // next block's first statement continues the previous one.
    body.push(";");
    map.push({ file, line: blockStart });
  }

  // A lifted import keeps its own line count: a three-line `import { a, b, c }`
  // occupies three lines wherever it is written, and mapping it to one would
  // shift every finding after it by two.
  const unique = [];
  for (const statement of imports) {
    if (!unique.some((candidate) => candidate.text === statement.text))
      unique.push(statement);
  }
  const header = unique.map((statement) => statement.text);
  const headerMap = unique.flatMap((statement) =>
    Array.from({ length: statement.span }, (_, index) => ({
      file: statement.file,
      line: statement.line + index,
    })),
  );

  return {
    source: [...header, ...(header.length ? [""] : []), ...body].join("\n"),
    map: [...headerMap, ...(header.length ? [{ file, line: 1 }] : []), ...map],
  };
}

/**
 * The `@agentix-e/*` specifiers a page may import, resolved to sources.
 *
 * Built from the packages' own `exports` maps so a documented subpath is the
 * subpath the manifest publishes, and pointed at `src/` so a page is judged
 * against the code rather than against whatever `dist/` happened to contain
 * when the gate ran.
 */
export function sourceAliases(root = ROOT) {
  const paths = {};
  for (const pkg of workspacePackages(root)) {
    const manifest = JSON.parse(
      readFileSync(join(pkg.abs, "package.json"), "utf8"),
    );
    for (const entry of exportEntries(pkg.abs)) {
      const key =
        entry.key === "."
          ? manifest.name
          : `${manifest.name}/${entry.key.slice(2)}`;
      paths[key] = [relative(root, entry.path)];
    }
  }
  return paths;
}

/** Where generated fragments are written: inside the repo so resolution works. */
function workspaceFor(root) {
  const candidates = [
    join(root, "node", "node_modules", ".cache", "doc-examples"),
    join(root, "node_modules", ".cache", "doc-examples"),
  ];
  return (
    candidates.find((dir) => existsSync(join(dir, "..", "..", "@types"))) ??
    null
  );
}

/** Compiler options that make fragments compilable against this repository. */
export function compilerOptions(root = ROOT) {
  // `@types/node` lives beside the module that depends on it, not at the
  // workspace root, and a `types` entry that names a missing package is a
  // diagnostic of its own. Only pass one when the directory is really there, so
  // a fixture tree compiles with the default libs and no ambient noise.
  const nodeTypes = [
    join(root, "node", "node_modules", "@types"),
    join(root, "cluster", "node_modules", "@types"),
    join(root, "node_modules", "@types"),
  ].find((dir) => existsSync(join(dir, "node")));

  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    baseUrl: root,
    paths: sourceAliases(root),
    ...(nodeTypes ? { typeRoots: [nodeTypes], types: ["node"] } : {}),
    lib: ["lib.es2022.d.ts"],
  };
}

/**
 * Write one generated module and return its path.
 *
 * The trailing `export {}` is load-bearing: a fragment that imports nothing is
 * a *script* to TypeScript, so its top-level declarations join the global
 * scope of the whole program and every other fragment with a class of the same
 * name. One page's `class HAFailoverDetector` then became the type of
 * `new InMemoryDeadlockDetector()` on a page about deadlock detection, and the
 * gate reported six findings about methods of a class that never appeared in
 * the block. `export {}` costs one line and keeps every fragment a module.
 */
function emit(dir, name, fragment) {
  const path = join(dir, `${name}.ts`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${fragment.source}\nexport {};\n`, "utf8");
  return path;
}

/**
 * Findings for a set of pages.
 *
 * Every fenced block is judged **on its own**, never concatenated with the rest
 * of the page. A block is the unit a reader copies, and the only unit whose
 * meaning the page controls from inside: aggregating blocks let one example's
 * loop variable shadow an unrelated value bound three sections earlier, and the
 * gate then reported a `MetricsSnapshot` passed where a `BackupMetadata` was
 * expected — a defect of the gate's own assembly. A block that builds on a value
 * the prose introduces is still read; it simply cannot be judged *about* that
 * value, because the name is not declared in the block, and "cannot find name"
 * is not a claim.
 *
 * `pages` are markdown paths; the return value names the page and the line a
 * reader would look at, never the generated file.
 */
export function auditExamples(pages, root = ROOT) {
  const base = workspaceFor(root);
  if (!base) return { findings: [], pageCount: 0 };
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  const options = compilerOptions(root);

  try {
    const fragments = [];
    for (const page of pages) {
      const text = readFileSync(page, "utf8");
      let index = 0;
      for (const block of text.matchAll(FENCE)) {
        index += 1;
        // The synthetic page keeps the block's real line numbers, so a finding
        // still points at the line a reader sees.
        const fragment = exampleSource(
          page,
          `\`\`\`ts\n${block[1]}\n\`\`\``,
          lineAt(text, block.index) - 1,
        );
        if (fragment.map.length === 0) continue;
        const name = `${relative(root, page).replace(/[\\/]/g, "__").replace(/\.md$/, "")}__${index}`;
        fragments.push({ ...fragment, path: emit(dir, name, fragment) });
      }
    }

    const byPath = new Map(
      fragments.map((fragment) => [fragment.path, fragment]),
    );
    const findings = [];
    for (const diagnostic of compile(
      fragments.map((fragment) => fragment.path),
      options,
    )) {
      const owner = byPath.get(diagnostic.path);
      if (owner) findings.push(describeDiagnostic(diagnostic, owner));
    }

    const pageCount = new Set(fragments.map((fragment) => fragment.map[0].file))
      .size;
    return { findings: dedupe(findings), pageCount };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Type-check generated files and return their judged diagnostics. */
function compile(paths, options) {
  if (paths.length === 0) return [];
  const program = ts.createProgram({ rootNames: paths, options });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => JUDGED_CODES.has(diagnostic.code))
    .map(toDiagnostic);
}

/**
 * One compiler diagnostic, in the shape the rest of the gate reads.
 *
 * A diagnostic need not belong to a file — the compiler reports options and
 * global problems the same way — so both the file and the position are optional
 * and both defaults mean "the page this fragment came from". Keeping that in one
 * exported function is what lets the defaults be asserted instead of hoped for.
 */
export function toDiagnostic(diagnostic) {
  const where = diagnostic.file ? diagnostic.file.fileName : "";
  const position =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
  return {
    path: where,
    line: position ? position.line : 0,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  };
}

/** Translate a generated-file diagnostic back to the page and line a reader sees. */
export function describeDiagnostic(diagnostic, fragment) {
  const origin = fragment.map[diagnostic.line] ?? {
    file: fragment.map[0]?.file ?? "",
    line: 1,
  };
  return {
    file: origin.file,
    line: origin.line,
    code: diagnostic.code,
    message: diagnostic.message,
    kind: JUDGED_CODES.get(diagnostic.code) ?? "wrong-about-the-api",
  };
}

/** The same page line can fail in both passes; it is one finding. */
export function dedupe(findings) {
  const seen = new Set();
  const kept = [];
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(finding);
  }
  return kept.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

/**
 * Print the verdict and return the exit code.
 *
 * The streams are parameters for the same reason every other gate takes them:
 * the failure branch is the one a green run never shows, and a gate whose
 * failure message nobody has read is a gate whose failure message can rot.
 */
export function report({ findings, pageCount }, root = ROOT, options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  if (findings.length > 0) {
    error(
      `\n✗ doc-examples: ${findings.length} finding(s) in ${pageCount} page(s)\n`,
    );
    for (const finding of findings) {
      error(
        `  ${relative(root, finding.file)}:${finding.line} TS${finding.code} — ${finding.message}`,
      );
    }
    error(
      "\nAn example that does not compile is a promise the reader cannot keep. " +
        "Either fix the example or fix the API it describes.\n",
    );
    return 1;
  }

  log(
    `✓ doc-examples: every fenced example type-checks (${pageCount} page(s))`,
  );
  return 0;
}

export function run(root = ROOT, options = {}) {
  const pages = documentedPages(root);
  const audited = auditExamples(pages, root);

  if (options.verbose ?? VERBOSE) {
    (options.log ?? console.log)(
      `  ${audited.pageCount} page(s) with examples, ${pages.length} page(s) read`,
    );
  }

  return report(audited, root, options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
