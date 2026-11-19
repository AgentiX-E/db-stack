/**
 * Tests for the script-binary gate.
 *
 * The gate exists because three packages shipped `"docs": "typedoc"` with no
 * TypeDoc installed. Its job is to read a script the way a shell would before
 * the shell does, so the parsing is what needs pinning: environment prefixes
 * that are not the command, chained commands where only the first word counts,
 * and paths the workspace resolves itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  commandSegments,
  commandWord,
  isResolvable,
  missingBinaries,
  workspaceDirs,
} from "./check-script-bins.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("splits a chain into its commands", () => {
  assert.deepEqual(commandSegments("tsc -p x.json && node y.mjs"), [
    "tsc -p x.json",
    "node y.mjs",
  ]);
  assert.deepEqual(commandSegments("a ; b || c"), ["a", "b", "c"]);
});

test("reads the command word, not the arguments", () => {
  assert.equal(commandWord("tsc -p tsconfig.build.json --noEmit"), "tsc");
  assert.equal(commandWord("vitest run --coverage"), "vitest");
});

test("skips environment assignments in front of the command", () => {
  assert.equal(commandWord("NODE_OPTIONS=--expose-gc vitest run"), "vitest");
  assert.equal(commandWord("FOO=1 BAR=2 node x.mjs"), "node");
});

test("treats a bare binary name as resolvable only when installed", () => {
  assert.equal(isResolvable("typedoc", new Set()), false);
  assert.equal(isResolvable("typedoc", new Set(["typedoc"])), true);
  assert.equal(isResolvable("node", new Set()), true);
  assert.equal(isResolvable("pnpm", new Set()), true);
});

test("leaves paths alone: the shell resolves them", () => {
  assert.equal(isResolvable("../node_modules/.bin/tsc", new Set()), true);
  assert.equal(isResolvable("tla/tla-check.sh", new Set()), true);
  assert.equal(isResolvable("$PNPM_HOME/tool", new Set()), true);
});

test("reports the script that calls the missing binary", () => {
  const { missing } = missingBinaries(ROOT, new Set(["tsc", "node"]));
  assert.ok(
    missing.length > 0,
    "with an empty .bin every real script is missing something",
  );
  assert.ok(
    missing.every(
      (entry) => typeof entry.word === "string" && entry.word.length > 0,
    ),
  );
});

test("accepts the workspace's own scripts when every binary is present", () => {
  // The names the workspace's scripts actually call, including the ones that
  // only a package-level install provides (`knip`, `pino`) and the root-only
  // `turbo` — the gate has to look in every `node_modules/.bin`, not just one.
  const bins = new Set([
    "tsc",
    "vitest",
    "eslint",
    "prettier",
    "knip",
    "tsx",
    "stryker",
    "turbo",
    "pino",
    "download-lmdb-prebuilds",
    "typedoc",
  ]);
  const { missing } = missingBinaries(ROOT, bins);
  assert.deepEqual(
    missing,
    [],
    `unexpected: ${missing.map((m) => `${m.dir}:${m.script}`).join(", ")}`,
  );
});

test("scans more than one manifest", () => {
  const dirs = workspaceDirs(ROOT);
  assert.ok(dirs.includes("cluster"));
  assert.ok(dirs.includes("federation"));
  assert.ok(dirs.some((dir) => dir.startsWith("operations/packages/")));
});
