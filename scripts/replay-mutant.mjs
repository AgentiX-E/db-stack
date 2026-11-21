#!/usr/bin/env node
/**
 * Replay a mutant from a Stryker report.
 *
 * Why this exists: the JSON report is the only place that records *which* edit
 * Stryker made — the exact character range and the exact replacement text. A
 * line number is not enough. Iteration 30 claimed five verdicts were wrong by
 * re-typing the change by hand at the line the report named, and every one of
 * those claims was about a different edit than the one Stryker had made: the
 * file had moved two lines since the report was written, so the "survivor" being
 * discussed was `(x || 0) → false` while the change that was applied by hand was
 * `if (!x) → if (false)` three lines below it. The conclusion drawn from that
 * ("the runner disagrees with the suite") was wrong for exactly that reason.
 *
 * Usage:
 *   node scripts/replay-mutant.mjs list [--report <path>] [--status <filter>]
 *   node scripts/replay-mutant.mjs apply <index> [--report <path>] [--status <filter>] [--allow-stale]
 *   node scripts/replay-mutant.mjs restore
 *
 * `--status` takes a comma-separated list, `*` for every mutant, or `pending`
 * for the four statuses that no verdict has been given to yet. `pending` exists
 * because the interesting question is never "which mutants survived" but "which
 * mutants has nobody read": a time-out and a runtime error are both *unanswered*
 * — the runner gave up, no test passed — and reading only `Survived` quietly
 * skips them. The filter is the same for `list` and `apply`, so an index printed
 * by one always names the mutant the other acts on.
 *
 * `apply` copies the file to `<file>.replay.bak` and splices the replacement into
 * the recorded range. Run the tests, then `restore`. Nothing here guesses: if the
 * recorded range does not hold the text the mutator claims to replace, it says so
 * and changes nothing.
 *
 * **Paths are anchored to the repository root, not to the working directory.**
 * Until iteration 36 the default report was `reports/mutation/operations.json`,
 * resolved against whatever directory the script was started in — which was
 * `operations/`, because that is where this script lives. Since the mutation run
 * moved to the root (P3-4) the report it produces is at `<root>/reports/…` and
 * the paths inside it are root-relative, so from `operations/` the tool silently
 * read a stale report left behind by the last in-place run and then verified
 * mutants from a file that had changed since. A tool that answers the wrong
 * question is worse than one that fails, so both the report and every path it
 * contains are now resolved against the repository root, and `apply` refuses a
 * report older than the file it describes.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { replaceFile, splice } from "./lib/mutant-edit.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_REPORT = path.join(REPOSITORY_ROOT, "reports/mutation/node.json");
const BACKUP_SUFFIX = ".replay.bak";
const META_SUFFIX = ".replay.json";

/**
 * Statuses that mean "no test decided this": the runner either let the mutant
 * run and saw nothing, gave up on it, crashed on it, or never reached it.
 * They are one concept — an unread verdict — and are named as one, because the
 * audit this script exists for treats all four the same way.
 */
const PENDING_STATUSES = ["Survived", "Timeout", "RuntimeError", "NoCoverage"];

export function statusFilter(spec) {
  if (spec === "*") return () => true;
  if (spec === "pending") return (status) => PENDING_STATUSES.includes(status);
  const wanted = new Set(
    spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (status) => wanted.has(status);
}

export function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "list",
    index: null,
    report: DEFAULT_REPORT,
    status: "Survived",
    allowStale: false,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--report")
      args.report = path.resolve(REPOSITORY_ROOT, rest[++i]);
    else if (token === "--status") args.status = rest[++i];
    else if (token === "--allow-stale") args.allowStale = true;
    else if (/^\d+$/.test(token)) args.index = Number(token);
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

export function loadSurvivors(reportPath, status) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const accepts = statusFilter(status);
  const rows = [];
  for (const [file, info] of Object.entries(report.files ?? {})) {
    for (const mutant of info.mutants ?? []) {
      if (!accepts(mutant.status)) continue;
      rows.push({ file, mutant });
    }
  }
  rows.sort((a, b) =>
    a.file === b.file
      ? a.mutant.location.start.line - b.mutant.location.start.line
      : a.file.localeCompare(b.file),
  );
  return rows;
}

/**
 * The report's positions are 1-based in both axes (line 1 is the first line,
 * column 1 the first character). Turning one into an offset used to live here;
 * it moved to `lib/mutant-edit.mjs` so that the one-character shift it exists to
 * prevent cannot be reintroduced in a second copy.
 */

export function printList(rows) {
  if (rows.length === 0) {
    console.log("no mutants with that status");
    return;
  }
  rows.forEach(({ file, mutant }, index) => {
    const { start, end } = mutant.location;
    const replacement = JSON.stringify(mutant.replacement ?? "").slice(0, 58);
    // The status is printed because a filter can select several of them, and
    // "which of these did the runner actually run" is the first thing the
    // reader needs in order to decide what a surviving verdict means.
    console.log(
      `${String(index).padStart(3)} ${mutant.status.slice(0, 4).padEnd(4)} ` +
        `${file.split("/").slice(-1)[0]}:${start.line}:${start.column}-${end.line}:${end.column} ` +
        `${mutant.mutatorName} → ${replacement}`,
    );
  });
}

/** Milliseconds since the epoch for a path that must exist. */
function mtimeOf(file) {
  return fs.statSync(file).mtimeMs;
}

export function apply(rows, index, options, root = REPOSITORY_ROOT) {
  const row = rows[index];
  if (!row) throw new Error(`no mutant at index ${index}`);

  const absPath = path.resolve(root, row.file);
  const stale = mtimeOf(options.report) < mtimeOf(absPath);
  if (stale && !options.allowStale) {
    throw new Error(
      [
        `${options.report} is older than ${row.file}.`,
        "  Its line and column ranges describe a file that has changed since, so a",
        "  splice at those offsets would verify a different edit than the one it names.",
        "  Re-run the mutation target, or pass --allow-stale if the change was formatting.",
      ].join("\n"),
    );
  }
  if (stale) {
    console.warn(
      `warning: ${options.report} is older than ${row.file}; replaying anyway because --allow-stale was passed`,
    );
  }

  const text = fs.readFileSync(absPath, "utf-8");
  const { removed, replacement, updated } = splice(text, row.mutant);

  // The mtime is part of what `restore` has to put back. Writing the file twice
  // per replay moves it forward, and the guard above reads it — a tool that
  // refuses its own second replay because *it* touched the file would be right
  // about the rule and useless in practice.
  replaceFile(absPath, updated);

  console.log(`${row.file}:${row.mutant.location.start.line}`);
  console.log(`- ${removed.replace(/\n/g, "\\n")}`);
  console.log(`+ ${replacement.replace(/\n/g, "\\n")}`);
  console.log(
    `applied; run the tests, then \`node scripts/replay-mutant.mjs restore\``,
  );
}

export function restore(root = REPOSITORY_ROOT) {
  let restored = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".stryker-tmp"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(BACKUP_SUFFIX)) {
        const target = full.slice(0, -BACKUP_SUFFIX.length);
        fs.renameSync(full, target);
        const meta = target + META_SUFFIX;
        if (fs.existsSync(meta)) {
          const { mtimeMs } = JSON.parse(fs.readFileSync(meta, "utf-8"));
          fs.utimesSync(target, new Date(), new Date(mtimeMs));
          fs.unlinkSync(meta);
        }
        restored += 1;
      } else if (entry.name.endsWith(META_SUFFIX) && fs.existsSync(full)) {
        // An orphan from an interrupted replay. The check is not defensive
        // noise: `readdirSync` snapshots the directory, so the companion of a
        // `.replay.bak` is still listed here after its owner has removed it.
        fs.unlinkSync(full);
      }
    }
  };
  walk(root);
  console.log(`restored ${restored} file(s)`);
}

/**
 * Run only when this file is the program, not when a test imports it.
 *
 * Without this guard, importing the module read `process.argv`, parsed whatever
 * the test runner had been given, and dispatched a command — the same defect
 * `check-package.mjs` carried until its debt was paid. `root` is a parameter for
 * the same reason: a test needs to point `apply` at a temp directory rather than
 * at this repository's source tree.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "restore") {
    restore();
  } else {
    const rows = loadSurvivors(args.report, args.status);
    if (args.command === "list") printList(rows);
    else if (args.command === "apply") apply(rows, args.index, args);
    else throw new Error(`unknown command: ${args.command}`);
  }
}
