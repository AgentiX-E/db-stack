#!/usr/bin/env node
/**
 * check-package — verify the *published* artefacts are actually consumable.
 *
 * Compiling successfully is not the same as being importable: declaration
 * entry points can point at files that are never emitted, and extensionless
 * ESM specifiers fail at runtime in Node. This check loads every published
 * entry point from `dist/` in a plain Node process (no bundler, no tsx) and
 * asserts the documented exports exist.
 *
 * Existing is not the same as working, either. A `behaviour` probe goes one step
 * further and *calls* the entry point: three published features once passed both
 * the compiler and the whole test suite while throwing
 * `ReferenceError: require is not defined in ES module scope` (a CommonJS
 * `require` inside an ESM module) or silently losing their trace ids. The test
 * transform supplies a `require`; a consumer does not. So the last thing this
 * script does is run the artefact the way a consumer would.
 *
 * It was the one gate no test loaded, and the reason was circular: importing the
 * module ran the check, and the check needed a build, so the Quality job — which
 * deliberately does not build — could not measure it. The driver is now a
 * function, the process it starts is a parameter, and `check-package.test.mjs`
 * builds throwaway packages with a real `dist/` and judges them. The rule that
 * matters most, "a package ships its docs or the check fails", had never been
 * shown to fail; a rule nobody has seen fire is a rule nobody knows still works.
 *
 * Usage: node scripts/check-package.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workspacePackages } from "./check-docs-api.mjs";
import { TARGETS } from "./package-targets.mjs";

const ROOT = resolve(import.meta.dirname, "..");

export { TARGETS } from "./package-targets.mjs";

/** `cluster`, `cluster/testing` — how a reader names the entry that failed. */
export function labelOf(target) {
  return `${target.dir}${target.entry === "." ? "" : `/${target.entry.slice(2)}`}`;
}

/**
 * What a target promises to publish, or the reason it cannot be checked.
 *
 * A returned finding rather than an exception: "the manifest names a file that
 * was never emitted" is one of the defects this gate exists to report, and a
 * check that dies on it reports nothing.
 */
export function resolveTarget(target, root) {
  const pkgDir = resolve(root, target.dir);
  const label = labelOf(target);

  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath))
    return { label, pkgDir, problem: "package.json missing" };

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const subpath = manifest.exports?.[target.entry];
  if (!subpath)
    return {
      label,
      pkgDir,
      problem: `no "exports" entry for "${target.entry}"`,
    };

  // Resolve the file the package *publishes* for this subpath. Importing the
  // package name would additionally require a node_modules link that only
  // exists in a consumer install, so the check is anchored to the declared
  // target instead: it still fails when the path is not emitted, when an ESM
  // specifier lost its extension, or when an export is missing.
  const declared = subpath.import ?? subpath.default ?? subpath;
  const entryFile = resolve(pkgDir, declared);
  if (!existsSync(entryFile))
    return {
      label,
      pkgDir,
      problem: `declared entry not emitted (${declared})`,
    };

  return { label, pkgDir, entryFile };
}

/**
 * The module a consumer's plain Node process is asked to run.
 *
 * The behaviour probe travels as source, because the child cannot see the
 * parent's closures. That is the point: the probe exists to run the artefact in
 * a process the test transform has not touched, and sharing a module graph with
 * the gate would undo exactly what it measures.
 */
export function probeModule(target, entryFile) {
  return `
    const expected = ${JSON.stringify(target.expect)};
    const url = ${JSON.stringify(pathToFileURL(entryFile).href)};
    const probeSource = ${JSON.stringify(target.behaviour ? target.behaviour.toString() : null)};
    const loaded = await import(url);
    const missing = expected.filter((name) => !(name in loaded));
    if (missing.length > 0) {
      console.error('missing exports: ' + missing.join(', '));
      process.exit(1);
    }
    if (probeSource) {
      const assert = (await import('node:assert/strict')).default;
      const probe = new Function('return (' + probeSource + ')')();
      await probe({ loaded, assert });
    }
    console.log('ok (' + Object.keys(loaded).length + ' exports' +
      (probeSource ? ', behaviour verified' : '') + ')');
  `;
}

/** What a failing child says when it says something worth reading. */
const DIAGNOSIS = /\b\w*Error\b|missing exports:/;

/**
 * The head of a failing child's output, with the diagnosis first.
 *
 * "AssertionError: MerkleTree.build() must not double the leaf set" is the whole
 * diagnosis, and the first four lines of a crashed Node process are four frames
 * of `node:internal/…` — so the line that names the failure is moved to the
 * front rather than hoped for inside a fixed window.
 */
export function summarise(result) {
  const lines = (result.stderr || result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const diagnosis = lines.findIndex((line) => DIAGNOSIS.test(line));
  if (diagnosis > 0) lines.unshift(...lines.splice(diagnosis, 1));
  return lines.slice(0, 4).join(" | ");
}

/**
 * The documentation has to be in the tarball as well as in the repository.
 *
 * Every package here ships `dist`, `README.md` and `CHANGELOG.md`, and every one
 * of the fourteen with a `docs/` tree left it out — so the reference pages this
 * repository gates so carefully (`api-reference.md`, the harness pages, the
 * engine-adapter guide) were readable on GitHub and absent from
 * `node_modules`, which is the first place a consumer looks.
 *
 * The assertion reads `npm pack`, not the manifest: `files` can name a directory
 * that a `.npmignore` then empties, and only the tarball knows what a consumer
 * receives.
 */
export function checkPublishedDocs(root, options = {}) {
  const error = options.error ?? console.error;
  const pack =
    options.pack ??
    ((dir) =>
      spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: dir,
        encoding: "utf8",
      }));

  let missing = 0;

  for (const pkg of workspacePackages(root)) {
    if (!existsSync(join(pkg.abs, "docs"))) continue;

    const packed = pack(pkg.abs);
    if (packed.status !== 0) {
      error(`\u2717 ${pkg.dir}: npm pack failed`);
      missing += 1;
      continue;
    }

    let paths = [];
    try {
      paths = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
    } catch {
      error(`\u2717 ${pkg.dir}: could not read the pack manifest`);
      missing += 1;
      continue;
    }

    const pages = paths.filter((path) => path.startsWith("docs/"));
    if (pages.length === 0) {
      error(
        `\u2717 ${pkg.dir}: docs/ exists in the repository but not in the tarball`,
      );
      missing += 1;
    }
  }

  return missing;
}

/**
 * Judge every target and say so.
 *
 * The two sinks and the process the artefacts run in are parameters. A gate
 * whose only reachable path is the command line is a gate no test can start,
 * and this one spent several iterations in exactly that state.
 */
export function run(root = ROOT, options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const spawn = options.spawn ?? spawnSync;
  const targets = options.targets ?? TARGETS;

  let failures = 0;

  for (const target of targets) {
    const resolved = resolveTarget(target, root);
    if (resolved.problem) {
      error(`\u2717 ${resolved.label}: ${resolved.problem}`);
      failures += 1;
      continue;
    }

    const result = spawn(
      process.execPath,
      ["--input-type=module", "-e", probeModule(target, resolved.entryFile)],
      { cwd: resolved.pkgDir, encoding: "utf8" },
    );

    if (result.status !== 0) {
      error(`\u2717 ${resolved.label}: ${summarise(result)}`);
      failures += 1;
    } else {
      log(`\u2713 ${resolved.label} ${result.stdout.trim()}`);
    }
  }

  failures += checkPublishedDocs(root, { error, pack: options.pack });

  if (failures > 0) {
    error(`\nPackage check FAILED (${failures} finding(s))`);
    return 1;
  }
  log(
    "\nPackage check passed: every published entry point is importable, its probe passes, " +
      "and every package ships its documentation.",
  );
  return 0;
}

/**
 * Whether this module was started as the program.
 *
 * Spelled out rather than inlined, so a test can ask the runtime's question.
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

if (isEntryPoint(process.argv[1])) {
  process.exit(run(ROOT, { log: console.log, error: console.error }));
}
