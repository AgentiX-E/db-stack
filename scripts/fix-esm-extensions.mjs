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
 * Usage: node scripts/fix-esm-extensions.mjs <dist-dir> [...more dist dirs]
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const SPECIFIER = /(from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]*)\2/g;
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(dir, files = []) {
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
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Rewrite one relative specifier so Node can resolve it. */
async function fixSpecifier(fromFile, specifier) {
  // Already explicit — nothing to do.
  if (JS_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return specifier;

  const absolute = resolve(dirname(fromFile), specifier);
  for (const ext of JS_EXTENSIONS) {
    if (await exists(`${absolute}${ext}`)) return `${specifier}${ext}`;
  }
  if (await isDirectory(absolute)) {
    for (const ext of JS_EXTENSIONS) {
      if (await exists(join(absolute, `index${ext}`))) return `${specifier.replace(/\/$/, '')}/index${ext}`;
    }
  }
  // Unresolvable specifier: leave untouched so the build fails loudly downstream
  // instead of silently pointing at a non-existent file.
  return specifier;
}

async function processFile(file) {
  const source = await readFile(file, 'utf8');
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

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('usage: fix-esm-extensions.mjs <dist-dir> [...]');
    process.exit(2);
  }

  let totalFiles = 0;
  let totalSpecifiers = 0;
  for (const target of targets) {
    const distDir = resolve(process.cwd(), target);
    if (!(await isDirectory(distDir))) continue;
    const files = await walk(distDir);
    for (const file of files) {
      const changed = await processFile(file);
      if (changed > 0) totalFiles += 1;
      totalSpecifiers += changed;
    }
  }
  console.log(`fix-esm-extensions: ${totalSpecifiers} specifier(s) in ${totalFiles} file(s) rewritten`);
}

await main();
