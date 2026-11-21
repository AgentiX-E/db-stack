/**
 * Tests for the mutant replayer.
 *
 * `replay-mutant.mjs` writes into the source tree, so the two things that can go
 * wrong quietly are the two things every case here pins: that a report is only
 * applied when its positions still describe the file (`apply` refuses a stale
 * report), and that the bytes — plus the mtime — come back exactly as they were
 * (`restore`). A replayer that restored the bytes but not the mtime would make its
 * own freshness check fail on the next run, which is the failure mode the tool was
 * written to prevent one layer up.
 *
 * Every case runs against a temporary root. `apply` and `restore` take `root` for
 * exactly this reason: a test that pointed them at this repository would edit this
 * repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  apply,
  dispatch,
  isEntryPoint,
  loadSurvivors,
  printList,
  parseArgs,
  restore,
  statusFilter,
} from "./replay-mutant.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const fixture = () => mkdtempSync(join(tmpdir(), "replay-mutant-"));

const mutantAt = (
  line,
  replacement,
  status = "Survived",
  name = "Arithmetic",
) => ({
  id: `m-${line}`,
  mutatorName: name,
  status,
  replacement,
  location: {
    start: { line, column: 11 },
    end: { line, column: 12 },
  },
});

const writeReport = (dir, files) => {
  const report = join(dir, "report.json");
  writeFileSync(report, `${JSON.stringify({ files }, null, 2)}\n`);
  return report;
};

/** A source file plus a report that points at its second line. */
const sourceTree = () => {
  const root = fixture();
  mkdirSync(join(root, "src"), { recursive: true });
  const source = join(root, "src", "sample.ts");
  writeFileSync(source, "const a = 1;\nconst b = 2;\n");
  const longAgo = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(source, longAgo, longAgo);
  const report = writeReport(root, {
    "src/sample.ts": { mutants: [mutantAt(2, "3")] },
  });
  return { root, source, report };
};

test("statusFilter accepts every status when the spec is a star", () => {
  const accepts = statusFilter("*");
  for (const status of ["Killed", "Survived", "Timeout", "RuntimeError"])
    assert.equal(accepts(status), true, status);
});

test("statusFilter treats the four unread verdicts as pending", () => {
  const accepts = statusFilter("pending");
  for (const status of ["Survived", "Timeout", "RuntimeError", "NoCoverage"])
    assert.equal(accepts(status), true, status);
  for (const status of ["Killed", "CompileError", "Ignored"])
    assert.equal(accepts(status), false, status);
});

test("statusFilter reads a comma-separated list and trims it", () => {
  const accepts = statusFilter(" Survived , Timeout ");
  assert.deepEqual(
    ["Survived", "Timeout", "Killed"].filter((status) => accepts(status)),
    ["Survived", "Timeout"],
  );
});

test("parseArgs defaults to listing survivors of the node report", () => {
  const args = parseArgs([]);
  assert.equal(args.command, "list");
  assert.equal(args.index, null);
  assert.equal(args.status, "Survived");
  assert.equal(args.allowStale, false);
  assert.equal(args.report, join(ROOT, "reports/mutation/node.json"));
});

test("parseArgs reads the index and the flags around it", () => {
  const args = parseArgs([
    "apply",
    "7",
    "--status",
    "pending",
    "--allow-stale",
  ]);
  assert.equal(args.command, "apply");
  assert.equal(args.index, 7);
  assert.equal(args.status, "pending");
  assert.equal(args.allowStale, true);
});

test("parseArgs resolves a report against this repository", () => {
  const args = parseArgs(["list", "--report", "reports/mutation/cluster.json"]);
  assert.equal(args.report, join(ROOT, "reports/mutation/cluster.json"));
});

test("parseArgs rejects an argument it does not know", () => {
  assert.throws(() => parseArgs(["list", "--nonsense"]), /unknown argument/);
});

test("loadSurvivors keeps only the requested statuses, sorted by file and line", () => {
  const root = fixture();
  const report = writeReport(root, {
    "src/b.ts": {
      mutants: [
        mutantAt(30, "1"),
        mutantAt(4, "1", "Killed"),
        mutantAt(9, "1"),
      ],
    },
    "src/a.ts": { mutants: [mutantAt(12, "1", "Timeout")] },
  });
  const rows = loadSurvivors(report, "Survived,Timeout");
  assert.deepEqual(
    rows.map((row) => `${row.file}:${row.mutant.location.start.line}`),
    ["src/a.ts:12", "src/b.ts:9", "src/b.ts:30"],
  );
  rmSync(root, { recursive: true, force: true });
});

test("loadSurvivors answers an empty list for a report with no files", () => {
  const root = fixture();
  const report = join(root, "empty.json");
  writeFileSync(report, "{}\n");
  assert.deepEqual(loadSurvivors(report, "*"), []);
  rmSync(root, { recursive: true, force: true });
});

test("apply splices the reported replacement into the file", () => {
  const { root, source, report } = sourceTree();
  const rows = loadSurvivors(report, "Survived");
  apply(rows, 0, { report }, root);
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 3;\n");
  rmSync(root, { recursive: true, force: true });
});

test("apply leaves a backup and the original mtime beside the mutant", () => {
  const { root, source, report } = sourceTree();
  const before = statSync(source).mtimeMs;
  apply(loadSurvivors(report, "Survived"), 0, { report }, root);
  assert.equal(
    readFileSync(`${source}.replay.bak`, "utf-8"),
    "const a = 1;\nconst b = 2;\n",
  );
  assert.deepEqual(JSON.parse(readFileSync(`${source}.replay.json`, "utf-8")), {
    mtimeMs: before,
  });
  rmSync(root, { recursive: true, force: true });
});

test("apply refuses a report older than the file it describes", () => {
  const { root, source, report } = sourceTree();
  // One minute ahead of the report written above: the check is a comparison of two
  // mtimes, so the fixture has to place them on opposite sides of it rather than
  // rely on a date literal that a future clock could overtake.
  const later = new Date(Date.now() + 60_000);
  utimesSync(source, later, later);
  assert.throws(
    () => apply(loadSurvivors(report, "Survived"), 0, { report }, root),
    /is older than/,
  );
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 2;\n");
  rmSync(root, { recursive: true, force: true });
});

test("apply replays a stale report when allowStale is passed", () => {
  const { root, source, report } = sourceTree();
  const later = new Date(Date.now() + 60_000);
  utimesSync(source, later, later);
  apply(
    loadSurvivors(report, "Survived"),
    0,
    { report, allowStale: true },
    root,
  );
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 3;\n");
  rmSync(root, { recursive: true, force: true });
});

test("apply names an index that is not in the list", () => {
  const { root, report } = sourceTree();
  assert.throws(() => apply([], 4, { report }), /no mutant at index 4/);
  rmSync(root, { recursive: true, force: true });
});

test("restore puts the bytes and the mtime back", () => {
  const { root, source, report } = sourceTree();
  const before = statSync(source).mtimeMs;
  apply(loadSurvivors(report, "Survived"), 0, { report }, root);
  assert.notEqual(statSync(source).mtimeMs, before);
  restore(root);
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 2;\n");
  assert.equal(statSync(source).mtimeMs, before);
  assert.equal(existsSync(`${source}.replay.bak`), false);
  assert.equal(existsSync(`${source}.replay.json`), false);
  rmSync(root, { recursive: true, force: true });
});

test("restore walks nested directories and counts each file once", () => {
  const { root, source, report } = sourceTree();
  const nested = join(root, "src", "deep", "deeper");
  mkdirSync(nested, { recursive: true });
  const other = join(nested, "other.ts");
  writeFileSync(other, "export const x = 1;\n");
  writeFileSync(`${other}.replay.bak`, "export const x = 2;\n");
  writeFileSync(
    `${other}.replay.json`,
    `${JSON.stringify({ mtimeMs: 1_700_000_000_000 })}\n`,
  );
  apply(loadSurvivors(report, "Survived"), 0, { report }, root);
  restore(root);
  assert.equal(readFileSync(other, "utf-8"), "export const x = 2;\n");
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 2;\n");
  rmSync(root, { recursive: true, force: true });
});

test("restore removes an orphan metadata file left by an interrupted replay", () => {
  const { root, source } = sourceTree();
  const orphan = `${source}.replay.json`;
  writeFileSync(orphan, `${JSON.stringify({ mtimeMs: 1 })}\n`);
  restore(root);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(`${source}.replay.bak`), false);
  rmSync(root, { recursive: true, force: true });
});

test("restore leaves the directories a mutation run must not touch alone", () => {
  const root = fixture();
  for (const dir of ["node_modules", ".git", ".stryker-tmp"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "held.ts.replay.bak"), "kept\n");
  }
  restore(root);
  for (const dir of ["node_modules", ".git", ".stryker-tmp"])
    assert.equal(existsSync(join(root, dir, "held.ts.replay.bak")), true, dir);
  rmSync(root, { recursive: true, force: true });
});

/** Run something that prints, and hand back what it printed. */
const printed = (fn) => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
};

test("printList numbers the mutants and names the status it selected", () => {
  const lines = printed(() =>
    printList([
      { file: "node/src/a.ts", mutant: mutantAt(3, "0", "Survived") },
      { file: "node/src/b.ts", mutant: mutantAt(12, "false", "Timeout") },
    ]),
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {2}0 Surv a\.ts:3:11-3:12 Arithmetic → "0"$/);
  assert.match(lines[1], /^ {2}1 Time b\.ts:12:11-12:12 Arithmetic → "false"$/);
});

test("printList says so when the filter selected nothing", () => {
  assert.deepEqual(
    printed(() => printList([])),
    ["no mutants with that status"],
  );
});

test("the entry guard answers for this module, another file, and no file at all", () => {
  const self = resolve(ROOT, "scripts/replay-mutant.mjs");
  assert.equal(isEntryPoint(self), true);
  assert.equal(isEntryPoint(resolve(ROOT, "scripts/mutation.mjs")), false);
  assert.equal(isEntryPoint(undefined), false);
});

test("dispatch lists through the command line it parses", () => {
  const { root, report } = sourceTree();
  const lines = printed(() => dispatch(["list", "--report", report], root));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sample\.ts:2:11-2:12/);
  rmSync(root, { recursive: true, force: true });
});

test("dispatch applies the mutant the command line names", () => {
  const { root, source, report } = sourceTree();
  printed(() => dispatch(["apply", "0", "--report", report], root));
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 3;\n");
  rmSync(root, { recursive: true, force: true });
});

test("dispatch restores in the root it was given, not this repository", () => {
  const { root, source, report } = sourceTree();
  printed(() => dispatch(["apply", "0", "--report", report], root));
  printed(() => dispatch(["restore"], root));
  assert.equal(readFileSync(source, "utf-8"), "const a = 1;\nconst b = 2;\n");
  rmSync(root, { recursive: true, force: true });
});

test("dispatch refuses a command it does not know", () => {
  // The report is named explicitly: the refusal this asserts is about the command,
  // and a default report that happens not to exist on this machine would turn it
  // into a file-not-found error that says nothing about dispatch.
  const { root, report } = sourceTree();
  assert.throws(
    () => dispatch(["publish", "--report", report], root),
    /unknown command: publish/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("the module runs its command line when it is the program", () => {
  // A child process, not a re-import under a query string: V8 reports two module
  // instances of one filename as an intersection of their coverage, so importing
  // this file a second time would report the whole script as two-thirds covered.
  // Across processes the runner merges by union, which is what makes this the way
  // to reach the entry line without lowering the file's own number.
  const { root, report } = sourceTree();
  const child = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/replay-mutant.mjs"), "list", "--report", report],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /sample\.ts:2:11-2:12/);
  rmSync(root, { recursive: true, force: true });
});

test("loadSurvivors reads a file entry that carries no mutants key", () => {
  // A Stryker report lists every file it compiled, including the ones where every
  // mutant was killed before a report row existed. Those entries have no `mutants`,
  // and a reader that assumed the key was there would throw on a real report.
  const root = fixture();
  const report = writeReport(root, {
    "src/untouched.ts": {},
    "src/a.ts": { mutants: [mutantAt(4, "1")] },
  });
  assert.deepEqual(
    loadSurvivors(report, "Survived").map((row) => row.file),
    ["src/a.ts"],
  );
  rmSync(root, { recursive: true, force: true });
});

test("printList shows an empty replacement when the report recorded none", () => {
  const lines = printed(() =>
    printList([
      {
        file: "src/a.ts",
        mutant: { ...mutantAt(3, ""), replacement: undefined },
      },
    ]),
  );
  assert.match(lines[0], /→ ""$/);
});
