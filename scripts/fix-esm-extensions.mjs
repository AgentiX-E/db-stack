#!/usr/bin/env node
/**
 * fix-esm-extensions — post-build codemod that makes `tsc` ESM output
 * loadable by Node.js.
 *
 * TypeScript resolves `./foo` to `./foo.ts` at compile time, but Node's ESM
 * loader requires a fully specified specifier (`./foo.js`). Building with
 * `moduleResolution: bundler` keeps the source readable while this pass makes
 * `dist/` Node-compatible, so the published packages can be consumed with
 * plain `import` (no bundler, no experimental flags).
 *
 * The rewriting is exported and takes a directory, so a test can build a
 * miniature `dist/` and assert what the pass does to it — including the part
 * that matters most: a specifier it cannot resolve is left alone rather than
 * guessed at, so the build fails on the real mistake instead of shipping a
 * path to a file that does not exist.
 *
 * Usage: node scripts/fix-esm-extensions.mjs <dist-dir> [...more dist dirs]
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SPECIFIER = /(from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]*)\2/g;
const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function walk(dir, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Rewrite one relative specifier so Node can resolve it. */
export async function fixSpecifier(fromFile, specifier) {
  // Already explicit — nothing to do.
  if (JS_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return specifier;

  const absolute = resolve(dirname(fromFile), specifier);
  for (const ext of JS_EXTENSIONS) {
    if (await exists(`${absolute}${ext}`)) return `${specifier}${ext}`;
  }
  if (await isDirectory(absolute)) {
    for (const ext of JS_EXTENSIONS) {
      if (await exists(join(absolute, `index${ext}`)))
        return `${specifier.replace(/\/$/, "")}/index${ext}`;
    }
  }
  // Unresolvable specifier: leave untouched so the build fails loudly downstream
  // instead of silently pointing at a non-existent file.
  return specifier;
}

/** Rewrite every relative specifier in one emitted file. Returns how many moved. */
export async function processFile(file) {
  const source = await readFile(file, "utf8");
  const matches = [...source.matchAll(SPECIFIER)];
  if (matches.length === 0) return 0;

  let output = source;
  let changed = 0;
  for (const match of matches) {
    const [full, prefix, quote, specifier] = match;
    const fixed = await fixSpecifier(file, specifier);
    if (fixed !== specifier) {
      output = output.replace(full, `${prefix}${quote}${fixed}${quote}`);
      changed += 1;
    }
  }
  if (changed > 0) await writeFile(file, output);
  return changed;
}

/**
 * Rewrite every `dist/` directory named on the command line.
 *
 * `cwd` is a parameter rather than `process.cwd()` so a test can point the pass
 * at a temporary tree and assert the count it reports.
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const cwd = options.cwd ?? process.cwd();

  if (argv.length === 0) {
    error("usage: fix-esm-extensions.mjs <dist-dir> [...]");
    return 2;
  }

  let totalFiles = 0;
  let totalSpecifiers = 0;
  for (const target of argv) {
    const distDir = resolve(cwd, target);
    if (!(await isDirectory(distDir))) continue;
    const files = await walk(distDir);
    for (const file of files) {
      const changed = await processFile(file);
      if (changed > 0) totalFiles += 1;
      totalSpecifiers += changed;
    }
  }
  log(
    `fix-esm-extensions: ${totalSpecifiers} specifier(s) in ${totalFiles} file(s) rewritten`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
