/**
 * Tests for the timeout resolver.
 *
 * The tool rewrites a mutation score, so the decisions it makes have to be visible
 * one at a time. Each case below pins one of them: what counts as a proof key (the
 * line, never the column), which attributed tests a mutant is re-run against, and —
 * the case that matters most — how a killed child is read. A run that was killed
 * *after* eleven tests failed is `failed`, not `stuck`; a run that was killed with
 * nothing on stdout is `stuck`. The difference between those two is the difference
 * between "the suite objected" and "this edit does not terminate", and the tool
 * exists to keep them apart.
 *
 * Two seams make the rest reachable without becoming the thing under test. `probe`
 * takes the runner and the root, so the edit-and-restore it performs can be checked
 * against a temp tree with a canned run; `runSuite` takes the spawn, so the kill
 * that turns a hang into a verdict can be scheduled in milliseconds instead of in
 * thirty seconds. Neither is a mock of this module: what is faked is the child
 * process, and the assertions are about what this module does with it.
 *
 * What is still not here: a real vitest child. `check:mutation-timeouts` runs the
 * whole thing against the real report in CI, and a unit test that spawned vitest
 * would be measuring the suite rather than the tool.
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  attributedTests,
  check,
  classify,
  describeKey,
  fail,
  failureIn,
  identify,
  keyOf,
  main,
  namePattern,
  onSignal,
  parseArgs,
  probe,
  readProofs,
  requireCleanSources,
  resolve as resolveTimeouts,
  runSuite,
  summarise,
  tailOf,
  targetOf,
  timeoutMutants,
  vitestBin,
  writeProofs,
} from "./resolve-timeouts.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const fixture = () => mkdtempSync(join(tmpdir(), "resolve-timeouts-"));

/** Run something that may set `process.exitCode`, and put the flag back after. */
const outcome = async (fn) => {
  const before = process.exitCode;
  const said = [];
  const complained = [];
  const { log, error } = console;
  process.exitCode = undefined;
  console.log = (...args) => said.push(args.join(" "));
  console.error = (...args) => complained.push(args.join(" "));
  try {
    await fn();
    return {
      stdout: said.join("\n"),
      stderr: complained.join("\n"),
      exitCode: process.exitCode,
    };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = before;
  }
};

const capture = (fn) => {
  const lines = [];
  const { log, error } = console;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join("\n");
};

const mutant = (line, status, extra = {}) => ({
  id: `m-${line}-${status}`,
  mutatorName: "BooleanLiteral",
  status,
  statusReason: status === "Timeout" ? "Hit limit reached (290901/290900)" : "",
  replacement: "false",
  location: {
    start: { line, column: 5 },
    end: { line, column: 9 },
  },
  ...extra,
});

test("parseArgs defaults to the node target and a thirty-second cap", () => {
  const args = parseArgs([]);
  assert.equal(args.target, "node");
  assert.equal(args.cap, 30_000);
  assert.equal(args.probe, true);
  assert.equal(args.all, false);
  assert.equal(args.check, false);
  assert.equal(args.record, false);
  assert.equal(args.prune, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.id, null);
  assert.equal(args.limit, null);
  assert.equal(args.out, null);
  assert.match(args.proofs, /mutation\/timeouts\.json$/);
});

test("parseArgs reads the target, the cap and the switches", () => {
  const args = parseArgs([
    "--target",
    "cluster",
    "--cap",
    "5000",
    "--check",
    "--all",
    "--prune",
    "--no-probe",
  ]);
  assert.equal(args.target, "cluster");
  assert.equal(args.cap, 5000);
  assert.equal(args.check, true);
  assert.equal(args.all, true);
  assert.equal(args.prune, true);
  assert.equal(args.probe, false);
});

test("parseArgs turns --id into a set and trims the list", () => {
  assert.deepEqual([...parseArgs(["--id", "a, b"]).id], ["a", "b"]);
  assert.deepEqual([...parseArgs(["--id", " a,,b ,"]).id], ["a", "b"]);
});

test("parseArgs rejects a cap that is not a positive number", () => {
  assert.throws(() => parseArgs(["--cap", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--cap", "abc"]), /positive number/);
});

test("parseArgs rejects an argument it does not know", () => {
  assert.throws(() => parseArgs(["--nonsense"]), /unknown argument/);
});

test("keyOf ignores the column and keeps the line", () => {
  const first = { file: "src/a.ts", line: 9, mutator: "X", replacement: "y" };
  const moved = { ...first, column: 40 };
  const relined = { ...first, line: 10 };
  assert.equal(keyOf(first), keyOf(moved));
  assert.notEqual(keyOf(first), keyOf(relined));
});

test("keyOf distinguishes a replacement of an empty string from nothing", () => {
  const row = { file: "src/a.ts", line: 9, mutator: "X", replacement: "" };
  assert.notEqual(keyOf(row), keyOf({ ...row, replacement: "0" }));
  assert.equal(
    keyOf(row),
    "src/a.ts\u00009\u0000X\u0000",
    "the fields are separated by a byte that cannot appear in a path",
  );
});

test("describeKey drops the package prefix and quotes the replacement", () => {
  assert.equal(
    describeKey({
      file: "node/src/audit/FileAuditStore.ts",
      line: 42,
      mutator: "BooleanLiteral",
      replacement: "false",
    }),
    'src/audit/FileAuditStore.ts:42 BooleanLiteral → "false"',
  );
});

test("describeKey leaves a file outside a src tree as it is", () => {
  assert.equal(
    describeKey({
      file: "bench/run.ts",
      line: 3,
      mutator: "X",
      replacement: "",
    }),
    'bench/run.ts:3 X → ""',
  );
});

test("identify keeps the line, the mutator and the reason", () => {
  const identified = identify("src/a.ts", mutant(7, "Timeout"));
  assert.deepEqual(identified, {
    file: "src/a.ts",
    line: 7,
    mutator: "BooleanLiteral",
    replacement: "false",
    reason: "Hit limit reached (290901/290900)",
    id: "m-7-Timeout",
  });
});

test("identify answers an empty replacement when the report has none", () => {
  const bare = mutant(7, "Timeout");
  delete bare.replacement;
  assert.equal(identify("src/a.ts", bare).replacement, "");
});

test("timeoutMutants selects the aborts and drops every decided verdict", () => {
  const rows = timeoutMutants({
    files: {
      "src/b.ts": {
        mutants: [mutant(30, "Timeout"), mutant(4, "Killed")],
      },
      "src/a.ts": { mutants: [mutant(12, "Timeout"), mutant(2, "Survived")] },
    },
  });
  assert.deepEqual(
    rows.map((row) => `${row.file}:${row.mutant.location.start.line}`),
    ["src/a.ts:12", "src/b.ts:30"],
  );
});

test("timeoutMutants answers an empty list for a report with no files", () => {
  assert.deepEqual(timeoutMutants({}), []);
});

test("attributedTests maps ids back to the file and the name", () => {
  const lookup = attributedTests({
    testFiles: {
      "src/a.test.ts": { tests: [{ id: 1, name: "adds" }] },
      "src/b.test.ts": {
        tests: [
          { id: 2, name: "adds" },
          { id: 3, name: "spans" },
        ],
      },
    },
  });
  assert.deepEqual(lookup([1, 3]), {
    files: ["src/a.test.ts", "src/b.test.ts"],
    names: ["adds", "spans"],
  });
});

test("attributedTests drops an id the report does not describe", () => {
  const lookup = attributedTests({
    testFiles: { "src/a.test.ts": { tests: [{ id: 1, name: "adds" }] } },
  });
  assert.deepEqual(lookup([1, 99]), {
    files: ["src/a.test.ts"],
    names: ["adds"],
  });
  assert.deepEqual(lookup(undefined), { files: [], names: [] });
});

test("namePattern anchors the end and escapes what a name may contain", () => {
  assert.equal(namePattern([]), "");
  assert.equal(namePattern(["adds"]), "adds\\s*$");
  assert.equal(namePattern(["a+b (c)"]), "a\\+b \\(c\\)\\s*$");
  assert.equal(namePattern(["adds", "spans"]), "adds|spans\\s*$");
});

test("failureIn reports the timeout vitest printed", () => {
  assert.equal(
    failureIn("test × > adds 12ms\nTest timed out in 5000ms\n"),
    "a test exceeded 5000ms",
  );
});

test("failureIn reports the assertion message", () => {
  assert.equal(
    failureIn("AssertionError: expected 1 to be 2\n    at x"),
    "expected 1 to be 2",
  );
});

test("failureIn reports an uncaught exception", () => {
  assert.equal(
    failureIn("Uncaught Exception\n  Error: socket hang up\n"),
    "uncaught Error: socket hang up",
  );
});

test("failureIn falls back to the failing file name", () => {
  assert.equal(
    failureIn("\n  FAIL  src/a.test.ts > adds\n"),
    "src/a.test.ts > adds",
  );
});

test("failureIn answers nothing when the tests said nothing", () => {
  assert.equal(failureIn("stdout and stderr and nothing else"), "");
});

test("classify calls a run whose filter matched nothing unattributed", () => {
  const verdict = classify({
    code: 1,
    killed: false,
    elapsedMs: 1200,
    output: "No test files found, exiting with code 1",
  });
  assert.equal(verdict.verdict, "unattributed");
  assert.equal(verdict.detail, "the attributed names matched no test");
  assert.equal(verdict.evidence, "1200ms");
  assert.match(verdict.tail, /No test files found/);
});

test("classify calls a passing suite survived, with no tail to quote", () => {
  const verdict = classify({
    code: 0,
    killed: false,
    elapsedMs: 900,
    output: "Test Files  6 passed (6)\n     Tests  47 passed (47)",
  });
  assert.equal(verdict.verdict, "survived");
  assert.equal(verdict.detail, "the suite passed");
  assert.equal(verdict.tail, "");
});

test("classify reads a killed run that failed first as failed", () => {
  const verdict = classify({
    code: null,
    killed: true,
    elapsedMs: 30_000,
    output: "FAIL  src/a.test.ts > adds\nAssertionError: expected 1 to be 2\n",
  });
  assert.equal(verdict.verdict, "failed");
  assert.equal(verdict.detail, "expected 1 to be 2 — and the run never exited");
});

test("classify calls a killed run with nothing on stdout stuck", () => {
  const verdict = classify({
    code: null,
    killed: true,
    elapsedMs: 30_000,
    output: " RUN  v3.2.4 /workspace/db-stack/node\n",
  });
  assert.equal(verdict.verdict, "stuck");
  assert.equal(verdict.detail, "no test reported anything before the cap");
  assert.match(verdict.tail, /RUN/);
});

test("classify does not call a killed run survived, whatever its exit code", () => {
  const verdict = classify({
    code: 0,
    killed: true,
    elapsedMs: 30_000,
    output: "",
  });
  assert.equal(verdict.verdict, "stuck");
  assert.equal(verdict.evidence, "30000ms");
});

test("tailOf strips colour codes and keeps the last three lines", () => {
  const green = "\u001b[32m";
  const reset = "\u001b[0m";
  assert.equal(
    tailOf(`\n${green}one${reset}\n\n  two  \nthree\nfour\nfive\n`),
    "three ⏎ four ⏎ five",
  );
});

test("tailOf answers an empty string for an empty output", () => {
  assert.equal(tailOf("\n\n   \n"), "");
});

test("tailOf truncates a long line to four hundred characters", () => {
  const tail = tailOf("x".repeat(900));
  assert.equal(tail.length, 400);
});

test("readProofs answers the default record for a file that does not exist", () => {
  const root = fixture();
  const proofs = readProofs(join(root, "absent.json"));
  assert.deepEqual(proofs.targets, {});
  assert.equal(typeof proofs.note, "string");
  assert.match(proofs.note, /resolve-timeouts\.mjs/);
  rmSync(root, { recursive: true, force: true });
});

test("readProofs rejects a file written before the per-target layout", () => {
  const root = fixture();
  const file = join(root, "old.json");
  writeFileSync(file, `${JSON.stringify({ entries: [] })}\n`);
  assert.throws(() => readProofs(file), /no "targets"/);
  rmSync(root, { recursive: true, force: true });
});

test("writeProofs creates the directory and sorts targets and entries", () => {
  const root = fixture();
  const file = join(root, "nested", "timeouts.json");
  writeProofs(file, {
    targets: {
      node: {
        entries: [
          { file: "node/src/b.ts", line: 20, mutator: "X", replacement: "" },
          { file: "node/src/a.ts", line: 9, mutator: "X", replacement: "" },
        ],
      },
      cluster: { entries: [] },
    },
  });
  assert.equal(existsSync(file), true);
  assert.match(
    readFileSync(file, "utf-8"),
    /\n$/,
    "the file ends with a newline",
  );
  const written = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(written.targets), ["cluster", "node"]);
  assert.deepEqual(
    written.targets.node.entries.map((entry) => entry.file),
    ["node/src/a.ts", "node/src/b.ts"],
  );
  rmSync(root, { recursive: true, force: true });
});

test("writeProofs regenerates the note rather than copying one", () => {
  const root = fixture();
  const file = join(root, "timeouts.json");
  writeProofs(file, { note: "a stale sentence", targets: {} });
  const written = JSON.parse(readFileSync(file, "utf-8"));
  assert.notEqual(written.note, "a stale sentence");
  assert.match(written.note, /reports\/mutation\/<target>\.json/);
  rmSync(root, { recursive: true, force: true });
});

test("a written record reads back as the same entries", () => {
  const root = fixture();
  const file = join(root, "timeouts.json");
  const entries = [
    {
      file: "node/src/audit/FileAuditStore.ts",
      line: 419,
      mutator: "ConditionalExpression",
      replacement: "false",
      reason: "Hit limit reached",
      verdict: "stuck",
      evidence: "30000ms",
    },
  ];
  writeProofs(file, { targets: { node: { entries } } });
  const read = readProofs(file);
  assert.deepEqual(read.targets.node.entries, entries);
  rmSync(root, { recursive: true, force: true });
});

test("summarise counts the verdicts and names the ones that survived", () => {
  const output = capture(() =>
    summarise([
      { verdict: "failed", file: "a" },
      { verdict: "failed", file: "b" },
      { verdict: "stuck", file: "c" },
      {
        verdict: "survived",
        file: "node/src/x.ts",
        line: 3,
        mutator: "X",
        replacement: "0",
      },
    ]),
  );
  assert.match(output, /verdicts:/);
  assert.match(output, /^ {2}failed {7}2$/m);
  assert.match(output, /^ {2}stuck {8}1$/m);
  assert.match(output, /^ {2}survived {5}1$/m);
  assert.match(
    output,
    /the score counted these as detected, and the suite passed them:/,
  );
  assert.match(output, /src\/x\.ts:3 X → "0"/);
});

test("summarise says nothing about survivors when there are none", () => {
  const output = capture(() => summarise([{ verdict: "failed", file: "a" }]));
  assert.doesNotMatch(output, /counted these as detected/);
});

/**
 * A repository of this tool's own: a targets module, a report and a proofs file.
 *
 * `targetOf` imports `<root>/mutation/targets.mjs` and reads the target's
 * `testConfig` from it, so a fixture has to supply that module rather than stub the
 * loader. Everything the gate then does — the multiset match, the stale sweep, the
 * prune — runs against real files in a temp directory.
 */
const fakeRepo = ({ report, targets = ["node"] } = {}) => {
  const root = fixture();
  mkdirSync(join(root, "mutation"), { recursive: true });
  mkdirSync(join(root, "reports", "mutation"), { recursive: true });
  const declared = targets
    .map((name) => `  ${name}: { testConfig: "${name}/vitest.config.ts" },`)
    .join("\n");
  writeFileSync(
    join(root, "mutation", "targets.mjs"),
    `export const TARGETS = {\n${declared}\n};\n`,
  );
  const reportPath = join(root, "reports", "mutation", "node.json");
  if (report) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    root,
    proofs: join(root, "mutation", "timeouts.json"),
    report: reportPath,
  };
};

const proof = (row, verdict = "stuck") => ({
  ...row,
  verdict,
  evidence: "1ms",
});

const abort = (line, coveredBy = [1], extra = {}) => ({
  ...mutant(line, "Timeout"),
  coveredBy,
  ...extra,
});

test("targetOf reads the target's test config from the root it is given", async () => {
  const { root } = fakeRepo();
  const target = await targetOf("node", root);
  assert.deepEqual(target, {
    name: "node",
    root,
    vitestConfig: join(root, "node", "vitest.config.ts"),
    packageDir: join(root, "node"),
    report: join(root, "reports", "mutation", "node.json"),
  });
  rmSync(root, { recursive: true, force: true });
});

test("targetOf names the targets it does know", async () => {
  const { root } = fakeRepo();
  await assert.rejects(() => targetOf("nope", root), /unknown target "nope"/);
  await assert.rejects(() => targetOf("nope", root), /known: node/);
  rmSync(root, { recursive: true, force: true });
});

test("targetOf reads this repository's own targets module", async () => {
  const target = await targetOf("node");
  assert.equal(target.root, ROOT);
  assert.equal(target.report, join(ROOT, "reports/mutation/node.json"));
});

test("vitestBin answers the installed runner and refuses a missing one", () => {
  assert.equal(vitestBin(), join(ROOT, "node_modules/vitest/vitest.mjs"));
  assert.equal(existsSync(vitestBin()), true);
  const root = fixture();
  assert.throws(() => vitestBin(root), /vitest is not installed/);
  rmSync(root, { recursive: true, force: true });
});

test("requireCleanSources does nothing when there is no file to check", () => {
  assert.equal(requireCleanSources([]), undefined);
});

test("requireCleanSources fails loudly outside a git working tree", () => {
  const root = fixture();
  assert.throws(
    () => requireCleanSources(["src/a.ts"], root),
    /git status failed/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("requireCleanSources refuses a file with uncommitted changes", () => {
  const root = fixture();
  spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf-8" });
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  assert.throws(
    () => requireCleanSources(["a.ts"], root),
    /these files have uncommitted changes/,
  );
  assert.throws(() => requireCleanSources(["a.ts"], root), /Commit them first/);
  rmSync(root, { recursive: true, force: true });
});

test("requireCleanSources passes a path git has nothing to say about", () => {
  const root = fixture();
  spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf-8" });
  assert.equal(requireCleanSources(["a.ts"], root), undefined);
  rmSync(root, { recursive: true, force: true });
});

/** A child process stub: two output streams, a `kill` that closes it. */
const fakeChild = (pid = undefined) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.emit("close", null, signal);
  };
  return child;
};

const targetStub = () => ({
  name: "node",
  root: ROOT,
  vitestConfig: join(ROOT, "node", "vitest.config.ts"),
  packageDir: join(ROOT, "node"),
  report: join(ROOT, "reports", "mutation", "node.json"),
});

test("runSuite asks vitest for the attributed files in its own process group", async () => {
  let request = null;
  let child;
  const promise = runSuite(
    targetStub(),
    ["src/a.test.ts"],
    "adds\\s*$",
    10_000,
    (...args) => {
      request = args;
      child = fakeChild();
      return child;
    },
  );
  child.emit("close", 0, null);
  const result = await promise;

  const [command, argv, options] = request;
  assert.equal(command, process.execPath);
  assert.deepEqual(argv, [
    vitestBin(),
    "run",
    "--config",
    join(ROOT, "node", "vitest.config.ts"),
    "--testTimeout",
    "5000",
    "--testNamePattern",
    "adds\\s*$",
    "src/a.test.ts",
  ]);
  assert.equal(options.cwd, join(ROOT, "node"));
  assert.equal(options.detached, true, "a hang has to take the pool with it");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.code, 0);
  assert.equal(result.killed, false);
  assert.equal(typeof result.elapsedMs, "number");
});

test("runSuite halves a short cap but never asks for less than five seconds", async () => {
  const caps = [];
  for (const cap of [4_000, 30_000]) {
    let child;
    const promise = runSuite(targetStub(), [], "", cap, (...args) => {
      caps.push(Number(args[1][5]));
      child = fakeChild();
      return child;
    });
    child.emit("close", 0, null);
    await promise;
  }
  assert.deepEqual(caps, [5_000, 15_000]);
});

test("runSuite collects both streams into one output", async () => {
  let child;
  const promise = runSuite(
    targetStub(),
    [],
    "",
    10_000,
    () => (child = fakeChild()),
  );
  child.stdout.emit("data", Buffer.from("out "));
  child.stderr.emit("data", Buffer.from("err"));
  child.emit("close", 1, null);
  const result = await promise;
  assert.equal(result.output, "out err");
  assert.equal(result.code, 1);
});

test("runSuite keeps the tail of a flood rather than the whole of it", async () => {
  let child;
  const promise = runSuite(
    targetStub(),
    [],
    "",
    10_000,
    () => (child = fakeChild()),
  );
  child.stdout.emit("data", Buffer.from("x".repeat(400_000)));
  child.emit("close", 1, null);
  const result = await promise;
  assert.equal(result.output.length, 100_000);
  assert.match(result.output, /^x+$/);
});

test("runSuite kills the child at the cap and says so", async () => {
  let child;
  const promise = runSuite(
    targetStub(),
    [],
    "",
    20,
    () => (child = fakeChild()),
  );
  const result = await promise;
  assert.equal(result.killed, true);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("runSuite kills the whole process group, not just the parent", async () => {
  // `process.kill(-pid)` against a real group would take the test runner down with
  // it, so the system call is the one thing replaced here: the case asserts that a
  // pid becomes a *negative* pid — the group — and that the per-child fallback is
  // not used when the group kill succeeds.
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
  };
  let child;
  try {
    const promise = runSuite(targetStub(), [], "", 15, () => {
      child = fakeChild(4_242);
      child.kill = (signal) => child.signals.push(signal);
      return child;
    });
    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(calls, [[-4_242, "SIGKILL"]]);
    assert.deepEqual(
      child.signals,
      [],
      "the group kill succeeded, so no fallback",
    );
    child.emit("close", null, "SIGKILL");
    const result = await promise;
    assert.equal(result.killed, true);
  } finally {
    process.kill = realKill;
  }
});

/** A temp repository with one source file, one attributed test and a target. */
const probeRepo = () => {
  const root = fixture();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node"), { recursive: true });
  mkdirSync(join(root, "reports", "mutation"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
  // Column 11 is the `2` on the second line, so the edit the report describes is a
  // replacement of that literal and not of whatever four characters start there.
  const row = (line = 2) =>
    abort(line, [1], {
      location: {
        start: { line, column: 11 },
        end: { line, column: 12 },
      },
    });
  const report = {
    files: { "src/a.ts": { mutants: [row()] } },
    testFiles: { "src/a.test.ts": { tests: [{ id: 1, name: "adds" }] } },
  };
  const target = {
    name: "node",
    root,
    vitestConfig: join(root, "node", "vitest.config.ts"),
    packageDir: join(root, "node"),
    report: join(root, "reports", "mutation", "node.json"),
  };
  return { root, target, report, row, testsOf: attributedTests(report) };
};

test("probe answers unattributed when no test covers the mutant", async () => {
  const { root, target, testsOf } = probeRepo();
  const result = await probe(
    target,
    { file: "src/a.ts", mutant: abort(2, [99]) },
    testsOf,
    1_000,
    { root },
  );
  assert.equal(result.verdict, "unattributed");
  assert.equal(result.detail, "no coveredBy tests");
  assert.equal(result.file, "src/a.ts");
  assert.equal(result.line, 2);
  rmSync(root, { recursive: true, force: true });
});

test("probe answers unreplayable when the report's line is past the file", async () => {
  const { root, target, testsOf } = probeRepo();
  const result = await probe(
    target,
    { file: "src/a.ts", mutant: abort(99) },
    testsOf,
    1_000,
    { root },
  );
  assert.equal(result.verdict, "unreplayable");
  assert.match(result.detail, /line 99 is past the end of the file/);
  rmSync(root, { recursive: true, force: true });
});

test("probe answers unreplayable for a range that replaces nothing", async () => {
  const { root, target, testsOf } = probeRepo();
  const empty = abort(2);
  empty.location.end = { ...empty.location.start };
  const result = await probe(
    target,
    { file: "src/a.ts", mutant: empty },
    testsOf,
    1_000,
    { root },
  );
  assert.equal(result.verdict, "unreplayable");
  assert.equal(result.detail, "empty replace range");
  rmSync(root, { recursive: true, force: true });
});

test("probe applies the edit, runs the attributed tests and puts the file back", async () => {
  const { root, target, row, testsOf } = probeRepo();
  const seen = [];
  const result = await probe(
    target,
    { file: "src/a.ts", mutant: row() },
    testsOf,
    1_234,
    {
      root,
      runner: (t, files, pattern, cap) => {
        seen.push({ t, files, pattern, cap });
        assert.equal(
          readFileSync(join(root, "src", "a.ts"), "utf-8"),
          "const a = 1;\nconst b = false;\n",
          "the tests run against the mutant, not the original",
        );
        return { code: 0, killed: false, elapsedMs: 5, output: "1 passed" };
      },
    },
  );
  assert.equal(result.verdict, "survived");
  assert.equal(result.evidence, "5ms");
  assert.deepEqual(seen, [
    {
      t: target,
      files: ["../src/a.test.ts"],
      pattern: "adds\\s*$",
      cap: 1_234,
    },
  ]);
  assert.equal(
    readFileSync(join(root, "src", "a.ts"), "utf-8"),
    "const a = 1;\nconst b = 2;\n",
  );
  assert.equal(existsSync(join(root, "src", "a.ts.replay.bak")), false);
  rmSync(root, { recursive: true, force: true });
});

test("probe reads a killed run's last words as a failure", async () => {
  const { root, target, row, testsOf } = probeRepo();
  const result = await probe(
    target,
    { file: "src/a.ts", mutant: row() },
    testsOf,
    1_000,
    {
      root,
      runner: () => ({
        code: null,
        killed: true,
        elapsedMs: 1_000,
        output:
          "FAIL  src/a.test.ts > adds\nAssertionError: expected 1 to be 2",
      }),
    },
  );
  assert.equal(result.verdict, "failed");
  assert.equal(result.detail, "expected 1 to be 2 — and the run never exited");
  rmSync(root, { recursive: true, force: true });
});

test("probe puts the file back even when the run itself throws", async () => {
  const { root, target, row, testsOf } = probeRepo();
  await assert.rejects(
    () =>
      probe(target, { file: "src/a.ts", mutant: row() }, testsOf, 1_000, {
        root,
        runner: () => {
          throw new Error("spawn failed");
        },
      }),
    /spawn failed/,
  );
  assert.equal(
    readFileSync(join(root, "src", "a.ts"), "utf-8"),
    "const a = 1;\nconst b = 2;\n",
  );
  assert.equal(existsSync(join(root, "src", "a.ts.replay.bak")), false);
  rmSync(root, { recursive: true, force: true });
});

const gateArgs = (proofs, extra = []) =>
  parseArgs(["--target", "node", "--proofs", proofs, ...extra]);

test("check reports a target it has no report for", async () => {
  const { root, proofs } = fakeRepo();
  const state = await outcome(() => check(gateArgs(proofs), { root }));
  assert.equal(state.exitCode, 1);
  assert.match(state.stderr, /no report at reports\/mutation\/node\.json/);
  assert.match(state.stderr, /pnpm run test:mutation:node/);
  rmSync(root, { recursive: true, force: true });
});

test("check reports every target when --all is given", async () => {
  const { root, proofs } = fakeRepo({
    targets: ["node", "cluster", "federation"],
    report: { files: {} },
  });
  const state = await outcome(() =>
    check(parseArgs(["--all", "--proofs", proofs, "--no-probe"]), { root }),
  );
  assert.match(state.stderr, /reports\/mutation\/cluster\.json/);
  assert.match(state.stderr, /reports\/mutation\/federation\.json/);
  rmSync(root, { recursive: true, force: true });
});

test("check accepts a report whose every abort carries a proof", async () => {
  const row = abort(2);
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [row] } } },
  });
  writeProofs(proofs, {
    targets: { node: { entries: [proof(identify("src/a.ts", row))] } },
  });
  const state = await outcome(() => check(gateArgs(proofs), { root }));
  assert.equal(state.exitCode, undefined);
  assert.match(
    state.stdout,
    /node: 1 Timeout verdict\(s\), 1 proof\(s\), 0 unread/,
  );
  assert.match(state.stdout, /^ {2}stuck {6}1$/m);
  assert.match(state.stdout, /no Timeout was counted without being read/);
  rmSync(root, { recursive: true, force: true });
});

test("check names an unread abort when probing is off", async () => {
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const state = await outcome(() =>
    check(gateArgs(proofs, ["--no-probe"]), { root }),
  );
  assert.equal(state.exitCode, 1);
  assert.match(
    state.stderr,
    /unread timeout \[node\]: src\/a\.ts:2 BooleanLiteral → "false" \(Hit limit reached/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("check reads an unread abort on the spot and notes the new proof", async () => {
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const cleaned = [];
  const state = await outcome(() =>
    check(gateArgs(proofs), {
      root,
      requireClean: (files, where) => cleaned.push([files, where]),
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "failed",
        detail: "expected 1 to be 2",
        evidence: "40ms",
      }),
    }),
  );
  assert.deepEqual(
    cleaned,
    [[["src/a.ts"], root]],
    "the edited files are checked first",
  );
  assert.equal(state.exitCode, undefined);
  assert.match(
    state.stdout,
    /read now: src\/a\.ts:2 BooleanLiteral → "false" — failed/,
  );
  assert.match(
    state.stdout,
    /new proof \[node\].*record it with --target node --record/,
  );
  assert.match(
    state.stdout,
    /1 Timeout verdict\(s\) across 1 target\(s\), 1 read on the spot/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("check fails when the suite passes an abort", async () => {
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const state = await outcome(() =>
    check(gateArgs(proofs), {
      root,
      requireClean: () => {},
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "survived",
      }),
    }),
  );
  assert.equal(state.exitCode, 1);
  assert.match(
    state.stderr,
    /the suite passed the edit, so the score counted a detection nobody made/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("check fails on an abort it cannot replay", async () => {
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const state = await outcome(() =>
    check(gateArgs(proofs), {
      root,
      requireClean: () => {},
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "unreplayable",
        detail: "line 2 is past the end of the file",
      }),
    }),
  );
  assert.equal(state.exitCode, 1);
  assert.match(state.stderr, /cannot be replayed: line 2 is past the end/);
  rmSync(root, { recursive: true, force: true });
});

test("check matches proofs as a multiset, not a set", async () => {
  // `cron.ts:109` carries two identical `ConditionalExpression → false` mutants on
  // one line. One proof answers one of them, and a set would have answered both.
  const first = abort(109);
  const second = { ...abort(109), id: "another" };
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [first, second] } } },
  });
  writeProofs(proofs, {
    targets: { node: { entries: [proof(identify("src/a.ts", first))] } },
  });
  const state = await outcome(() =>
    check(gateArgs(proofs, ["--no-probe"]), { root }),
  );
  assert.equal(state.exitCode, 1);
  assert.equal(state.stderr.split("unread timeout").length - 1, 1);
  rmSync(root, { recursive: true, force: true });
});

test("check notes a proof whose mutant is gone", async () => {
  const row = abort(2);
  const gone = abort(7);
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [row] } } },
  });
  writeProofs(proofs, {
    targets: {
      node: {
        entries: [
          proof(identify("src/a.ts", row)),
          proof(identify("src/a.ts", gone)),
        ],
      },
    },
  });
  const state = await outcome(() => check(gateArgs(proofs), { root }));
  assert.equal(state.exitCode, undefined);
  assert.match(
    state.stdout,
    /stale proof \[node\]: src\/a\.ts:7 .* is not in the report any more/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("check prunes a stale proof when asked", async () => {
  const row = abort(2);
  const gone = abort(7);
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [row] } } },
  });
  writeProofs(proofs, {
    targets: {
      node: {
        entries: [
          proof(identify("src/a.ts", row)),
          proof(identify("src/a.ts", gone)),
        ],
      },
    },
  });
  const state = await outcome(() =>
    check(gateArgs(proofs, ["--prune"]), { root }),
  );
  assert.match(
    state.stdout,
    /pruned 1 stale proof\(s\) from mutation\/timeouts\.json/,
  );
  const rewritten = readProofs(proofs);
  assert.deepEqual(
    rewritten.targets.node.entries.map((entry) => entry.line),
    [2],
  );
  rmSync(root, { recursive: true, force: true });
});

const resolveArgs = (paths, extra = []) =>
  parseArgs([
    "--target",
    "node",
    "--report",
    paths.report,
    "--proofs",
    paths.proofs,
    ...extra,
  ]);

test("resolve refuses to run without a report", async () => {
  const { root, proofs, report } = fakeRepo();
  await assert.rejects(
    () => resolveTimeouts(resolveArgs({ proofs, report }), { root }),
    /does not exist — run the mutation target first/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("resolve says so when the report holds no aborts", async () => {
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [mutant(2, "Killed")] } } },
  });
  const state = await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }), { root }),
  );
  assert.match(state.stdout, /node: no Timeout mutants to resolve/);
  rmSync(root, { recursive: true, force: true });
});

test("resolve --dry-run names the tests without touching the file", async () => {
  const { root, proofs, report } = fakeRepo({
    report: {
      files: { "src/a.ts": { mutants: [abort(2)] } },
      testFiles: { "src/a.test.ts": { tests: [{ id: 1, name: "adds" }] } },
    },
  });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
  let cleaned = 0;
  let probed = 0;
  const state = await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }, ["--dry-run"]), {
      root,
      requireClean: () => (cleaned += 1),
      probeOne: () => (probed += 1),
    }),
  );
  assert.equal(cleaned, 0);
  assert.equal(probed, 0);
  assert.match(
    state.stdout,
    /1 Timeout mutant\(s\) in reports\/mutation\/node\.json/,
  );
  assert.match(
    state.stdout,
    /1\/1 src\/a\.ts:2 BooleanLiteral → "false" \[Hit limit reached.*1 test\(s\) in 1 file\(s\)/,
  );
  assert.equal(
    readFileSync(join(root, "src", "a.ts"), "utf-8"),
    "const a = 1;\nconst b = 2;\n",
  );
  rmSync(root, { recursive: true, force: true });
});

test("resolve writes what it found, records it, and keeps the untouched proofs", async () => {
  const { root, proofs, report } = fakeRepo({
    report: {
      files: { "src/a.ts": { mutants: [abort(2), abort(7)] } },
    },
  });
  const elsewhere = proof(identify("src/b.ts", abort(5)));
  writeProofs(proofs, { targets: { node: { entries: [elsewhere] } } });
  const out = join(root, "reports", "resolved.json");
  const state = await outcome(() =>
    resolveTimeouts(
      resolveArgs({ proofs, report }, [
        "--out",
        out,
        "--record",
        "--cap",
        "9000",
      ]),
      {
        root,
        requireClean: () => {},
        probeOne: (target, row) => ({
          ...identify(row.file, row.mutant),
          verdict: "stuck",
          evidence: "9000ms",
          detail: "no test reported anything before the cap",
        }),
      },
    ),
  );
  assert.equal(state.exitCode, undefined);
  const written = JSON.parse(readFileSync(out, "utf-8"));
  assert.equal(written.target, "node");
  assert.equal(written.capMs, 9000);
  assert.deepEqual(
    written.results.map((result) => result.line),
    [2, 7],
  );
  const recorded = readProofs(proofs);
  assert.deepEqual(
    recorded.targets.node.entries.map((entry) => `${entry.file}:${entry.line}`),
    ["src/a.ts:2", "src/a.ts:7", "src/b.ts:5"],
    "the unmatched proof for src/b.ts survives the record, after the ones it re-read",
  );
  assert.equal(recorded.targets.node.capMs, 9000);
  assert.match(recorded.targets.node.resolvedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(state.stdout, /verdicts:/);
  rmSync(root, { recursive: true, force: true });
});

test("resolve exits non-zero when an abort was a pass", async () => {
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const state = await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }), {
      root,
      requireClean: () => {},
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "survived",
        evidence: "12ms",
      }),
    }),
  );
  assert.equal(state.exitCode, 1);
  assert.match(state.stdout, /the score counted these as detected/);
  rmSync(root, { recursive: true, force: true });
});

test("resolve filters by --id and then by --limit", async () => {
  const rows = [abort(2), abort(7), abort(9)];
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: rows } } },
  });
  const probed = [];
  const state = await outcome(() =>
    resolveTimeouts(
      resolveArgs({ proofs, report }, ["--id", rows[2].id, "--limit", "1"]),
      {
        root,
        requireClean: () => {},
        probeOne: (target, row) => {
          probed.push(row.mutant.location.start.line);
          return {
            ...identify(row.file, row.mutant),
            verdict: "failed",
            evidence: "1ms",
          };
        },
      },
    ),
  );
  assert.deepEqual(probed, [9]);
  assert.match(
    state.stdout,
    /1 Timeout mutant\(s\) in reports\/mutation\/node\.json/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a signal restores the file under replay before it exits", async () => {
  const { root, target, row, testsOf } = probeRepo();
  const exits = [];
  await probe(target, { file: "src/a.ts", mutant: row() }, testsOf, 1_000, {
    root,
    runner: () => {
      const state = capture(() =>
        onSignal("SIGTERM", (code) => exits.push(code)),
      );
      assert.match(
        state,
        /stopped on SIGTERM; the file under replay was restored/,
      );
      assert.equal(
        readFileSync(join(root, "src", "a.ts"), "utf-8"),
        "const a = 1;\nconst b = 2;\n",
        "the source is back before the process leaves",
      );
      assert.equal(existsSync(join(root, "src", "a.ts.replay.bak")), false);
      return { code: 0, killed: false, elapsedMs: 1, output: "" };
    },
  });
  assert.deepEqual(exits, [130]);
  rmSync(root, { recursive: true, force: true });
});

test("a signal with nothing open says so and still exits", () => {
  const exits = [];
  const state = capture(() => onSignal("SIGINT", (code) => exits.push(code)));
  assert.match(state, /stopped on SIGINT; no file was open/);
  assert.deepEqual(exits, [130]);
});

test("check reads the report it is pointed at instead of the target's own", async () => {
  const { root, proofs } = fakeRepo();
  const elsewhere = join(root, "reports", "named.json");
  writeFileSync(
    elsewhere,
    `${JSON.stringify({ files: { "src/a.ts": { mutants: [abort(2)] } } })}\n`,
  );
  const state = await outcome(() =>
    check(
      parseArgs([
        "--target",
        "node",
        "--report",
        elsewhere,
        "--proofs",
        proofs,
        "--no-probe",
      ]),
      { root },
    ),
  );
  assert.match(state.stderr, /unread timeout \[node\]/);
  assert.doesNotMatch(state.stderr, /no report at/);
  rmSync(root, { recursive: true, force: true });
});

test("resolve exits non-zero when an abort cannot be replayed", async () => {
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const state = await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }, ["--record"]), {
      root,
      requireClean: () => {},
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "unreplayable",
        detail: "line 2 is past the end of the file",
      }),
    }),
  );
  assert.equal(state.exitCode, 1);
  assert.match(state.stderr, /not recorded: src\/a\.ts:2 .* — unreplayable/);
  rmSync(root, { recursive: true, force: true });
});

test("probe falls back to this repository when no options are given", async () => {
  const { root, testsOf } = probeRepo();
  // No `root` and no runner: the case stops before either is used, at the point
  // where the report attributes no test to the mutant.
  const result = await probe(
    targetStub(),
    { file: "src/a.ts", mutant: abort(2, [99]) },
    testsOf,
    1_000,
  );
  assert.equal(result.verdict, "unattributed");
  rmSync(root, { recursive: true, force: true });
});

test("main sends --check to the gate and everything else to the re-reader", async () => {
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const gate = await outcome(() =>
    main(["--check", "--target", "node", "--proofs", proofs, "--no-probe"], {
      root,
    }),
  );
  assert.match(gate.stderr, /unread timeout \[node\]/);

  const reread = await outcome(() =>
    main(
      ["--target", "node", "--report", report, "--proofs", proofs, "--dry-run"],
      { root },
    ),
  );
  assert.match(
    reread.stdout,
    /1 Timeout mutant\(s\) in reports\/mutation\/node\.json/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("recording an answer replaces its old proof instead of adding a second", async () => {
  const row = abort(2);
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [row] } } },
  });
  writeProofs(proofs, {
    targets: {
      node: { entries: [proof(identify("src/a.ts", row), "failed")] },
    },
  });
  await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }, ["--record"]), {
      root,
      requireClean: () => {},
      probeOne: (target, mutant) => ({
        ...identify(mutant.file, mutant.mutant),
        verdict: "stuck",
        evidence: "1ms",
      }),
    }),
  );
  const recorded = readProofs(proofs);
  assert.deepEqual(
    recorded.targets.node.entries.map((entry) => [entry.line, entry.verdict]),
    [[2, "stuck"]],
    "one answer for one abort, not two",
  );
  rmSync(root, { recursive: true, force: true });
});

test("a run that threw prints the reason and turns the build red", async () => {
  const state = await outcome(() =>
    fail(new Error("no report at reports/mutation/node.json — run the target")),
  );
  assert.equal(state.exitCode, 1);
  assert.match(state.stderr, /no report at reports\/mutation\/node\.json/);
});

test("attributedTests copes with a report that names no test files", () => {
  assert.deepEqual(attributedTests({})([1]), { files: [], names: [] });
});

test("timeoutMutants copes with a file entry that lists no mutants", () => {
  assert.deepEqual(timeoutMutants({ files: { "src/a.ts": {} } }), []);
});

test("identify answers an empty reason when the report gives none", () => {
  const bare = mutant(7, "Timeout");
  delete bare.statusReason;
  assert.equal(identify("src/a.ts", bare).reason, "");
});

test("classify reports a plain failure without the killed suffix", () => {
  const verdict = classify({
    code: 1,
    killed: false,
    elapsedMs: 40,
    output: "\n  FAIL  src/a.test.ts > adds\n",
  });
  assert.equal(verdict.verdict, "failed");
  assert.equal(verdict.detail, "src/a.test.ts > adds");
});

test("check replays an unread abort in a committed tree", async () => {
  // The default `requireClean` is the real one, so the fixture has to be a git
  // working tree with the file committed — which is the state the tool requires and
  // the reason it refuses to start otherwise.
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
  for (const argv of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.email=gate@example.invalid",
      "-c",
      "user.name=Gate",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
  ])
    spawnSync("git", argv, { cwd: root, encoding: "utf-8" });

  const state = await outcome(() =>
    check(gateArgs(proofs), {
      root,
      probeOne: (target, row) => ({
        ...identify(row.file, row.mutant),
        verdict: "failed",
      }),
    }),
  );
  assert.equal(state.exitCode, undefined);
  assert.match(
    state.stdout,
    /read now: src\/a\.ts:2 BooleanLiteral → "false" — failed/,
  );
  assert.match(state.stdout, /; record it with --target node --record/);
  rmSync(root, { recursive: true, force: true });
});

test("an abort the report gives no reason for is named as such", async () => {
  const quiet = abort(2);
  delete quiet.statusReason;
  const { root, proofs, report } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [quiet] } } },
  });
  const gate = await outcome(() =>
    check(gateArgs(proofs, ["--no-probe"]), { root }),
  );
  assert.match(gate.stderr, /\(no reason\)$/m);

  const dry = await outcome(() =>
    resolveTimeouts(resolveArgs({ proofs, report }, ["--dry-run"]), { root }),
  );
  assert.match(dry.stdout, /\[no reason\]/);
  rmSync(root, { recursive: true, force: true });
});

test("check reads a report that names no files at all", async () => {
  const { root, proofs } = fakeRepo({ report: {} });
  const state = await outcome(() =>
    check(gateArgs(proofs, ["--no-probe"]), { root }),
  );
  assert.equal(state.exitCode, undefined);
  assert.match(state.stdout, /0 Timeout verdict\(s\), 0 proof\(s\), 0 unread/);
  rmSync(root, { recursive: true, force: true });
});

test("resolve uses the target's own report when none is named", async () => {
  const { root, proofs } = fakeRepo({
    report: { files: { "src/a.ts": { mutants: [abort(2)] } } },
  });
  const probed = [];
  const state = await outcome(() =>
    resolveTimeouts(parseArgs(["--target", "node", "--proofs", proofs]), {
      root,
      requireClean: () => {},
      probeOne: (target, row) => {
        probed.push(row.mutant.location.start.line);
        return {
          ...identify(row.file, row.mutant),
          verdict: "failed",
          evidence: "1ms",
        };
      },
    }),
  );
  assert.deepEqual(probed, [2]);
  assert.match(
    state.stdout,
    /1 Timeout mutant\(s\) in reports\/mutation\/node\.json/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a signal with no exit hook given uses the process's own", () => {
  const realExit = process.exit;
  const codes = [];
  process.exit = (code) => codes.push(code);
  try {
    capture(() => onSignal("SIGHUP"));
  } finally {
    process.exit = realExit;
  }
  assert.deepEqual(codes, [130]);
});
