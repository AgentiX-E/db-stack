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
 *      workflow ran, while its README quoted the score of one of them;
 *   8. a dependency patch is still applied, not just named in the manifest;
 *   9. every directory holding JavaScript has a lint target that names it.
 *      `pnpm lint` is `turbo run lint` — four packages each running `eslint .` in
 *      their own directory — so the root `scripts/` sat outside all four for
 *      dozens of iterations while a `prefer-const` shipped to CI. A gate that
 *      checks the files a lint command *would* see has to ask which directories
 *      no lint command sees at all.
 *
 * Usage: node scripts/check-gates.mjs [--verbose]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

function walk(dir, predicate) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".git" ||
      entry.name === ".stryker-tmp" ||
      entry.name === "reports"
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate));
    else if (predicate(full)) found.push(full);
  }
  return found;
}

/**
 * The path arguments of a `vitest run` command, as candidate repository paths.
 *
 * Only `vitest run` is read, and only because of one blind spot: the rule beside this
 * one checks arguments that carry a file extension, so a *directory* filter was the one
 * path a script could name that nothing verified. Flags are dropped, a trailing slash is
 * dropped, and a glob is left to vitest — this function can answer "the directory is not
 * there", which is the failure that exits 1 with nothing to report; it cannot answer
 * "this pattern matches a file".
 */
export function vitestFilterPaths(command) {
  const run = command.match(/\bvitest\s+run\b([^|;&]*)/);
  if (!run) return [];
  const tokens = run[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => token.length > 0 && !token.startsWith("-"))
    .filter((token) => token.includes("/"))
    .filter((token) => !/[*?{}[\]]/.test(token))
    .map((token) => token.replace(/\/+$/, ""))
    .filter((token) => token.length > 0);
}

/**
 * Every rule, as a function of the tree it reads.
 *
 * The rules used to run at module scope, which made the file its own only caller:
 * nothing could hand it a fixture, so every rule was asserted by pointing it at this
 * repository and reading the output. A gate that can only be run against the one tree
 * it was written for cannot say what it would do to a wrong one.
 */
export async function audit(root, options = {}) {
  const verbose = Boolean(options.verbose);
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];

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

  const rootManifest = readJson(join(root, "package.json"));

  /**
   * Rules 2–4 read the root manifest as well as the packages.
   *
   * The root is not a workspace package — `pnpm-workspace.yaml` names no `.` — and that
   * is exactly why it went unread: a root script that pointed at a file nobody had was
   * the shape of the `coverage:merge` failure this gate exists for, one layer up from
   * where the gate was looking. Rule 1 keeps its package scope, because a root tsconfig
   * is wired by being extended rather than by being run.
   */
  const scriptOwners = [
    {
      dir: root,
      name: rootManifest.name ?? "root",
      scripts: rootManifest.scripts ?? {},
    },
    ...packages,
  ];

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

  for (const pkg of scriptOwners) {
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

  // ── 4. a vitest filter that matches no file is a gate over no work ──
  //
  // `vitest run <dir>` exits 1 with "No test files found" when the directory is gone,
  // and rule 2 cannot see it: that rule reads arguments with a file extension, and a
  // directory filter has none. This is how `operations`' `test:integration` came out of
  // the three-package split still naming `packages/core/src/__tests__/e2e`: every local
  // gate was green, and the first thing to run that script was CI.
  for (const pkg of scriptOwners) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const candidate of vitestFilterPaths(command)) {
        if (!existsSync(resolve(pkg.dir, candidate))) {
          failures.push(
            `${pkg.name}: script "${name}" runs vitest over ${candidate}, which does not exist — the filter matches no file, and vitest exits 1 on that`,
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
      packages.map((p) => [
        relative(root, p.dir).replaceAll("\\", "/"),
        p.name,
      ]),
    );

    for (const file of readdirSync(workflowDir).filter((f) =>
      /\.ya?ml$/.test(f),
    )) {
      const lines = readText(resolve(workflowDir, file)).split("\n");

      for (const [index, line] of lines.entries()) {
        // Prose about a command is not a command: the workflow explains itself in
        // comments, and one of them quotes `pnpm --filter ... run build`.
        if (line.trimStart().startsWith("#")) continue;
        // `pnpm --filter <target> run <script>` sets the target for this line only.
        const filtered = line.match(
          /pnpm\s+--filter\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+run\s+([\w:.-]+)/,
        );
        if (filtered) {
          const filter = filtered[1] ?? filtered[2] ?? filtered[3];
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
    }
  }

  function resolveFilter(filter, all, dirToName, byName) {
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
      failures.push(
        `mutation/targets.mjs cannot be imported: ${error.message}`,
      );
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
      failures.push(
        "scripts/mutation.mjs is missing — nothing anchors the run to the repository root",
      );
    }
    // The working-directory refusal used to be matched here as the literal text
    // `resolve(process.cwd()) !== repositoryRoot`. It was a proxy, and it rotted the
    // moment the runner grew an injected `cwd` so that the refusal could be tested at
    // all: the behaviour was intact, the string was not. A rule that fails when the
    // code improves is a rule nobody keeps, so the behaviour is proven by a real case
    // in `mutation.test.mjs` — a package directory is refused, the exit code is 2, and
    // the injected runner records that nothing ran.

    for (const ignored of ["reports/mutation/", ".stryker-tmp/"]) {
      if (!rootGitignore.includes(ignored)) {
        failures.push(
          `.gitignore does not ignore ${ignored} — a mutation run would stage its own output`,
        );
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
      if (mutate.length === 0)
        failures.push(`mutation target "${target}": mutates nothing`);
      for (const pattern of mutate) {
        const matches = filesMatching(root, pattern);
        if (matches.length === 0) {
          failures.push(
            `mutation target "${target}": mutate pattern "${pattern}" matches no file`,
          );
        } else if (verbose) {
          notes.push(
            `mutation target "${target}": ${matches.length} file(s) for ${pattern}`,
          );
        }
      }

      const testConfig = entry.testConfig;
      const testConfigPath =
        typeof testConfig === "string" ? resolve(root, testConfig) : "";
      if (!testConfigPath || !existsSync(testConfigPath)) {
        failures.push(
          `mutation target "${target}": testConfig "${testConfig}" does not exist`,
        );
      } else {
        const text = readText(testConfigPath);
        const includeMatch = text.match(/include:\s*\[([\s\S]*?)\]/);
        const includePatterns = includeMatch
          ? [...includeMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(
              (m) => m[1] ?? m[2],
            )
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
        // Read from the code on a line rather than from the start of a line. The
        // original anchored at `^\s*` to avoid arguing with a comment that quotes the
        // number it replaced, which also made a config that writes two settings on one
        // line look like a config that declares neither. Stripping the comment reads the
        // code and not the prose, wherever the code sits.
        const setting = (name) => {
          for (const line of text.split("\n")) {
            const code = line.split("//")[0];
            const match = new RegExp(`\\b${name}:\\s*([\\d_]+)`).exec(code);
            if (match) return Number(match[1].replaceAll("_", ""));
          }
          return undefined;
        };
        const testTimeout = setting("testTimeout");
        const hookTimeout = setting("hookTimeout");
        const cap = shared?.timeoutMS;
        if (typeof cap === "number") {
          // Inheriting is how the operations target ended up with a 60 s test timeout
          // under a 30 s cap: the value came from the unit suite, where it is chosen for
          // a different job, so nothing could ever expire before the runner gave up.
          for (const [name, value] of [
            ["testTimeout", testTimeout],
            ["hookTimeout", hookTimeout],
          ]) {
            if (value === undefined) {
              failures.push(
                `mutation target "${target}": ${testConfig} does not declare ${name} — it would inherit the unit suite's, which is above the runner's ${cap}ms cap and therefore never fires`,
              );
              continue;
            }
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
          failures.push(
            `${owner.name}: no "test:mutation" script — the gate is not runnable from its own package`,
          );
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
        failures.push(
          `package.json defines "${name}" for a target that stryker.config.mjs does not declare`,
        );
      }
    }
  }

  // ── 8. a dependency patch is a gate only if it is still applied ─────

  /*
   * `pnpm.patchedDependencies` in the root manifest points at a file. If that file is
   * renamed, emptied or dropped from the lockfile, every install quietly reverts to
   * the upstream behaviour the patch exists to correct — and the only thing that
   * noticed would be the acceptance case that depends on it, on whichever runner runs
   * it first. This is the same failure the orphan-tsconfig check exists for, one layer
   * out: a configuration that promises something no longer true.
   */
  for (const [dependency, patchPath] of Object.entries(
    rootManifest.pnpm?.patchedDependencies ?? {},
  )) {
    if (!existsSync(join(root, patchPath))) {
      failures.push(
        `patchedDependencies names "${dependency}" but ${patchPath} does not exist`,
      );
      continue;
    }
    const body = readText(join(root, patchPath));
    if (!body.includes("PATCH(db-stack)")) {
      failures.push(
        `${patchPath} carries no PATCH(db-stack) marker, so it does not say why it exists`,
      );
    }
    const lock = readText(join(root, "pnpm-lock.yaml"));
    if (!lock.includes(patchPath)) {
      failures.push(
        `${patchPath} is not referenced by pnpm-lock.yaml, so --frozen-lockfile would not apply it`,
      );
    }
    notes.push(`patch ${dependency} -> ${patchPath}`);
  }

  // ── 9. every directory holding JavaScript has a lint target ────────
  //
  // `pnpm lint` is `turbo run lint`: each package runs `eslint .` from its own
  // directory. Everything at the root is outside all of them. Checking what a lint
  // command *would* find cannot see that hole — it is the absence of a command, not
  // a finding inside one — so this rule reads the directory names from the manifests
  // and compares them with the directories that actually hold script files.
  //
  // Only a trailing slash (or `.`) counts as a directory target: `--config
  // eslint.shared.mjs` is a file argument to the same command and must not make the
  // directory it lives in look linted.
  /** @type {Set<string>} */
  const linted = new Set();
  for (const owner of scriptOwners) {
    for (const [name, command] of Object.entries(owner.scripts)) {
      if (!/^lint(?::|$)/.test(name)) continue;
      const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      for (const token of tokens.slice(1)) {
        const clean = token.replace(/^["']|["']$/g, "");
        if (clean === ".") {
          linted.add(relative(root, owner.dir).replaceAll("\\", "/") || ".");
        } else if (clean.endsWith("/")) {
          linted.add(
            relative(root, resolve(owner.dir, clean)).replaceAll("\\", "/"),
          );
        }
      }
    }
  }

  /** @type {Map<string, number>} */
  const scriptCounts = new Map();
  for (const file of walk(root, (path) => /\.(?:mjs|cjs|js)$/.test(path))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    // A script at the root is a file, not a directory, and the rule is about the
    // directories that fall between packages and the files they lint.
    if (!rel.includes("/")) continue;
    const dir = rel.split("/")[0];
    scriptCounts.set(dir, (scriptCounts.get(dir) ?? 0) + 1);
  }
  for (const [dir, count] of [...scriptCounts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (linted.has(dir)) {
      if (verbose) notes.push(`${dir}/ is covered by a lint script`);
      continue;
    }
    failures.push(
      `${dir}/: ${count} script file(s) but no lint script names the directory — ` +
        "the files in it have never been linted",
    );
  }
  // A local target that CI does not run is still a claim nobody checks. The same
  // rule is already applied to mutation targets; the lint target over the root is
  // no different, and this is the line that was absent for the whole time the
  // directory went unlinted.
  if (!/pnpm\s+lint:root\b/.test(workflowText)) {
    failures.push(
      'nothing in .github/workflows runs "pnpm lint:root" — a lint target no workflow executes is a claim nobody checks',
    );
  }

  return { failures, notes, packages, turboTasks };
}

/**
 * What the gate has to say, and the exit code that says it.
 *
 * The sinks are parameters for the same reason they are in `check-script-coverage`:
 * a default of `console.log` is a branch only the command line reaches, and it is the
 * branch a reader is most likely to change.
 */
export function report({ failures, notes, packages, turboTasks }, options) {
  const { log, error } = options;

  if (options.verbose) for (const note of notes) log(`ok   ${note}`);

  if (failures.length) {
    error(`check-gates: ${failures.length} structural problem(s)`);
    for (const failure of failures) error(`  ✗ ${failure}`);
    return 1;
  }

  log(
    `check-gates: ${packages.length} packages, ${turboTasks.size} turbo tasks — every gate is wired`,
  );
  return 0;
}

export async function run(root = ROOT, options) {
  return report(await audit(root, options), options);
}

/** Whether this module was started as the program. */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

if (isEntryPoint(process.argv[1])) {
  // `audit` awaits a dynamic import, so the exit code has to be awaited too.
  run(ROOT, {
    log: console.log,
    error: console.error,
    verbose: process.argv.includes("--verbose"),
  }).then((code) => process.exit(code));
}
