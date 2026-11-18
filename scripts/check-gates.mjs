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
 *      workflows names a script that exists, in the package it names;
 *   7. mutation testing is one instrument per package, and every instrument is
 *      pulled: a `test:mutation` script must have a Stryker config whose `mutate`
 *      list and test set both resolve to real files, must carry a `break`
 *      threshold, and must be invoked by a workflow. The operations package
 *      shipped three separate hand-rolled mutation engines, none of which any
 *      workflow ran, while its README quoted the score of one of them.
 *
 * Usage: node scripts/check-gates.mjs [--verbose]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

/** Convert the small glob vocabulary the configs use to a RegExp. */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Every file under `dir` whose path relative to it matches `pattern`. */
function filesMatching(dir, pattern) {
  if (!existsSync(dir)) return [];
  const re = globToRegExp(pattern);
  return walk(dir, () => true)
    .map((file) => relative(dir, file).replaceAll("\\", "/"))
    .filter((file) => re.test(file));
}

// ── 7. mutation testing: one instrument, one sandbox, every target pulled ─
//
// The instrument used to be one Stryker config per package, run with `--inPlace`.
// In place is not a sandbox: four workers read the sources a fifth was rewriting, and
// the whole reason for the flag was that a per-package sandbox has no parent — so
// neither `tsconfig.base.json` (which every `operations` tsconfig extends, and which
// Vite reads while transforming) nor `scripts/test-tmpdir.mjs` (which every
// `vitest.setup.ts` imports) exists inside it.
//
// Both of those files are at the repository root, so the sandbox that contains them is
// a copy of the repository — which means the run has to start at the root. That is now
// the shape, and the checks below hold it: one config, one entry point, no in-place,
// and every target still honest about the files it mutates and the suite behind them.

const rootGitignore = readText(resolve(root, ".gitignore"));
const workflowText = existsSync(workflowDir)
  ? readdirSync(workflowDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readText(resolve(workflowDir, f)))
      .join("\n")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
  : "";

const mutationConfigPath = resolve(root, "stryker.config.mjs");
if (!existsSync(mutationConfigPath)) {
  failures.push(
    "stryker.config.mjs is missing from the root — the mutation gate has no instrument",
  );
} else {
  // The config's default export throws without a target (running the wrong package
  // silently is worse than not running), so the table is imported directly.
  let targets;
  let shared;
  try {
    ({ TARGETS: targets, SHARED: shared } = await import(
      pathToFileURL(resolve(root, "mutation/targets.mjs")).href
    ));
  } catch (error) {
    failures.push(`mutation/targets.mjs cannot be imported: ${error.message}`);
  }

  const configText = readText(mutationConfigPath);
  if (!/IN_PLACE_FLAG/.test(configText)) {
    failures.push(
      "stryker.config.mjs does not refuse --inPlace — an in-place run is not a sandbox, and its verdicts cannot be trusted",
    );
  }

  const runnerPath = resolve(root, "scripts/mutation.mjs");
  const runnerText = existsSync(runnerPath) ? readText(runnerPath) : "";
  if (!runnerText) {
    failures.push("scripts/mutation.mjs is missing — nothing anchors the run to the repository root");
  } else if (!/resolve\(process\.cwd\(\)\)\s*!==\s*repositoryRoot/.test(runnerText)) {
    failures.push(
      "scripts/mutation.mjs does not check the working directory — from a package directory the sandbox loses its parent",
    );
  }

  for (const ignored of ["reports/mutation/", ".stryker-tmp/"]) {
    if (!rootGitignore.includes(ignored)) {
      failures.push(`.gitignore does not ignore ${ignored} — a mutation run would stage its own output`);
    }
  }

  const rootScripts = readJson(resolve(root, "package.json")).scripts ?? {};
  const seen = new Set();

  for (const [target, entry] of Object.entries(targets ?? {})) {
    seen.add(target);

    if (typeof entry.thresholds?.break !== "number") {
      failures.push(
        `mutation target "${target}": no numeric thresholds.break — a score nobody fails on is a report, not a gate`,
      );
    }

    // Root-relative, because the root is where the run starts and where the sandbox
    // copies from. A pattern that matches nothing would silently mutate nothing and
    // report a perfect score over no mutants.
    const mutate = Array.isArray(entry.mutate) ? entry.mutate : [];
    if (mutate.length === 0) failures.push(`mutation target "${target}": mutates nothing`);
    for (const pattern of mutate) {
      const matches = filesMatching(root, pattern);
      if (matches.length === 0) {
        failures.push(
          `mutation target "${target}": mutate pattern "${pattern}" matches no file`,
        );
      } else if (verbose) {
        notes.push(`mutation target "${target}": ${matches.length} file(s) for ${pattern}`);
      }
    }

    const testConfig = entry.testConfig;
    const testConfigPath = typeof testConfig === "string" ? resolve(root, testConfig) : "";
    if (!testConfigPath || !existsSync(testConfigPath)) {
      failures.push(
        `mutation target "${target}": testConfig "${testConfig}" does not exist`,
      );
    } else {
      const text = readText(testConfigPath);
      const includeMatch = text.match(/include:\s*\[([\s\S]*?)\]/);
      const includePatterns = includeMatch
        ? [...includeMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
        : [];
      if (includePatterns.length === 0) {
        failures.push(
          `mutation target "${target}": ${testConfig} declares no include list — the verdict would come from the whole suite`,
        );
      }
      // Includes are relative to the package the config lives in, so a pattern has to
      // resolve there, not at the root.
      const packageDir = dirname(testConfigPath);
      for (const pattern of includePatterns) {
        if (filesMatching(packageDir, pattern).length === 0) {
          failures.push(
            `mutation target "${target}": ${testConfig} includes "${pattern}", which matches no test file`,
          );
        }
      }

      // A test timeout above the runner's own cap cannot be the thing that reports a
      // hang: Stryker abandons the mutant first, and the verdict becomes `Timeout` —
      // "the runner gave up" — which is a verdict nobody made. The comparison is
      // static, so it cannot rot with the machine it runs on; the *derivation* of the
      // number is a measurement, recorded where the number is.
      // Anchored to the start of a line, because the value is usually explained in a
      // comment that quotes the number it replaced — and a gate that reads prose is a
      // gate that argues with documentation.
      const testTimeout = /^\s*testTimeout:\s*([\d_]+)/m.exec(text);
      const hookTimeout = /^\s*hookTimeout:\s*([\d_]+)/m.exec(text);
      const cap = shared?.timeoutMS;
      if (typeof cap === "number") {
        // Inheriting is how the operations target ended up with a 60 s test timeout
        // under a 30 s cap: the value came from the unit suite, where it is chosen for
        // a different job, so nothing could ever expire before the runner gave up.
        for (const [name, match] of [
          ["testTimeout", testTimeout],
          ["hookTimeout", hookTimeout],
        ]) {
          if (!match) {
            failures.push(
              `mutation target "${target}": ${testConfig} does not declare ${name} — it would inherit the unit suite's, which is above the runner's ${cap}ms cap and therefore never fires`,
            );
            continue;
          }
          const value = Number(match[1].replaceAll("_", ""));
          if (value >= cap) {
            failures.push(
              `mutation target "${target}": ${testConfig} sets ${name} ${value}ms, at or above the runner's ${cap}ms cap — a hang would be recorded as an abandoned mutant rather than as a failing test`,
            );
          }
        }
      }
    }

    // The owner of a target is the package whose directory it names, and its
    // `test:mutation` has to reach the root: `pnpm -w` is the only way a script can
    // start a run where the sandbox can see `tsconfig.base.json` and `scripts/`.
    const owner = packages.find(
      (p) => relative(root, p.dir).replaceAll("\\", "/") === target,
    );
    if (!owner) {
      failures.push(
        `mutation target "${target}" names no workspace package — the target and its package directory are the same word by convention`,
      );
    } else {
      const body = owner.scripts["test:mutation"];
      if (!body) {
        failures.push(`${owner.name}: no "test:mutation" script — the gate is not runnable from its own package`);
      } else if (!body.includes(`-w run test:mutation:${target}`)) {
        failures.push(
          `${owner.name}: "test:mutation" does not delegate to "test:mutation:${target}" — a run started in the package directory gets a sandbox with no parent`,
        );
      }
    }

    const script = `test:mutation:${target}`;
    const invoked = new RegExp(
      `pnpm\\s+(?:-w\\s+|--workspace-root\\s+)?run\\s+${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    );
    if (!invoked.test(workflowText)) {
      failures.push(
        `nothing in .github/workflows runs "${script}" — a gate no workflow executes is a claim nobody checks`,
      );
    } else if (verbose) {
      notes.push(`mutation target "${target}" is invoked by a workflow`);
    }
  }

  // A package script that runs Stryker itself would put the sandbox back where it
  // cannot work. Delegation is the only shape allowed.
  for (const pkg of packages) {
    const body = pkg.scripts["test:mutation"];
    if (body && !/(-w|--workspace-root)\s+run\s+test:mutation:/.test(body)) {
      failures.push(
        `${pkg.name}: "test:mutation" runs something other than a root target ("${body}") — the sandbox is a copy of the working directory`,
      );
    }
  }

  // A target nobody can name is not a target: the table and the scripts have to agree
  // in both directions.
  for (const name of Object.keys(rootScripts)) {
    if (!name.startsWith("test:mutation:")) continue;
    const target = name.slice("test:mutation:".length);
    if (!seen.has(target)) {
      failures.push(`package.json defines "${name}" for a target that stryker.config.mjs does not declare`);
    }
  }
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
