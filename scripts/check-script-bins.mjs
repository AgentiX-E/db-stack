#!/usr/bin/env node
/**
 * check-script-bins — every script must invoke a binary that exists.
 *
 * All three packages carried `"docs": "typedoc"` and none of them depended on
 * TypeDoc. The script was written when the generated-reference path was planned,
 * the plan changed, and the script stayed: `pnpm --filter @agentix-e/db-federation
 * docs` exited `sh: 1: typedoc: not found`, and the two API reference pages told
 * readers to run exactly that command. A script that cannot run is worse than a
 * missing one — it is a documented capability that fails at the first use, and
 * nothing in CI executes it, so it can stay broken for releases.
 *
 * `pnpm check:gates` already refuses a tsconfig no script references; this is the
 * same question asked about the other end of the script: a command nothing
 * provides. Both belong in the same class — configuration that looks executable
 * and is not.
 *
 * Usage: node scripts/check-script-bins.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Commands the shell or the Node toolchain provides, so no dependency has to.
 *
 * Kept deliberately small: every entry here is a command that works on a runner
 * with nothing installed, and adding one is how this gate would start lying.
 */
const SHELL_BUILTINS = new Set([
  "node",
  "pnpm",
  "npx",
  "npm",
  "bash",
  "sh",
  "cd",
  "echo",
  "exit",
  "export",
  "false",
  "for",
  "if",
  "kill",
  "mkdir",
  "rm",
  "set",
  "sleep",
  "test",
  "true",
  "wait",
  "while",
]);

/** Split a script into the individual commands it chains. */
export function commandSegments(script) {
  return String(script)
    .split(/&&|;|\|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * The command word of a segment, ignoring environment assignments in front.
 *
 * `NODE_OPTIONS=--expose-gc vitest run` runs `vitest`; `FOO=1 BAR=2 node x.mjs`
 * runs `node`. Both spellings appear in this workspace, and reading the
 * assignment as the command would report every one of them as missing.
 */
export function commandWord(segment) {
  let rest = segment.trim();
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (!assignment) break;
    rest = rest.slice(assignment[0].length);
  }
  const token = rest.split(/[\s|&<>()]+/).filter(Boolean)[0];
  return token ?? "";
}

/**
 * True when the word names something the workspace can run.
 *
 * A path (`node ../scripts/x.mjs`, `bash tla/tla-check.sh`) is resolved by the
 * shell, not by `node_modules`, so it is not this gate's business.
 */
export function isResolvable(word, bins) {
  if (!word) return true;
  if (word.includes("/") || word.includes("$") || word.includes("*"))
    return true;
  if (SHELL_BUILTINS.has(word)) return true;
  return bins.has(word);
}

/** Every package directory that carries a package.json. */
export function workspaceDirs(root = ROOT) {
  // Four packages, one level: `node`, `cluster`, `federation`, `e2e`. A nested
  // `operations/packages/*` tree used to need a second pass; there is no such
  // tree any more, and a scan for one that cannot exist is a scan that silently
  // reports nothing rather than failing.
  const dirs = ["node", "cluster", "federation", "e2e"];
  return dirs.filter((dir) => existsSync(join(root, dir, "package.json")));
}

export function installedBinaries(root, dirs) {
  const bins = new Set();
  for (const dir of [".", ...dirs]) {
    const binDir = join(root, dir, "node_modules", ".bin");
    if (!existsSync(binDir)) continue;
    for (const entry of readdirSync(binDir)) bins.add(entry);
  }
  return bins;
}

/**
 * Scripts that invoke a command nothing provides.
 *
 * `binaries` defaults to what is installed under the workspace's `node_modules`;
 * it is a parameter so the rule can be tested without installing anything.
 */
export function missingBinaries(root = ROOT, binaries) {
  const dirs = workspaceDirs(root);
  const bins = binaries ?? installedBinaries(root, dirs);
  const missing = [];
  for (const dir of [".", ...dirs]) {
    const manifest = JSON.parse(
      readFileSync(join(root, dir, "package.json"), "utf8"),
    );
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      for (const segment of commandSegments(script)) {
        const word = commandWord(segment);
        if (!isResolvable(word, bins))
          missing.push({ dir, script: name, word });
      }
    }
  }
  return { missing, scanned: dirs.length + 1 };
}

/**
 * Print the verdict and return the exit code.
 *
 * The streams are parameters so the failure branch — the one a green run never
 * shows — is asserted rather than assumed.
 */
export function run(root = ROOT, options = {}) {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const { missing, scanned } = missingBinaries(root, options.binaries);

  if (missing.length > 0) {
    error(`\n✗ script-bins: ${missing.length} script(s) cannot run\n`);
    for (const entry of missing) {
      error(
        `  ${entry.dir}: "${entry.script}" runs \`${entry.word}\`, which is not installed`,
      );
    }
    error(
      "\nA script nothing can execute is a promise that fails at the first use. " +
        "Install what it calls, or delete the script.\n",
    );
    return 1;
  }
  log(
    `✓ script-bins: every script command is installed (${scanned} manifests)`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run());
}
