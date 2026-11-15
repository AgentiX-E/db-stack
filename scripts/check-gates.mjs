#!/usr/bin/env node
/**
 * check-gates — every gate must be wired to something that runs it.
 *
 * This repository has been bitten twice by the same failure mode, and both times
 * the artefact looked like a gate:
 *
 *   - a `coverage:merge` script pointed at a file that did not exist, so the
 *     "merge" step it guarded could never run;
 *   - each product package carried a `tsconfig.test.json` that no script, no
 *     turbo task and no workflow referenced. Under it sat 1192 type errors in
 *     three test trees, including tests that configured options the product
 *     never reads. An orphan configuration is documentation, not a gate.
 *
 * Both are structural, both are invisible to the tests themselves, and both are
 * detectable by reading the manifests. That is what this script does:
 *
 *   1. every `tsconfig*.json` in a workspace package is referenced by at least
 *      one script in that package (no orphan configurations);
 *   2. every file path a script mentions exists (no scripts pointing at air);
 *   3. every `tsc -p <config>` target exists;
 *   4. every `turbo run <task>` names a task declared in `turbo.json`;
 *   5. every task `turbo run <task>` asks for is defined by at least one package
 *      (otherwise turbo exits 0 having run nothing — a green gate over no work);
 *   6. every `pnpm run <script>` and `pnpm --filter <pkg> run <script>` in the
 *      workflows names a script that exists, in the package it names.
 *
 * Usage: node scripts/check-gates.mjs [--verbose]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const verbose = process.argv.includes("--verbose");

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

function walk(dir, predicate) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage"
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate));
    else if (predicate(full)) found.push(full);
  }
  return found;
}

// ── Workspace discovery ─────────────────────────────────────────────

const workspaceYaml = readText(resolve(root, "pnpm-workspace.yaml"));
const patterns = [
  ...workspaceYaml.matchAll(/^\s*-\s*'?([^'\n#]+?)'?\s*$/gm),
].map((m) => m[1].trim());

/** Expand the small subset of glob syntax the workspace file uses. */
function expand(pattern) {
  const parts = pattern.split("/");
  let current = [root];
  for (const part of parts) {
    const next = [];
    for (const base of current) {
      if (part === "*" || part === "**") {
        if (!existsSync(base)) continue;
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== "node_modules")
            next.push(join(base, entry.name));
        }
      } else {
        const candidate = join(base, part);
        if (existsSync(candidate) && statSync(candidate).isDirectory())
          next.push(candidate);
      }
    }
    current = next;
  }
  return current;
}

/** @type {{dir: string, name: string, scripts: Record<string,string>}[]} */
const packages = [];
for (const pattern of patterns) {
  for (const dir of expand(pattern)) {
    const manifest = resolve(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const json = readJson(manifest);
    packages.push({
      dir,
      name: json.name ?? relative(root, dir),
      scripts: json.scripts ?? {},
    });
  }
}
if (packages.length === 0)
  failures.push("workspace discovery found no packages");

const turbo = readJson(resolve(root, "turbo.json"));
const turboTasks = new Set(Object.keys(turbo.tasks ?? {}));

// ── 1. no orphan tsconfig ───────────────────────────────────────────

for (const pkg of packages) {
  const configs = readdirSync(pkg.dir).filter((f) =>
    /^tsconfig(\..+)?\.json$/.test(f),
  );
  const references = [Object.values(pkg.scripts).join("\n")];
  // A configuration is also wired when another configuration extends it: the
  // base config of a package is imported, not executed.
  for (const config of configs) {
    try {
      const parsed = readJson(resolve(pkg.dir, config));
      if (typeof parsed.extends === "string") references.push(parsed.extends);
    } catch {
      /* a config that does not parse is reported by tsc, not here */
    }
  }
  const referenceText = references.join("\n");
  for (const config of configs) {
    if (!referenceText.includes(config)) {
      failures.push(
        `${pkg.name}: ${config} exists but no script references it — an orphan configuration is not a gate`,
      );
    } else if (verbose) {
      notes.push(`${pkg.name}: ${config} is wired`);
    }
  }
}

// ── 2/3. script arguments that are paths must exist ─────────────────

const PATH_ARG =
  /(?:^|\s)(?:\.\/)?([\w@./-]+\.(?:json|mjs|cjs|mts|cts|tsx|ts|jsx|js))/g;

for (const pkg of packages) {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const match of command.matchAll(PATH_ARG)) {
      const candidate = match[1];
      // Skip anything that is clearly not a repository path: version-ish tokens
      // and GitHub Actions expressions such as `${{ matrix.package }}`.
      if (/^\d/.test(candidate) || candidate.includes("${{")) continue;
      const absolute = resolve(pkg.dir, candidate);
      if (!existsSync(absolute)) {
        failures.push(
          `${pkg.name}: script "${name}" references ${candidate}, which does not exist`,
        );
      }
    }
    // `tsc -p <config>` must point at a real config even when it omits the extension.
    for (const match of command.matchAll(/tsc\s+-p\s+([\w@./-]+)/g)) {
      const absolute = resolve(pkg.dir, match[1]);
      if (!existsSync(absolute)) {
        failures.push(
          `${pkg.name}: script "${name}" runs tsc -p ${match[1]}, which does not exist`,
        );
      }
    }
    // `turbo run <task>` must name a declared task.
    for (const match of command.matchAll(/turbo\s+run\s+([\w:.-]+)/g)) {
      if (!turboTasks.has(match[1])) {
        failures.push(
          `${pkg.name}: script "${name}" runs turbo task "${match[1]}", not declared in turbo.json`,
        );
      }
    }
  }
}

// ── 5. a turbo task with no implementer is a green gate over no work ─

const declaredTasks = new Set();
for (const pkg of packages)
  for (const name of Object.keys(pkg.scripts)) declaredTasks.add(name);

for (const [name, definition] of Object.entries(turbo.tasks ?? {})) {
  if (definition.persistent || definition.extends) continue;
  if (!declaredTasks.has(name)) {
    failures.push(
      `turbo.json declares task "${name}" that no package implements — it would run nothing and pass`,
    );
  }
}

// ── 6. workflows may only call scripts that exist ──────────────────

const workflowDir = resolve(root, ".github/workflows");
if (existsSync(workflowDir)) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const dirToName = new Map(
    packages.map((p) => [relative(root, p.dir).replaceAll("\\", "/"), p.name]),
  );

  for (const file of readdirSync(workflowDir).filter((f) =>
    /\.ya?ml$/.test(f),
  )) {
    const lines = readText(resolve(workflowDir, file)).split("\n");
    let filter = null;

    for (const [index, line] of lines.entries()) {
      // Prose about a command is not a command: the workflow explains itself in
      // comments, and one of them quotes `pnpm --filter ... run build`.
      if (line.trimStart().startsWith("#")) continue;
      // `pnpm --filter <target> run <script>` sets the target for this line only.
      const filtered = line.match(
        /pnpm\s+--filter\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+run\s+([\w:.-]+)/,
      );
      if (filtered) {
        filter = filtered[1] ?? filtered[2] ?? filtered[3];
        const script = filtered[4];
        const targets = resolveFilter(filter, packages, dirToName, byName);
        for (const target of targets) {
          if (!(script in target.scripts)) {
            failures.push(
              `${file}:${index + 1} runs "${script}" in ${target.name}, which does not define it`,
            );
          }
        }
        continue;
      }
      // A bare `pnpm run <script>` in a step inherits the step's working-directory,
      // which is either absent (root) or a package path; check the root and the
      // root of every package that the file's steps set as working-directory.
      const bare = line.match(/(?<!-)(?<![\w-])pnpm\s+run\s+([\w:.-]+)/);
      if (bare) {
        const script = bare[1];
        const rootScripts =
          readJson(resolve(root, "package.json")).scripts ?? {};
        if (!(script in rootScripts)) {
          failures.push(
            `${file}:${index + 1} runs "pnpm run ${script}" but the root package does not define it`,
          );
        }
        continue;
      }
      const turboRun = line.match(
        /pnpm\s+--filter=(?:'([^']+)'|"([^"]+)"|(\S+))\s+turbo\s+run\s+([\w:.-]+)/,
      );
      if (turboRun) {
        const task = turboRun[4];
        if (!turboTasks.has(task))
          failures.push(
            `${file}:${index + 1} runs turbo task "${task}", not declared`,
          );
        else if (!declaredTasks.has(task)) {
          failures.push(
            `${file}:${index + 1} runs turbo task "${task}" that no package implements`,
          );
        }
      }
    }
    void filter;
  }
}

function resolveFilter(filter, all, dirToName, byName) {
  if (!filter) return [];
  // A matrix expression is resolved per job instance at run time; the checker
  // cannot and should not guess which package it names.
  if (filter.includes("${{")) return [];
  if (byName.has(filter)) return [byName.get(filter)];
  const cleaned = filter.replace(/^\.\//, "").replace(/\/$/, "");
  const byDir = all.filter(
    (p) => relative(root, p.dir).replaceAll("\\", "/") === cleaned,
  );
  if (byDir.length) return byDir;
  // `--filter "./cluster..."` (turbo dependency syntax) names a package directory.
  const trimmed = cleaned.replace(/\.\.\.$/, "").replace(/\/$/, "");
  const loose = all.filter(
    (p) => relative(root, p.dir).replaceAll("\\", "/") === trimmed,
  );
  if (loose.length) return loose;
  // A brace-set or glob the checker cannot resolve is reported, not ignored.
  failures.push(
    `workflow filter "${filter}" does not name a workspace package`,
  );
  return [];
}

// ── Report ─────────────────────────────────────────────────────────

if (verbose) for (const note of notes) console.log(`ok   ${note}`);

if (failures.length) {
  console.error(`check-gates: ${failures.length} structural problem(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(
  `check-gates: ${packages.length} packages, ${Object.keys(turbo.tasks ?? {}).length} turbo tasks — every gate is wired`,
);
