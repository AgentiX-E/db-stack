#!/usr/bin/env node
/**
 * check-public-types — an exported signature may not name a type the package
 * does not export.
 *
 * `FederationManager.replicate()` returns `ReplicatedEntry`, an interface
 * declared beside it in `core/FederationManager.ts` that `src/index.ts` never
 * re-exported. A consumer could call the method but could not write the type of
 * its result: `import type { ReplicatedEntry } from '@agentix-e/db-federation'`
 * fails, and the compiler's only suggestion is to reach into
 * `dist/core/FederationManager.js`, a path the package's `exports` map does not
 * publish. The type was nameable inside the package and unnameable outside it,
 * which is the one thing a public API must never be.
 *
 * Nothing caught it because every mention of that type was inside the package,
 * where the relative import resolves. The defect is invisible from the inside by
 * construction, so it has to be found from the outside — by asking each package
 * which types its exported signatures mention, and whether its entry point
 * exports them.
 *
 * The walk is transitive rather than one layer deep: an unexported type is
 * reported and then walked anyway, because exporting it is what publishes its
 * members, and those members may name further types. One run yields the closure.
 *
 * Usage: node scripts/check-public-types.mjs [--verbose]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { workspacePackages } from "./check-docs-api.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

/** Members every object has; they say nothing about the API. */
const IGNORED_MEMBERS = new Set(["prototype", "constructor"]);

/**
 * Symbols a consumer imports by name. A method or property is not one of these:
 * its symbol is reachable only through the object that declares it, so it never
 * needs an export of its own. Without this filter the walk reports every method
 * it passes through as an unexportable type, which buries the real findings.
 */
const NAMED_TYPE_FLAGS =
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeAlias |
  ts.SymbolFlags.Enum;

/** A type a consumer never has to name. */
function isUntouchable(type) {
  if (!type) return true;
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
  )
    return true;
  const symbol = type.getSymbol();
  return Boolean(symbol && symbol.flags & ts.SymbolFlags.TypeParameter);
}

/**
 * The entry point's exports, keyed by symbol identity.
 *
 * Identity rather than name: `index.ts` may re-export `ReplicatedEntry as Entry`,
 * and the type is then perfectly nameable even though the declaring file's name
 * is not what the entry publishes.
 */
export function entryExports(program, entryPath) {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryPath);
  if (!source) throw new Error(`cannot load ${entryPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`no module symbol for ${entryPath}`);

  const symbols = new Set();
  const names = new Map();
  for (const raw of checker.getExportsOfModule(moduleSymbol)) {
    if (raw.getName() === "default") continue;
    const symbol =
      raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
    symbols.add(symbol);
    if (!names.has(symbol)) names.set(symbol, raw.getName());
  }
  return { checker, source, symbols, names };
}

/** True when every declaration of the symbol lives inside this package. */
export function isLocal(symbol, packageRoot) {
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return false;
  return declarations.every((decl) =>
    decl.getSourceFile().fileName.startsWith(packageRoot),
  );
}

/**
 * Types named by the package's public surface that the package does not export.
 *
 * `via` records the path that reached the type, so the failure can say how a
 * consumer would run into it: `FederationManager.replicate(): → ReplicatedEntry`
 * is actionable in a way that a bare list of names is not.
 */
export function auditPackage(entryPath, packageRoot, options = {}) {
  const program =
    options.program ??
    ts.createProgram([entryPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
    });
  const {
    checker,
    source,
    symbols: exported,
    names,
  } = entryExports(program, entryPath);

  // Every published entry of the package counts, not only this one: a consumer
  // importing `@agentix-e/db-cluster/testing` can still import `RaftAdapter` from
  // the root, so the type is nameable and the subpath is not at fault.
  const findings = [];
  const reported = new Set();
  const walkedTypes = new Set();
  const walkedSymbols = new Set();

  const exportedAnywhere = (symbol) => exported.has(symbol) || Boolean(options.elsewhere?.has(symbol));

  const record = (symbol, via) => {
    if (!(symbol.flags & NAMED_TYPE_FLAGS)) return false;
    if (exportedAnywhere(symbol) || reported.has(symbol)) return false;
    if (!isLocal(symbol, packageRoot)) return false;
    const name = symbol.getName();
    if (name.startsWith("__")) return false;
    reported.add(symbol);
    findings.push({ name, via });
    return true;
  };

  const visitSignature = (signature, via, depth) => {
    for (const parameter of signature.getParameters()) {
      const type = checker.getTypeOfSymbolAtLocation(parameter, source);
      visitType(type, `${via}(${parameter.getName()})`, depth);
    }
    visitType(signature.getReturnType(), `${via}():`, depth);
  };

  function visitType(type, via, depth) {
    if (isUntouchable(type) || depth > 8) return;
    const key = type.id ?? `${type.flags}:${checker.typeToString(type)}`;
    if (walkedTypes.has(key)) return;
    walkedTypes.add(key);

    const symbol = type.getSymbol() ?? type.aliasSymbol;
    if (symbol && !(symbol.flags & ts.SymbolFlags.TypeParameter)) {
      const fresh = record(symbol, via);
      if (fresh || exported.has(symbol))
        walkMembers(symbol, `${via} → ${symbol.getName()}`, depth + 1);
    }

    if (type.isUnionOrIntersection()) {
      for (const part of type.types) visitType(part, via, depth);
    }
    if (type.objectFlags & ts.ObjectFlags.Reference) {
      for (const argument of checker.getTypeArguments(type))
        visitType(argument, via, depth);
    }
    for (const kind of [ts.IndexKind.String, ts.IndexKind.Number]) {
      const indexType = checker.getIndexTypeOfType(type, kind);
      if (indexType) visitType(indexType, via, depth);
    }
    if (
      type.objectFlags & ts.ObjectFlags.Mapped &&
      type.typeParameter.constraint
    ) {
      visitType(
        checker.getBaseConstraintOfType(type.typeParameter.constraint) ??
          type.typeParameter.constraint,
        via,
        depth,
      );
    }
  }

  function walkMembers(symbol, via, depth) {
    if (walkedSymbols.has(symbol)) return;
    walkedSymbols.add(symbol);
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    for (const property of declared.getProperties()) {
      const name = property.getName();
      if (IGNORED_MEMBERS.has(name) || name.startsWith("__@")) continue;
      const declaration = property.declarations?.[0];
      const modifiers = declaration
        ? ts.getCombinedModifierFlags(declaration)
        : 0;
      if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))
        continue;
      const memberVia = `${via}.${name}`;
      const type = checker.getTypeOfSymbolAtLocation(property, source);
      visitType(type, memberVia, depth);
      for (const signature of type.getCallSignatures())
        visitSignature(signature, memberVia, depth);
      for (const signature of type.getConstructSignatures())
        visitSignature(signature, memberVia, depth);
    }
    for (const signature of declared.getCallSignatures())
      visitSignature(signature, via, depth);
    for (const signature of declared.getConstructSignatures())
      visitSignature(signature, via, depth);
  }

  for (const symbol of exported) {
    const name = names.get(symbol) ?? symbol.getName();
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    for (const signature of declared.getCallSignatures())
      visitSignature(signature, name, 0);
    for (const signature of declared.getConstructSignatures())
      visitSignature(signature, `new ${name}`, 0);
    const value = checker.getTypeOfSymbolAtLocation(symbol, source);
    for (const signature of value.getCallSignatures())
      visitSignature(signature, name, 0);
    for (const signature of value.getConstructSignatures())
      visitSignature(signature, `new ${name}`, 0);
    walkMembers(symbol, name, 0);
  }

  return { exported: exported.size, findings };
}

/**
 * Every entry the manifest publishes, mapped back to the source file it is built
 * from.
 *
 * `exports: { "./shard": { types: "./dist/interfaces/shard/index.d.ts" } }` names
 * a file that has to exist on both sides of the build. This package published
 * that subpath while `src/interfaces/shard/index.ts` did not exist, so the dist
 * entry was never emitted and the import failed with `ERR_MODULE_NOT_FOUND` —
 * a promise in a manifest that only the first consumer could falsify.
 */
export function publishedEntries(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const entries = [];
  const exportsMap = manifest.exports ?? {};
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath === "./package.json") continue;
    if (typeof target === "string") continue;
    const distTypes = target.types ?? target.import;
    if (!distTypes) continue;
    const source = distTypes
      .replace(/^\.\/dist\//, "./src/")
      .replace(/\.d\.ts$/, ".ts")
      .replace(/\.js$/, ".ts");
    entries.push({
      subpath,
      source: join(pkgDir, source.replace(/^\.\//, "")),
      declared: distTypes,
    });
  }
  return entries;
}

export function run(root = ROOT) {
  const packages = workspacePackages(root).filter((pkg) =>
    existsSync(join(pkg.abs, "src", "index.ts")),
  );
  const failures = [];
  const notes = [];

  for (const pkg of packages) {
    const published = publishedEntries(pkg.abs);
    for (const entry of published) {
      if (!existsSync(entry.source)) {
        failures.push({
          dir: pkg.dir,
          kind: "missing-entry",
          name: entry.subpath,
          via: `${entry.declared} has no source file`,
        });
      }
    }

    const entryPaths = [join(pkg.abs, "src", "index.ts")];
    for (const entry of published) {
      if (existsSync(entry.source) && entry.subpath !== ".") entryPaths.push(entry.source);
    }

    // One program for every entry of the package, so the exported symbols of the
    // subpaths are the same symbol objects the root's signatures refer to.
    const program = ts.createProgram(entryPaths, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
    });
    const union = new Set();
    for (const entryPath of entryPaths) {
      for (const symbol of entryExports(program, entryPath).symbols) union.add(symbol);
    }

    let exported = 0;
    let found = 0;
    for (const entryPath of entryPaths) {
      const result = auditPackage(entryPath, `${pkg.abs}/`, { program, elsewhere: union });
      exported = Math.max(exported, result.exported);
      found += result.findings.length;
      for (const finding of result.findings) {
        failures.push({
          dir: pkg.dir,
          kind: "unexported-type",
          ...finding,
          entry: entryPath.replace(`${pkg.abs}/`, ""),
        });
      }
    }
    notes.push(
      `${pkg.dir}: ${exported} exports, ${entryPaths.length} entry(s), ${found} unnameable type(s)`,
    );
  }

  if (VERBOSE) for (const note of notes) console.log(`  ${note}`);

  if (failures.length > 0) {
    console.error(`\n✗ public-types: ${failures.length} finding(s)\n`);
    for (const failure of failures) {
      if (failure.kind === "missing-entry") {
        console.error(
          `  ${failure.dir}: publishes \`${failure.name}\` but ${failure.via}`,
        );
        continue;
      }
      console.error(
        `  ${failure.dir}: \`${failure.name}\` appears in a public signature but no ` +
          `published entry exports it (${failure.entry})\n      via ${failure.via}`,
      );
    }
    console.error(
      "\nA type a consumer has to name must be importable from a published entry, " +
        "and a published entry must be buildable. Export it, or stop exposing it.\n",
    );
    return 1;
  }

  console.log(
    `✓ public-types: every type named by a public signature is exportable from a ` +
      `published entry (${packages.length} packages)`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
