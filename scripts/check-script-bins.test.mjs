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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  commandSegments,
  commandWord,
  isResolvable,
  installedBinaries,
  missingBinaries,
  run,
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
  assert.ok(dirs.includes("node"), `expected node in ${dirs.join(", ")}`);
});

test("installedBinaries unions the .bin directories of the root and every package", () => {
  const root = mkdtempSync(join(tmpdir(), "script-bins-"));
  try {
    const install = (dir, names) => {
      mkdirSync(join(root, dir, "node_modules", ".bin"), { recursive: true });
      for (const name of names)
        writeFileSync(join(root, dir, "node_modules", ".bin", name), "");
    };
    install(".", ["turbo"]);
    install("cluster", ["vitest"]);
    // A package with no node_modules contributes nothing rather than failing.
    mkdirSync(join(root, "federation"), { recursive: true });

    const bins = installedBinaries(root, ["cluster", "federation"]);

    assert.deepEqual([...bins].sort(), ["turbo", "vitest"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run passes and reports how many manifests it read", () => {
  const lines = [];
  const code = run(ROOT, {
    binaries: new Set([
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
    ]),
    log: (line) => lines.push(line),
  });

  assert.equal(code, 0);
  assert.match(
    lines[0],
    /✓ script-bins: every script command is installed \(\d+ manifests\)/,
  );
});

test("run fails, naming the package, the script and the binary", () => {
  const root = mkdtempSync(join(tmpdir(), "script-bins-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", scripts: { docs: "typedoc --out docs" } }),
    );
    const errors = [];
    const code = run(root, {
      binaries: new Set(),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.match(errors[0], /✗ script-bins: 1 script\(s\) cannot run/);
    assert.match(
      errors[1],
      /\.: "docs" runs `typedoc`, which is not installed/,
    );
    assert.match(
      errors[2],
      /A script nothing can execute is a promise that fails at the first use/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command line exits 0 on this workspace", () => {
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-script-bins.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0);
  assert.match(child.stdout, /every script command is installed/);
});

test("workspaceDirs keeps the four trees, and only those that carry a manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "script-bins-"));
  try {
    // Four trees, one level. `operations/packages/*` used to need a second pass;
    // the packages moved to the top level, so a scan for a nested tree is gone
    // rather than kept as a branch that can never run.
    mkdirSync(join(root, "cluster"), { recursive: true });
    writeFileSync(join(root, "cluster", "package.json"), "{}");
    mkdirSync(join(root, "federation"), { recursive: true });
    mkdirSync(join(root, "node"), { recursive: true });

    // `node` and `federation` exist as directories but carry no manifest yet, so
    // neither is a package the gate can read scripts from.
    assert.deepEqual(workspaceDirs(root), ["cluster"]);

    writeFileSync(join(root, "node", "package.json"), "{}");
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, "e2e", "package.json"), "{}");

    assert.deepEqual(workspaceDirs(root), ["node", "cluster", "e2e"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a segment that is not a command yields no word; a pipe yields its reader", () => {
  // An empty segment is the only case with no word at all. A leading pipe is
  // impossible in a manifest that runs (`a | head` reads as `a`), but reading
  // `head` out of it is better than reading the pipe.
  assert.equal(commandWord("   "), "");
  assert.equal(commandWord("| head -5"), "head");
});

test("a word the shell expands is left to the shell", () => {
  assert.equal(isResolvable("$HOME/bin/gate", new Set()), true);
  assert.equal(isResolvable("*.mjs", new Set()), true);
  assert.equal(isResolvable("", new Set()), true);
  assert.equal(isResolvable("vitest", new Set(["vitest"])), true);
  assert.equal(isResolvable("vitest", new Set()), false);
});

test("a manifest with no scripts has nothing to check", () => {
  const root = mkdtempSync(join(tmpdir(), "script-bins-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));

    assert.deepEqual(missingBinaries(root, new Set()), {
      missing: [],
      scanned: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fallback chain splits like an and-chain", () => {
  assert.deepEqual(commandSegments("pnpm a || pnpm b"), ["pnpm a", "pnpm b"]);
});
