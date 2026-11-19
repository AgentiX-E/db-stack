#!/usr/bin/env node
/**
 * Run the mutation gate for one package — from the repository root, in a sandbox.
 *
 * This script exists for one assertion: **the working directory must be the
 * repository root**. Stryker copies `process.cwd()` into its sandbox and runs the
 * tests there, so invoking it from `operations/` produces a sandbox that is a
 * copy of `operations/` — which has no parent, and therefore neither
 * `tsconfig.base.json` (which `operations/tsconfig.json` extends, and which Vite
 * reads while transforming) nor `scripts/test-tmpdir.mjs` (which every
 * `vitest.setup.ts` imports). The run then dies in the initial test phase with a
 * `TSConfckParseError` that says nothing about the real mistake, which is why the
 * previous revision worked around it by mutating in place.
 *
 * A checker that only documents a constraint is a comment. This one refuses.
 *
 * The refusal is a returned code and a sentence, not a `process.exit()` in the
 * middle of the module, so a test can assert both without starting Stryker.
 *
 * Usage:
 *   node scripts/mutation.mjs <cluster|federation|operations|all> [stryker args]
 *
 * Extra arguments are forwarded to Stryker, which is what makes a targeted run
 * possible: `node scripts/mutation.mjs operations --mutate "...:740-760"`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TARGETS } from "../mutation/targets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * The Stryker entry point, resolved rather than reached through a shell, so this
 * works on every platform.
 */
export function strykerBin(requireFn = createRequire(import.meta.url)) {
  return resolve(
    dirname(requireFn.resolve("@stryker-mutator/core/package.json")),
    "bin/stryker.js",
  );
}

/** The exit code of one Stryker run. */
export function runOne(target, forwarded, options = {}) {
  const spawnFn = options.spawn ?? spawn;
  const error = options.error ?? console.error;

  return new Promise((settle) => {
    const child = spawnFn(
      options.execPath ?? process.execPath,
      [options.bin ?? strykerBin(), "run", ...forwarded],
      {
        cwd: options.cwd ?? repositoryRoot,
        env: { ...(options.env ?? process.env), MUTATION_TARGET: target },
        stdio: "inherit",
      },
    );
    child.on("close", (code, signal) => {
      if (signal) {
        error(`mutation: ${target} was killed by ${signal}`);
        settle(1);
      } else {
        settle(code ?? 1);
      }
    });
    child.on("error", (cause) => {
      error(`mutation: could not start the ${target} run — ${cause.message}`);
      settle(1);
    });
  });
}

/**
 * The command line as a function: which targets to run, from where, and what to
 * report when the answer is "not like this".
 */
export function isEntryPoint(entry, moduleUrl = import.meta.url) {
  return entry ? moduleUrl === pathToFileURL(entry).href : false;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const error = options.error ?? console.error;
  const targets = options.targets ?? TARGETS;
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? repositoryRoot;
  const [requested, ...forwarded] = argv;
  const names = Object.keys(targets);

  if (!requested || !(requested === "all" || requested in targets)) {
    error(
      `mutation: expected one of ${[...names, "all"].join(", ")}, received ${requested ?? "nothing"}`,
    );
    return 2;
  }

  if (resolve(cwd) !== root) {
    error(
      [
        `mutation: run this from the repository root, not from ${cwd}.`,
        "  Stryker copies the working directory into its sandbox; run from a package",
        "  directory and the copy has no parent, so the tsconfig it extends and the",
        "  test helper the setup files import are both missing.",
        `  From the root: pnpm run test:mutation:${requested === "all" ? "<target>" : requested}`,
      ].join("\n"),
    );
    return 2;
  }

  // `all` stops at the first failure: a gate that reports three scores and exits 0
  // because the last one passed is not a gate.
  const queue = requested === "all" ? names : [requested];
  // The default runner is `runOne` with the *caller's* options, so it is reachable
  // from a test that injects `spawn` and `bin` — a default nobody can reach is a
  // default nobody has measured.
  const run = options.run ?? ((target) => runOne(target, forwarded, options));
  for (const target of queue) {
    const code = await run(target);
    if (code !== 0) return code;
  }
  return 0;
}

if (isEntryPoint(process.argv[1])) {
  main().then((code) => process.exit(code));
}
