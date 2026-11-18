#!/usr/bin/env node
/**
 * Resolve the mutation report's `Timeout` verdicts — and keep them resolved.
 *
 * A `Timeout` is not a verdict: it says the runner stopped, not that a test
 * objected. Stryker records two different things under that status and they
 * disagree about what the score means:
 *
 *   1. **a hit-limit abort** — with `perTest` coverage the vitest runner counts how
 *      often each mutant's statements execute and abandons the run when a mutant is
 *      hit a hundred times as often as the original. `statusReason` reads
 *      `Hit limit reached (290901/290900)`. That is a *guess* at non-termination
 *      made from an execution count, and it is a coin flip at the boundary: the
 *      `TcpSecureTransport` mutant that compares a synthetic id came back killed on
 *      2026-11-17 with 4 900 hits and timed out on 2026-11-18 with 4 901;
 *   2. **a wall-clock timeout** — the mutant's tests did not finish inside
 *      `timeoutFactor × netTime + timeoutMS`, so something did not terminate, or the
 *      machine was busy.
 *
 * Neither says whether a test objected, so each `Timeout` is re-run against the
 * tests the report attributed to it, with the edit applied to the real tree, and
 * classified by what those tests say:
 *
 *   - **failed** — vitest reported a failing test. The verdict was real; only the
 *     mechanism was incidental.
 *   - **survived** — the suite passed an edit recorded as detected. The score is
 *     wrong by that much, and this tool exits non-zero.
 *   - **stuck** — the attributed tests reported nothing and the run did not finish.
 *     The suite cannot report that, because JavaScript cannot interrupt a
 *     synchronous loop; the honest record is "this edit does not terminate", and
 *     this run is the evidence.
 *
 * A `stuck` verdict is worth exactly as much as the run that produced it, so the
 * runs are recorded: `mutation/timeouts.json` holds one entry per abort, per target,
 * keyed by file, line, mutator and replacement. That file is a **cache**, not an
 * allowlist. The set of aborts is not stable across machines — CI run 44221390170
 * reported two mutants as aborts that a 32-core workstation had killed, and two the
 * other way round, because whether the runner drains after a failed test depends on
 * the load — so a gate that compared the report against a snapshot would fail on the
 * difference between two computers.
 *
 * `--check` (which runs in CI after the mutation steps) therefore reads what it has
 * not seen: a known abort is answered from the record, an unknown one is replayed on
 * the spot, and what fails the build is the answer — a suite that *passes* an abort,
 * which is a score that counted a detection nobody made. Records whose mutant has
 * left the report are notes, and `--prune` removes them; hygiene, not correctness.
 *
 * Attribution comes from `coveredBy` in the report — the tests that executed the
 * mutant in the dry run — mapped to their files and names through `testFiles`, and
 * the child is given the same anchored name filter the vitest runner builds. Running
 * every test in the attributed *files* instead answers a slightly different
 * question, and the difference is not academic: a `backupChain` mutant was first
 * classified as detected by a case in `AC59` that the report never attributed to it.
 *
 * The edit is applied in place, so the run refuses to start on a source with
 * uncommitted changes and restores the file after every mutant — including when it
 * is told to stop, which is how the first full run of this tool was lost. A sandbox
 * would be the right place for the edit, but a sandbox has no parent, so the
 * `tsconfig` these tests extend would be missing — see `scripts/mutation.mjs`.
 *
 * Usage:
 *   node operations/scripts/resolve-timeouts.mjs [--target <name>] [--report <p>]
 *        [--cap <ms>] [--id <mutantId>[,<id>]] [--limit <n>] [--out <p>] [--dry-run]
 *        [--record] [--check [--prune] [--all]] [--proofs <p>]
 *
 *   --target   cluster | federation | operations (default: operations)
 *   --check    read every Timeout the proofs do not already answer
 *   --no-probe with --check: report them instead of reading them
 *   --all      with --check: every target that has a report
 *   --prune    with --check: drop proofs whose mutant is no longer a timeout
 *   --record   write this run's verdicts into the proofs file
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { replaceFile, splice } from './lib/mutant-edit.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_PROOFS = path.join(REPOSITORY_ROOT, 'mutation/timeouts.json');
const DEFAULT_TARGET = 'operations';

/**
 * How long a mutant's attributed tests are given before the process is killed.
 *
 * Each target's whole mutation suite runs in under a minute on an idle machine and
 * its slowest single case in under four seconds, so thirty seconds is several times
 * the cost of any legitimate run of the handful of files one mutant touches. A
 * mutant still running after that is not slow, it is looping.
 */
const DEFAULT_CAP_MS = 30_000;

/** Where a target keeps its report, its tests and the sources its mutants edit. */
async function targetOf(name) {
  const { TARGETS } = await import(pathToFileURL(path.join(REPOSITORY_ROOT, 'mutation/targets.mjs')).href);
  const entry = TARGETS[name];
  if (!entry) throw new Error(`unknown target "${name}"; known: ${Object.keys(TARGETS).join(', ')}`);
  const vitestConfig = path.join(REPOSITORY_ROOT, entry.testConfig);
  return {
    name,
    vitestConfig,
    packageDir: path.dirname(vitestConfig),
    report: path.join(REPOSITORY_ROOT, `reports/mutation/${name}.json`),
  };
}

function parseArgs(argv) {
  const args = {
    target: DEFAULT_TARGET,
    report: null,
    proofs: DEFAULT_PROOFS,
    cap: DEFAULT_CAP_MS,
    id: null,
    limit: null,
    out: null,
    dryRun: false,
    record: false,
    check: false,
    prune: false,
    all: false,
    probe: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--target') args.target = argv[++i];
    else if (token === '--report') args.report = path.resolve(REPOSITORY_ROOT, argv[++i]);
    else if (token === '--proofs') args.proofs = path.resolve(REPOSITORY_ROOT, argv[++i]);
    else if (token === '--cap') args.cap = Number(argv[++i]);
    else if (token === '--id') args.id = new Set(argv[++i].split(',').map((id) => id.trim()).filter(Boolean));
    else if (token === '--limit') args.limit = Number(argv[++i]);
    else if (token === '--out') args.out = path.resolve(REPOSITORY_ROOT, argv[++i]);
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--record') args.record = true;
    else if (token === '--check') args.check = true;
    else if (token === '--prune') args.prune = true;
    else if (token === '--all') args.all = true;
    else if (token === '--no-probe') args.probe = false;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.cap) || args.cap <= 0) throw new Error('--cap must be a positive number of milliseconds');
  return args;
}

/**
 * The identity of a verdict, as the report and the proofs file both spell it.
 *
 * The line is part of the key on purpose: a mutant that moves is a mutant whose
 * surroundings changed, and the run that proved it was about the old surroundings.
 * The column is not, because a reformat moves every column and changes no
 * behaviour — the proof would have to be re-read for nothing.
 */
function keyOf(row) {
  return `${row.file}\u0000${row.line}\u0000${row.mutator}\u0000${row.replacement}`;
}

function describeKey(row) {
  const file = row.file.replace(/^[a-z]+\/packages\//, '').replace(/^[a-z]+\/src\//, 'src/');
  return `${file}:${row.line} ${row.mutator} → ${JSON.stringify(row.replacement)}`;
}

/** Test ids are global across the report, so one map answers every mutant. */
function attributedTests(report) {
  const byId = new Map();
  for (const [file, info] of Object.entries(report.testFiles ?? {})) {
    for (const test of info.tests ?? []) byId.set(test.id, { file, name: test.name });
  }
  return (ids) => {
    const chosen = (ids ?? []).map((id) => byId.get(id)).filter(Boolean);
    return {
      files: [...new Set(chosen.map((test) => test.file))].sort(),
      names: [...new Set(chosen.map((test) => test.name))],
    };
  };
}

/**
 * The same test-name filter the vitest runner builds for a mutant.
 *
 * The runner anchors the end of the pattern and escapes each name, so a filter for
 * "calc add" does not also select "calc add negative"; both details are copied
 * rather than re-invented.
 */
function namePattern(names) {
  if (names.length === 0) return '';
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `${escaped.join('|')}\\s*$`;
}

function timeoutMutants(report) {
  const rows = [];
  for (const [file, info] of Object.entries(report.files ?? {})) {
    for (const mutant of info.mutants ?? []) {
      if (mutant.status === 'Timeout') rows.push({ file, mutant });
    }
  }
  rows.sort((a, b) =>
    a.file === b.file
      ? a.mutant.location.start.line - b.mutant.location.start.line
      : a.file.localeCompare(b.file),
  );
  return rows;
}

function identify(file, mutant) {
  return {
    file,
    line: mutant.location.start.line,
    mutator: mutant.mutatorName,
    replacement: mutant.replacement ?? '',
    reason: mutant.statusReason ?? '',
    id: mutant.id,
  };
}

/**
 * The files this run will edit have to be committed first.
 *
 * Not the whole tree: a restore writes back the exact bytes it read, so a change
 * elsewhere survives a replay untouched. What must not survive is a *mutated*
 * file — a crash between the splice and the restore would leave an edit nobody
 * asked for on top of work nobody has committed, and there would be no way to tell
 * the two apart.
 */
function requireCleanSources(files) {
  if (files.length === 0) return;
  const result = spawnSync('git', ['status', '--porcelain', '--', ...files], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  if (result.stdout.trim()) {
    throw new Error(
      [
        'these files have uncommitted changes, and this tool applies mutants in place:',
        result.stdout.trim(),
        '',
        "Commit them first — otherwise a crash mid-run would leave an edit that no diff explains.",
      ].join('\n'),
    );
  }
}

function vitestBin() {
  const bin = path.join(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs');
  if (!fs.existsSync(bin)) throw new Error(`vitest is not installed at ${bin}`);
  return bin;
}

/**
 * Run the attributed tests with the mutant applied.
 *
 * The child is its own process group so that a hang takes the workers with it: the
 * vitest parent forks the pool, and killing only the parent leaves the worker that
 * is spinning untouched, and the callback never fires.
 *
 * The child's own test timeout is half the cap, so a hang that is *asynchronous* is
 * reported as a failing test — with a name — rather than as a killed process. That
 * is the difference between a verdict and an autopsy.
 */
function runSuite(target, files, pattern, capMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin(),
        'run',
        '--config',
        target.vitestConfig,
        '--testTimeout',
        String(Math.max(5_000, Math.floor(capMs / 2))),
        '--testNamePattern',
        pattern,
        ...files,
      ],
      { cwd: target.packageDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let killed = false;
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const started = Date.now();
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, capMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, killed, output, elapsedMs: Date.now() - started });
    });
  });
}

/**
 * What the suite said, read from the reporter's own output.
 *
 * A killed child used to be classified as `stuck` before its output was read, and
 * that was wrong in the direction that matters: mutant 419 of `FileAuditStore` — the
 * group-commit queue replaced by a string — makes eleven tests fail with
 * `Test timed out in 5000ms` and *then* wedges the process, so the run never
 * returns. The suite objected loudly; only the exit did not happen. Reading the
 * output first turns that into `failed`, which is what the tests actually said.
 */
function failureIn(output) {
  const timedOut = output.match(/Test timed out in (\d+)ms/);
  if (timedOut) return `a test exceeded ${timedOut[1]}ms`;
  const assertion = output.match(/AssertionError:([^\n]*)/);
  if (assertion) return assertion[1].trim().slice(0, 160);
  const uncaught = output.match(/Uncaught Exception\s*\n([^\n]*)/);
  if (uncaught) return `uncaught ${uncaught[1].trim().slice(0, 140)}`;
  const failed = output.match(/\n\s*FAIL\s+(.+?)\n/);
  if (failed) return failed[1].trim().slice(0, 160);
  return '';
}

function classify(run) {
  const evidence = `${run.elapsedMs}ms`;
  // A filter that matches nothing exits non-zero, which would read as a detection.
  // It is the opposite: nothing ran.
  if (/No test files found|No tests found/i.test(run.output)) {
    return { verdict: 'unattributed', detail: 'the attributed names matched no test', evidence, tail: tailOf(run.output) };
  }
  const said = failureIn(run.output);
  if (run.code === 0 && !run.killed) return { verdict: 'survived', detail: 'the suite passed', evidence, tail: '' };
  if (said) {
    return {
      verdict: 'failed',
      detail: run.killed ? `${said} — and the run never exited` : said,
      evidence,
      tail: tailOf(run.output),
    };
  }
  return { verdict: 'stuck', detail: 'no test reported anything before the cap', evidence, tail: tailOf(run.output) };
}

/** The escape character the reporters colour their output with. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * What the child said last, collapsed onto one line.
 *
 * A `stuck` verdict is the strongest claim this tool makes, and "no exit within the
 * cap" is not evidence on its own: it says the process was alive, not why. A runner
 * that wedged on an unhandled rejection inside a `setImmediate`, and a loop that
 * never ends, both look like that from the outside and are different defects. The
 * last thing each said is what tells them apart.
 */
function tailOf(output) {
  const lines = output
    .split('\n')
    .map((line) => line.replace(ANSI, '').trim())
    .filter((line) => line.length > 0);
  return lines.slice(-3).join(' ⏎ ').slice(0, 400);
}

const NOTE =
  'Every Timeout in reports/mutation/<target>.json, re-run against the tests the report attributed ' +
  'to it (operations/scripts/resolve-timeouts.mjs). "failed" means vitest reported a failing test; ' +
  '"stuck" means the attributed tests reported nothing and the run did not finish. The gate requires ' +
  'this list and the report to agree in both directions.';

function readProofs(file) {
  if (!fs.existsSync(file)) return { note: NOTE, targets: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!parsed.targets) throw new Error(`${file} has no "targets" — it predates the per-target layout`);
  return parsed;
}

function writeProofs(file, proofs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const targets = {};
  for (const [name, entry] of Object.entries(proofs.targets).sort()) {
    targets[name] = {
      ...entry,
      entries: [...entry.entries].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)),
    };
  }
  fs.writeFileSync(file, `${JSON.stringify({ note: NOTE, targets }, null, 2)}\n`);
}

/**
 * The gate: no `Timeout` counts towards a score unread.
 *
 * The proofs file is a cache, not an allowlist. A `Timeout` set is not stable across
 * machines — the same mutant is killed on a 32-core workstation and abandoned on a
 * four-core runner, because whether the runner drains after a failed test depends on
 * the load — so a gate that compared the report against a snapshot would fail on the
 * difference between two computers rather than on anything about the suite. That is
 * exactly what it did on CI run 44221390170, with two mutants in each direction.
 *
 * So the gate reads what it has not seen. A `Timeout` with a proof is answered from
 * the record; a `Timeout` without one is replayed on the spot, half a minute, and the
 * run says what the suite said. What fails the build is the answer, not the
 * difference: **a suite that passes an abort** is a score that counted a detection
 * nobody made. Records whose mutant is no longer in the report are reported as notes
 * and, with `--prune`, removed — hygiene, not correctness.
 */
async function check(args) {
  const names = args.all ? ['cluster', 'federation', 'operations'] : [args.target];
  const proofs = readProofs(args.proofs);
  const problems = [];
  const notes = [];
  let totalRows = 0;
  let probed = 0;

  for (const name of names) {
    const target = await targetOf(name);
    const report = args.report && !args.all ? args.report : target.report;
    if (!fs.existsSync(report)) {
      problems.push(`no report at ${path.relative(REPOSITORY_ROOT, report)} — run "pnpm run test:mutation:${name}"`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(report, 'utf-8'));
    const rows = timeoutMutants(parsed);
    const entries = proofs.targets[name]?.entries ?? [];
    totalRows += rows.length;

    // Two mutants can share a key: `cron.ts:109` has two `ConditionalExpression →
    // false` mutants on one line. The match is a multiset, and a `Set` of keys
    // deleted a proof that was still true the first time this was written.
    const remaining = new Map();
    for (const entry of entries) {
      const key = keyOf(entry);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const unread = [];
    for (const row of rows) {
      const key = keyOf(identify(row.file, row.mutant));
      const count = remaining.get(key) ?? 0;
      if (count === 0) unread.push(row);
      else remaining.set(key, count - 1);
    }

    const counts = new Map();
    for (const entry of entries) counts.set(entry.verdict, (counts.get(entry.verdict) ?? 0) + 1);
    console.log(
      `${name}: ${rows.length} Timeout verdict(s), ${entries.length} proof(s), ${unread.length} unread`,
    );
    for (const [verdict, count] of [...counts].sort()) console.log(`  ${verdict.padEnd(10)} ${count}`);

    if (unread.length > 0 && args.probe) {
      requireCleanSources([...new Set(unread.map((row) => row.file))]);
      const testsOf = attributedTests(parsed);
      for (const row of unread) {
        const result = await probe(target, row, testsOf, args.cap);
        probed += 1;
        console.log(
          `  read now: ${describeKey(result)} — ${result.verdict}${result.detail ? `: ${result.detail}` : ''}`,
        );
        if (result.verdict === 'survived') {
          problems.push(
            `unread timeout [${name}]: ${describeKey(result)} — the suite passed the edit, so the score counted a detection nobody made`,
          );
        } else if (result.verdict === 'unreplayable') {
          problems.push(`unread timeout [${name}]: ${describeKey(result)} — cannot be replayed: ${result.detail}`);
        } else {
          notes.push(
            `new proof [${name}]: ${describeKey(result)} — ${result.verdict}${
              result.detail ? `: ${result.detail}` : ''
            }; record it with --target ${name} --record`,
          );
        }
      }
    } else {
      for (const row of unread) {
        const named = identify(row.file, row.mutant);
        problems.push(`unread timeout [${name}]: ${describeKey(named)} (${named.reason || 'no reason'})`);
      }
    }

    const allKeys = new Map();
    for (const [file, info] of Object.entries(parsed.files ?? {})) {
      for (const mutant of info.mutants ?? []) {
        const key = keyOf(identify(file, mutant));
        allKeys.set(key, (allKeys.get(key) ?? 0) + 1);
      }
    }
    const stale = new Map();
    for (const [key, count] of remaining) {
      if (count === 0 || (allKeys.get(key) ?? 0) > 0) continue;
      stale.set(key, count);
      const [file, line, mutator, replacement] = key.split('\u0000');
      notes.push(
        `stale proof [${name}]: ${describeKey({ file, line, mutator, replacement })} is not in the report any more`,
      );
    }
    if (args.prune && stale.size > 0) {
      const allowance = new Map(stale);
      const kept = entries.filter((entry) => {
        const key = keyOf(entry);
        const left = allowance.get(key) ?? 0;
        if (left === 0) return true;
        allowance.set(key, left - 1);
        return false;
      });
      if (kept.length !== entries.length) {
        proofs.targets[name] = { ...proofs.targets[name], entries: kept };
        writeProofs(args.proofs, proofs);
        console.log(
          `  pruned ${entries.length - kept.length} stale proof(s) from ${path.relative(REPOSITORY_ROOT, args.proofs)}`,
        );
      }
    }
  }

  for (const note of notes) console.log(note);
  console.log(
    `${totalRows} Timeout verdict(s) across ${names.length} target(s)${probed > 0 ? `, ${probed} read on the spot` : ''}`,
  );
  if (problems.length === 0) {
    console.log('no Timeout was counted without being read, and none hid a passing suite');
    return;
  }
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
}

async function probe(target, row, testsOf, cap) {
  const named = identify(row.file, row.mutant);
  const { files: testFiles, names: testNames } = testsOf(row.mutant.coveredBy);
  if (testFiles.length === 0) {
    return { ...named, verdict: 'unattributed', detail: 'no coveredBy tests' };
  }

  const absolute = path.join(REPOSITORY_ROOT, named.file);
  const original = fs.readFileSync(absolute, 'utf-8');
  let edit;
  try {
    edit = splice(original, row.mutant);
  } catch (error) {
    // A stale report cannot be replayed, and splicing anyway would verify an edit
    // nobody named. The report has to be regenerated.
    return { ...named, verdict: 'unreplayable', detail: error.message };
  }
  if (edit.removed === '') {
    return { ...named, verdict: 'unreplayable', detail: 'empty replace range' };
  }

  const restore = replaceFile(absolute, edit.updated).restore;
  activeRestore = restore;
  let run;
  try {
    run = await runSuite(
      target,
      testFiles.map((file) => path.relative(target.packageDir, path.join(REPOSITORY_ROOT, file))),
      namePattern(testNames),
      cap,
    );
  } finally {
    restore();
    activeRestore = null;
  }
  return { ...named, ...classify(run) };
}

async function resolve(args) {
  const target = await targetOf(args.target);
  const reportPath = args.report ?? target.report;
  if (!fs.existsSync(reportPath)) throw new Error(`${reportPath} does not exist — run the mutation target first`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const testsOf = attributedTests(report);

  let rows = timeoutMutants(report);
  // A comma-separated list, because two mutants can share an identity: `cron.ts:109`
  // has two `ConditionalExpression → false` edits on one line, and recording one of
  // them alone cannot tell the proofs file that the other was read as well.
  if (args.id) rows = rows.filter((row) => args.id.has(row.mutant.id));
  if (args.limit) rows = rows.slice(0, args.limit);
  if (rows.length === 0) {
    console.log(`${args.target}: no Timeout mutants to resolve`);
    return;
  }

  console.log(`${rows.length} Timeout mutant(s) in ${path.relative(REPOSITORY_ROOT, reportPath)}`);
  if (!args.dryRun) requireCleanSources([...new Set(rows.map((row) => row.file))]);

  const results = [];
  for (const [index, row] of rows.entries()) {
    const named = identify(row.file, row.mutant);
    const label = `${String(index + 1).padStart(2)}/${rows.length} ${describeKey(named)}`;

    if (args.dryRun) {
      const { files, names } = testsOf(row.mutant.coveredBy);
      console.log(`${label} [${named.reason || 'no reason'}] ${names.length} test(s) in ${files.length} file(s)`);
      continue;
    }

    const result = await probe(target, row, testsOf, args.cap);
    console.log(`${label} — ${result.verdict} (${result.evidence ?? 'not run'})${result.detail ? `: ${result.detail}` : ''}`);
    results.push(result);
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify({ target: args.target, report: reportPath, capMs: args.cap, results }, null, 2)}\n`);
    console.log(`written to ${path.relative(REPOSITORY_ROOT, args.out)}`);
  }

  summarise(results);

  if (args.record) {
    const proofs = readProofs(args.proofs);
    const existing = proofs.targets[args.target]?.entries ?? [];
    // One result replaces at most one entry, not every entry with the same key:
    // `cron.ts:109` carries two `ConditionalExpression → false` mutants on one line,
    // and recording the second of them used to delete the first one's proof.
    const replacing = new Map();
    for (const result of results) {
      const key = keyOf(result);
      replacing.set(key, (replacing.get(key) ?? 0) + 1);
    }
    const kept = existing.filter((entry) => {
      const key = keyOf(entry);
      const left = replacing.get(key) ?? 0;
      if (left === 0) return true;
      replacing.set(key, left - 1);
      return false;
    });
    const resolved = results.filter((result) => result.verdict === 'failed' || result.verdict === 'stuck');
    proofs.targets[args.target] = {
      capMs: args.cap,
      resolvedOn: new Date().toISOString().slice(0, 10),
      entries: [...kept, ...resolved],
    };
    writeProofs(args.proofs, proofs);
    console.log(`recorded ${resolved.length} proof(s) for ${args.target} in ${path.relative(REPOSITORY_ROOT, args.proofs)}`);
    for (const result of results) {
      if (result.verdict === 'failed' || result.verdict === 'stuck') continue;
      console.error(`not recorded: ${describeKey(result)} — ${result.verdict}`);
    }
  }

  if (results.some((result) => result.verdict === 'survived')) process.exitCode = 1;
  if (results.some((result) => result.verdict === 'unreplayable')) process.exitCode = 1;
}

function summarise(results) {
  const counts = new Map();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  console.log('');
  console.log('verdicts:');
  for (const [verdict, count] of [...counts].sort()) console.log(`  ${verdict.padEnd(12)} ${count}`);

  const survived = results.filter((result) => result.verdict === 'survived');
  if (survived.length > 0) {
    console.log('');
    console.log('the score counted these as detected, and the suite passed them:');
    for (const row of survived) console.log(`  ${describeKey(row)}`);
  }
}

/**
 * A restore that survives being interrupted.
 *
 * This tool writes a mutant into a source file and puts the original back when the
 * run ends. `finally` covers an exception; it does not cover the process being
 * killed, and that is not hypothetical — the first full run of this tool was stopped
 * with `SIGTERM` and left `FileAuditStore.ts` holding a mutant. Recovering it took a
 * backup and a hand-written `utimes`. A tool that edits the tree has to be honest
 * about the moment it is no longer running.
 */
let activeRestore = null;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (activeRestore) {
      activeRestore();
      activeRestore = null;
      console.error(`\nstopped on ${signal}; the file under replay was restored`);
    } else {
      console.error(`\nstopped on ${signal}; no file was open`);
    }
    process.exit(130);
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.check) {
  check(args).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  resolve(args).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
