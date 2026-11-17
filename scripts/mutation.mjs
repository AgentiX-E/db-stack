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
 * Usage:
 *   node scripts/mutation.mjs <cluster|federation|operations|all> [stryker args]
 *
 * Extra arguments are forwarded to Stryker, which is what makes a targeted run
 * possible: `node scripts/mutation.mjs operations --mutate "...:740-760"`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { TARGETS } from "../mutation/targets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const [requested, ...forwarded] = process.argv.slice(2);
const names = Object.keys(TARGETS);

if (!requested || !(requested === "all" || requested in TARGETS)) {
  console.error(
    `mutation: expected one of ${[...names, "all"].join(", ")}, received ${requested ?? "nothing"}`,
  );
  process.exit(2);
}

if (resolve(process.cwd()) !== repositoryRoot) {
  console.error(
    [
      `mutation: run this from the repository root, not from ${process.cwd()}.`,
      "  Stryker copies the working directory into its sandbox; run from a package",
      "  directory and the copy has no parent, so the tsconfig it extends and the",
      "  test helper the setup files import are both missing.",
      `  From the root: pnpm run test:mutation:${requested === "all" ? "<target>" : requested}`,
    ].join("\n"),
  );
  process.exit(2);
}

/** Resolved rather than spawned through a shell, so this works on every platform. */
const strykerBin = resolve(
  dirname(require.resolve("@stryker-mutator/core/package.json")),
  "bin/stryker.js",
);

/** The exit code of one Stryker run. */
function run(target) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [strykerBin, "run", ...forwarded], {
      cwd: repositoryRoot,
      env: { ...process.env, MUTATION_TARGET: target },
      stdio: "inherit",
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`mutation: ${target} was killed by ${signal}`);
        resolveRun(1);
      } else {
        resolveRun(code ?? 1);
      }
    });
    child.on("error", (error) => {
      console.error(
        `mutation: could not start the ${target} run — ${error.message}`,
      );
      resolveRun(1);
    });
  });
}

// `all` stops at the first failure: a gate that reports three scores and exits 0
// because the last one passed is not a gate.
const targets = requested === "all" ? names : [requested];
for (const target of targets) {
  const code = await run(target);
  if (code !== 0) process.exit(code);
}
