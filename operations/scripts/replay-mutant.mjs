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
 *   node scripts/replay-mutant.mjs list [--report <path>] [--status Survived]
 *   node scripts/replay-mutant.mjs apply <index> [--report <path>]
 *   node scripts/replay-mutant.mjs restore
 *
 * `apply` copies the file to `<file>.replay.bak` and splices the replacement into
 * the recorded range. Run the tests, then `restore`. Nothing here guesses: if the
 * recorded range does not hold the text the mutator claims to replace, it says so
 * and changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_REPORT = 'reports/mutation/operations.json';
const BACKUP_SUFFIX = '.replay.bak';

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'list', index: null, report: DEFAULT_REPORT, status: 'Survived' };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--report') args.report = rest[++i];
    else if (token === '--status') args.status = rest[++i];
    else if (/^\d+$/.test(token)) args.index = Number(token);
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function loadSurvivors(reportPath, status) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const rows = [];
  for (const [file, info] of Object.entries(report.files ?? {})) {
    for (const mutant of info.mutants ?? []) {
      if (status !== '*' && mutant.status !== status) continue;
      rows.push({ file, mutant });
    }
  }
  rows.sort((a, b) =>
    a.file === b.file ? a.mutant.location.start.line - b.mutant.location.start.line : a.file.localeCompare(b.file),
  );
  return rows;
}

/**
 * The report's positions are 1-based in both axes (line 1 is the first line,
 * column 1 the first character). Treating the column as 0-based — which is what
 * Stryker's own `Position` type says — shifts every replay one character to the
 * right, which is exactly the kind of near-miss this script exists to prevent.
 */
function offsetOf(text, { line, column }) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) throw new Error(`line ${line} is past the end of the file`);
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset) === -1 ? text.length : text.indexOf('\n', offset);
  const absolute = offset + column - 1;
  if (absolute > lineEnd) throw new Error(`column ${column} is past the end of line ${line}`);
  return absolute;
}

function printList(rows) {
  if (rows.length === 0) {
    console.log('no mutants with that status');
    return;
  }
  rows.forEach(({ file, mutant }, index) => {
    const { start, end } = mutant.location;
    const replacement = JSON.stringify(mutant.replacement ?? '').slice(0, 58);
    console.log(
      `${String(index).padStart(3)} ${file.split('/').slice(-1)[0]}:${start.line}:${start.column}-${end.line}:${end.column} ` +
        `${mutant.mutatorName} → ${replacement}`,
    );
  });
}

function apply(rows, index) {
  const row = rows[index];
  if (!row) throw new Error(`no mutant at index ${index}`);

  const absPath = path.resolve(row.file);
  const text = fs.readFileSync(absPath, 'utf-8');
  const from = offsetOf(text, row.mutant.location.start);
  const to = offsetOf(text, row.mutant.location.end);
  const removed = text.slice(from, to);
  const replacement = row.mutant.replacement ?? '';

  fs.writeFileSync(absPath + BACKUP_SUFFIX, text);
  fs.writeFileSync(absPath, text.slice(0, from) + replacement + text.slice(to));

  console.log(`${row.file}:${row.mutant.location.start.line}`);
  console.log(`- ${removed.replace(/\n/g, '\\n')}`);
  console.log(`+ ${replacement.replace(/\n/g, '\\n')}`);
  console.log(`applied; run the tests, then \`node scripts/replay-mutant.mjs restore\``);
}

function restore() {
  let restored = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.stryker-tmp') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(BACKUP_SUFFIX)) {
        fs.renameSync(full, full.slice(0, -BACKUP_SUFFIX.length));
        restored += 1;
      }
    }
  };
  walk(process.cwd());
  console.log(`restored ${restored} file(s)`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === 'restore') {
  restore();
} else {
  const rows = loadSurvivors(args.report, args.status);
  if (args.command === 'list') printList(rows);
  else if (args.command === 'apply') apply(rows, args.index);
  else throw new Error(`unknown command: ${args.command}`);
}
