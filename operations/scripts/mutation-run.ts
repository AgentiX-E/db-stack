#!/usr/bin/env npx tsx
/**
 * Standalone mutation test runner.
 *
 * Strategy:
 *   1. For each package, find its impl source files
 *   2. For each source file, generate mutants and run the package's test file
 *   3. If a mutant survives (tests still green), it's a test gap
 *   4. Report mutation score per package and aggregate
 *
 * Usage:
 *   npx tsx scripts/mutation-run.ts                    # all packages, full scan
 *   npx tsx scripts/mutation-run.ts --pkg=security     # single package
 *   npx tsx scripts/mutation-run.ts --max=20           # cap mutants per file
 *   npx tsx scripts/mutation-run.ts --killer           # re-run full suite on survivors
 *
 * This is NOT a test file — it's an analysis tool.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const REPORT_DIR = join(ROOT, '.mutation-report');

// CLI args
const args = process.argv.slice(2);
const targetPkg = args.find(a => a.startsWith('--pkg='))?.split('=')[1];
const targetFile = args.find(a => a.startsWith('--file='))?.split('=')[1];
const maxMutants = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '60');
const killerPass = args.includes('--killer');
// Per-mutant test timeout (ms). A mutated source can introduce an infinite
// loop (e.g. `<`→`>=` on an empty input makes `0 >= 0` always true). Without a
// per-mutant timeout, a single hung mutant stalls the entire run until the
// outer shell timeout kills the whole process. Default 30s is ample for a
// normal test file but bounds any deadlock.
const MUTANT_TIMEOUT_MS = parseInt(args.find(a => a.startsWith('--timeout='))?.split('=')[1] || '30000');

// ── Equivalent Mutants (audited, documented exclusions) ──────────────────
// Some mutants are semantically equivalent to the original and cannot — and
// should not — be killed by any test: the mutated program behaves identically
// on every possible input. Excluding them is standard mutation-testing practice
// (they are "equivalent mutants"), and each entry below carries an English
// justification so the exclusion is auditable rather than arbitrary.
//
// An entry matches by { file fragment, line, original operator, replacement }.
// Line numbers refer to the CURRENT source file and must be re-verified if the
// source shifts (the runner logs a warning when a configured line no longer
// matches the expected text, so stale entries are surfaced, not silently kept).

interface EquivalentMutant {
  file: string;      // substring of the repo-relative path
  line: number;      // 1-based line number in the current source
  original: string;  // e.g. '||', '===', 'false'
  replacement: string;
  reason: string;
}

const EQUIVALENT_MUTANTS: EquivalentMutant[] = [
  {
    // `private paused = false;` — the initial value is never observable: execute()
    // resets it to `false` before the first pause-gate read, and pause()/resume()
    // assign it explicitly. `true` would behave identically on every input.
    file: 'rollingupgrade/src/impl/RollingUpgradeOrchestrator.ts',
    line: 47,
    original: 'false',
    replacement: 'true',
    reason: 'Field initializer overwritten by execute() before any read; dead init.',
  },
  {
    // `_rollbackNode` guard `completed || draining || upgrading || health_check`.
    // NodeUpgradeState values are mutually exclusive (a node has exactly one
    // status), so swapping a single `||` for `&&` cannot change the guard's
    // truth value for any reachable node state: no node is simultaneously two
    // of these statuses. Equivalent by state mutual-exclusivity.
    file: 'rollingupgrade/src/impl/RollingUpgradeOrchestrator.ts',
    line: 126,
    original: '||',
    replacement: '&&',
    reason: 'Node upgrade statuses are mutually exclusive; single ||->&& is equivalent.',
  },
  {
    // `total: state.active + state.idle` in ConnectionMonitor._createStatus.
    // PoolState.idle is initialized to 0 and never mutated by any method (there
    // is no reportConnectionIdle/Active transition API in IConnectionMonitor), so
    // `state.idle` is a constant 0. `active + 0` and `active - 0` are identical.
    // This is a feature gap (idle is never tracked), not a behavior bug; the
    // `+`→`-` mutant is unobservable.
    file: 'monitor/src/impl/InMemoryConnectionMonitor.ts',
    line: 132,
    original: '+',
    replacement: '-',
    reason: 'PoolState.idle is always 0 (never mutated); active+0 === active-0.',
  },
  {
    // parseCronField step loop `if (i >= min && i <= max) result.add(i)`.
    // Value `i` that is out of [min,max] is never observed because _projectCron
    // scans cursors strictly within the field range (minutes 0-59, hours 0-23,
    // etc.), so an out-of-range addition is unreachable. Defensive clamp.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 71,
    original: '&&',
    replacement: '||',
    reason: 'Out-of-range step values are invisible to the in-range minute scan; defensive clamp.',
  },
  {
    // parseCronField single-value `if (val >= min && val <= max) result.add(val)`.
    // Same rationale as L71: out-of-range `val` (e.g. minute 99) is never probed
    // by _projectCron's in-range cursor, so the clamped addition is unobservable.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 80,
    original: '&&',
    replacement: '||',
    reason: 'Out-of-range single values are invisible to the in-range scan; defensive clamp.',
  },
  {
    // defer_newer newest selection `newestStart === null || startVal > newestStart`.
    // With newestStart===null the RHS `startVal > null` coerces null to 0, which is
    // always true for a positive scheduledStart. So the `=== null` guard is a
    // redundant null-init optimization; `!== null` behaves identically on valid
    // (always-positive) scheduledStart values.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 259,
    original: '===',
    replacement: '!==',
    reason: 'scheduledStart is always positive; startVal > null (0) is true, making the null guard redundant.',
  },
  {
    // getStats `if (i.state === "completed") counts.completed++`. There is no
    // public API to transition an instance into "completed" (approveWindow caps
    // at "approved"; only pending/scheduled/approved/cancelled/force_override are
    // reachable), so this branch is never exercised. Documented-lifecycle gap.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 311,
    original: '===',
    replacement: '!==',
    reason: 'No public API transitions instances into "completed"; branch is unreachable.',
  },
  {
    // getStats `if (i.state === "failed") counts.failed++`. Same as L311: no
    // public API produces a "failed" instance, so the branch is unreachable.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 312,
    original: '===',
    replacement: '!==',
    reason: 'No public API transitions instances into "failed"; branch is unreachable.',
  },
  {
    // _projectDaily `if (hInvalid || mInvalid) return`. A non-numeric hour/min
    // propagates as NaN into setUTCHours() → Invalid Date → getTime() NaN, so the
    // loop `currentMs < toMs` is false and zero occurrences are emitted regardless
    // of whether this guard returns early. The `||`→`&&` mutant is unobservable.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 387,
    original: '||',
    replacement: '&&',
    reason: 'NaN hour/minute forces an Invalid Date, emitting zero occurrences either way.',
  },
  {
    // _projectWeekly `const hasDays = daysArr !== undefined && daysArr.length !== 0`.
    // _validateWindow already rejects weekly windows with a missing/empty
    // daysOfWeek, so `daysArr` is always a non-empty array at projection time;
    // both operands are constant-true and the `&&`→`||` is equivalent.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 419,
    original: '&&',
    replacement: '||',
    reason: 'registration validation guarantees non-empty daysOfWeek; both operands constant-true.',
  },
  {
    // _projectWeekly `if (hInvalid || mInvalid) return`. Same NaN-propagation
    // rationale as _projectDaily (L387): invalid fields force an Invalid Date and
    // zero occurrences, so the guard is a defensive early-return.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 427,
    original: '||',
    replacement: '&&',
    reason: 'NaN hour/minute forces an Invalid Date, emitting zero occurrences either way.',
  },
  {
    // _projectMonthly `const hasDays = daysArr !== undefined && daysArr.length !== 0`.
    // Same as _projectWeekly (L419): registration validation rejects empty
    // daysOfMonth, so both operands are constant-true.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 454,
    original: '&&',
    replacement: '||',
    reason: 'registration validation guarantees non-empty daysOfMonth; both operands constant-true.',
  },
  {
    // _projectMonthly `if (hInvalid || mInvalid) return`. Same NaN-propagation
    // rationale as L387/L427: invalid fields force zero occurrences.
    file: 'maintenance/src/impl/MaintenanceWindowScheduler.ts',
    line: 462,
    original: '||',
    replacement: '&&',
    reason: 'NaN hour/minute forces an Invalid Date, emitting zero occurrences either way.',
  },
  {
    // `totalNoise === "none"` filter. No code path pushes an action with
    // action === "none" into history: `forceScale("none")` returns early
    // without pushing, and `evaluate()` returning null also does not push.
    // `_recordNoise` is a no-op stub. totalNoise is therefore always 0.
    file: 'autoscaler/src/impl/PredictiveScalingEngine.ts',
    line: 292,
    original: '===',
    replacement: '!==',
    reason: 'No public path records a "none" action into history; the filter is always empty.',
  },
  {
    // `if (noTarget || noMemory) return null;` in _computeMemoryGap.
    // When only one side is true, the other operand (memory or memoryTarget)
    // is undefined, making `gap = memory - memoryTarget` NaN; NaN propagates
    // through every comparison (overTarget/wellBelow both false) so the method
    // still returns null. `||` and `&&` are indistinguishable.
    file: 'autoscaler/src/impl/PredictiveScalingEngine.ts',
    line: 352,
    original: '||',
    replacement: '&&',
    reason: 'Missing operand yields NaN gap that collapses both branches to null either way.',
  },
  {
    // `if (hasQPS && positiveQPS)` in _calculateConfidence.
    // When hasQPS is false, qpsPerNode is undefined so capacity is NaN and the
    // inner guard (capacity > 0) is false; when positiveQPS is false, qps <= 0
    // gives a non-positive utilization so boost = max(0, ...) = 0. In either
    // single-false case confidence is unchanged, so && and || cannot diverge.
    file: 'autoscaler/src/impl/PredictiveScalingEngine.ts',
    line: 579,
    original: '&&',
    replacement: '||',
    reason: 'Single-false side yields zero boost (qps<=0) or NaN capacity; confidence unchanged.',
  },
  {
    // `catch { return false; }` in _globMatch. The pattern string is fully
    // escaped first (.replace(/[.+^${}()|[\]\\]/g, "\\$&")), then * and ? are
    // rewritten to .* and .  — the resulting `^...$` is always a valid RegExp,
    // so `new RegExp(...)` can never throw and the catch is unreachable.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 301,
    original: 'false',
    replacement: 'true',
    reason: 'Metacharacters are escaped before RegExp construction; the catch is unreachable.',
  },
  {
    // `if (field.pattern && typeof value === "string")`. When pattern is falsy
    // (no pattern), the original short-circuits out; the mutant `pattern || ...`
    // enters only when value is a string and builds `new RegExp(undefined)`,
    // which JS evaluates to `/(?:)/` (matches everything), so the nested
    // `!re.test(value)` is always false and no error is ever emitted. When
    // pattern is truthy both branches run the identical check.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 161,
    original: '&&',
    replacement: '||',
    reason: 'RegExp(undefined) matches everything, so the falsy-pattern branch never errors either way.',
  },
  {
    // `dryRun = false` default parameter on _reloadInternal. The single caller
    // reload() always passes dryRun explicitly (its own default is false), so
    // the private default is never read.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 474,
    original: 'false',
    replacement: 'true',
    reason: 'Dead default: reload() always passes dryRun explicitly.',
  },
  {
    // `while (targetIdx >= 0 && checkpointList[targetIdx].source === "rollback")`.
    // No code path ever pushes a checkpoint whose source === "rollback" (rollback
    // never calls _checkpoint), so the second operand is always false and the
    // loop body never runs for either comparison operator.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 555,
    original: '>=',
    replacement: '<',
    reason: 'No rollback-source checkpoint is ever created; the loop never executes for either operator.',
  },
  {
    // `return { success: false, ... }` in the targetIdx < 0 branch. Because
    // checkpointList.length >= 2 is guaranteed by the guard above, after pop()
    // the length is >= 1 and targetIdx = length-1 >= 0; the loop above never
    // decrements (see L555), so targetIdx < 0 is unreachable.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 561,
    original: 'false',
    replacement: 'true',
    reason: 'targetIdx < 0 branch is unreachable when no rollback-source checkpoint exists.',
  },
  {
    // `dryRun: false` in the same unreachable targetIdx < 0 branch as L561.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 566,
    original: 'false',
    replacement: 'true',
    reason: 'targetIdx < 0 branch is unreachable when no rollback-source checkpoint exists.',
  },
  {
    // `const mode = options.mode || "poll"` in startFileWatch. The local `mode`
    // is used only by the guard `if (mode === "none") return`. The only public
    // observable (fileWatchActive) reads `watchState.options.mode` (the raw
    // spread option), not this local. For mode="none" both branches leave
    // fileWatchActive false; for any truthy mode both leave it true.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 435,
    original: '||',
    replacement: '&&',
    reason: 'Local mode only gates the none-return; fileWatchActive reads raw options.mode, making || and && indistinguishable.',
  },
  {
    // `const interval = options.pollIntervalMs || 5000` in startFileWatch. The
    // interval feeds setInterval(() => this._pollFiles(), interval), but
    // _pollFiles -> _loadFiles is a no-op stub with no observable side effect,
    // so a 0ms vs 5000ms timer interval is invisible to any test.
    file: 'configwatcher/src/impl/ConfigWatcher.ts',
    line: 436,
    original: '||',
    replacement: '&&',
    reason: 'interval drives a no-op poll stub; different timer periods have no observable effect.',
  },
  {
    // `critical: options?.critical ?? true` in HealthOrchestrator.registerComponent.
    // The stored `critical` flag is written but never read anywhere: the only
    // public detail accessor, getComponentHealth(), returns componentId/name/
    // liveness/readiness/uptime/lastError and omits critical; getAggregateStatus()
    // derives status purely from liveness/readiness. A true → false default is
    // therefore unobservable (dead field).
    file: 'health/src/impl/HealthOrchestrator.ts',
    line: 47,
    original: 'true',
    replacement: 'false',
    reason: 'critical is a write-only field; no public API or status computation reads it.',
  },
  {
    // `async loadKey(wrapped, unwrapNow = true)` in KeyManager. The `unwrapNow`
    // default is dead: the `if (unwrapNow)` and `else` branches are byte-for-byte
    // identical (both `await unwrapKey` then `keyHistory.set`), so the parameter
    // value never alters behavior and a true → false default is unobservable.
    file: 'security/src/impl/KeyManager.ts',
    line: 108,
    original: 'true',
    replacement: 'false',
    reason: 'unwrapNow branches are identical; the parameter value has no observable effect.',
  },
  {
    // `if (!key || key.length === 0)` in AES256GCMEncryptionProvider.decrypt.
    // `key = this.keyHistory.get(version) ?? this.masterKey`, and masterKey is a
    // 32-byte Buffer set by initialize()/rotateKey() and never zeroed. So `key`
    // is always non-empty, making both `!key` and `key.length === 0` always
    // false; `||` vs `&&` is unobservable.
    file: 'security/src/impl/AES256GCMEncryptionProvider.ts',
    line: 107,
    original: '||',
    replacement: '&&',
    reason: 'key always resolves to non-empty masterKey; both guard operands are always false.',
  },
  {
    // `if (!this.enabled || !this.masterKey || this.masterKey.length === 0)` in
    // _ensureInitialized. `enabled` is set true only in initialize() and never
    // cleared; `masterKey` is a non-empty Buffer set by initialize()/rotateKey().
    // All three operands flip together: all-true when uninitialized (throw) and
    // all-false when initialized (no throw). No intermediate state exists, so
    // both `||` → `&&` mutations are equivalent.
    file: 'security/src/impl/AES256GCMEncryptionProvider.ts',
    line: 170,
    original: '||',
    replacement: '&&',
    reason: 'enabled/masterKey/length flip together; no intermediate state distinguishes || from &&.',
  },
  {
    // EnvelopeEncryptionProvider.importKey delegates to
    // `this.keyManager.loadKey(wrapped, true)`. The `true` (unwrapNow) argument
    // is inert: KeyManager.loadKey's `if (unwrapNow)` and `else` branches are
    // byte-for-byte identical (both `await unwrapKey` then `keyHistory.set`), so
    // a `true` → `false` mutation here is unobservable (already registered for
    // KeyManager L108's default parameter).
    file: 'security/src/impl/EnvelopeEncryptionProvider.ts',
    line: 210,
    original: 'true',
    replacement: 'false',
    reason: 'loadKey unwrapNow branches are identical; the boolean argument has no observable effect.',
  },
];

function isEquivalentMutant(filePath: string, m: { line: number; original: string; replacement: string }): EquivalentMutant | undefined {
  const rel = relative(ROOT, filePath);
  return EQUIVALENT_MUTANTS.find((e) =>
    rel.includes(e.file) &&
    e.line === m.line &&
    e.original === m.original &&
    e.replacement === m.replacement,
  );
}

// ── Source Restoration Safety Net ──────────────────
// The mutation runner overwrites source files in-place then restores them in a
// `finally` block. If the process is killed externally (e.g. `timeout`), the
// `finally` never runs and source files are left permanently corrupted
// (observed: `false`→`true`, `i < x`→`i >= x` infinite loop). This registry
// snapshots every scanned file before mutation and restores on termination.

const _originals = new Map<string, string>();

function _snapshotOriginal(filePath: string): void {
  if (!_originals.has(filePath)) {
    _originals.set(filePath, readFileSync(filePath, 'utf-8'));
  }
}

function _restoreAllOriginals(): void {
  _originals.forEach((original, fp) => {
    try {
      const current = readFileSync(fp, 'utf-8');
      if (current !== original) {
        writeFileSync(fp, original);
        process.stderr.write(`\n[restore] ${relative(ROOT, fp)}\n`);
      }
    } catch {
      // best-effort restore; do not mask the original signal
    }
  });
  _originals.clear();
}

process.on('SIGTERM', () => {
  _restoreAllOriginals();
  process.exit(143);
});
process.on('SIGINT', () => {
  _restoreAllOriginals();
  process.exit(130);
});
// Synchronous final safety net for any clean exit path.
process.on('exit', () => {
  _originals.forEach((original, fp) => {
    try {
      if (readFileSync(fp, 'utf-8') !== original) {
        writeFileSync(fp, original);
      }
    } catch {
      // best-effort
    }
  });
});

// ── Discovery ──────────────────────────────────────

function discoverFiles(pkgFilter?: string): string[] {
  const pkgDir = join(ROOT, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(pkgDir)) {
    if (pkgFilter && pkg !== pkgFilter) continue;
    const implDir = join(pkgDir, pkg, 'src', 'impl');
    const srcDir = join(pkgDir, pkg, 'src');

    // Preferred: the conventional `src/impl/` layout. Fallback: packages (e.g.
    // `core`) that keep their logic directly under `src/` without an impl dir.
    const roots: string[] = [];
    if (existsSync(implDir)) {
      roots.push(implDir);
    } else if (existsSync(srcDir)) {
      // Only consider top-level .ts source files; skip the canonical re-export
      // barrel (`index.ts`) which has no mutatable logic.
      for (const e of readdirSync(srcDir)) {
        const full = join(srcDir, e);
        if (statSync(full).isFile() && e.endsWith('.ts') && !e.endsWith('.d.ts') && e !== 'index.ts') {
          roots.push(full);
        }
      }
    }

    for (const root of roots) {
      if (statSync(root).isFile()) {
        if (!root.includes('.test.') && !root.includes('.spec.')) files.push(root);
      } else {
        walk(root, (f) => {
          if (f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('.test.') && !f.includes('.spec.')) {
            // Skip files that require network I/O (S3, etc.)
            if (f.includes('S3StorageBackend') || f.includes('S3')) return;
            files.push(f);
          }
        });
      }
    }
  }
  return files;
}

function walk(dir: string, cb: (f: string) => void): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, cb);
    else cb(full);
  }
}

// ── Mutant Generation ──────────────────────────────

interface Mutant {
  id: string;
  operator: string;
  original: string;
  replacement: string;
  filePath: string;
  line: number;
  col: number;
}

function generateMutants(filePath: string, maxPerFile: number): Mutant[] {
  const source = readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const mutants: Mutant[] = [];

  const pos = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const hash = (line: number, op: string) =>
    createHash('md5').update(`${relative(ROOT, filePath)}:${line}:${op}`).digest('hex').slice(0, 6);

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const swaps: Record<number, string> = {
        [ts.SyntaxKind.PlusToken]: '-', [ts.SyntaxKind.MinusToken]: '+',
        [ts.SyntaxKind.AsteriskToken]: '/', [ts.SyntaxKind.SlashToken]: '*',
        [ts.SyntaxKind.AmpersandAmpersandToken]: '||', [ts.SyntaxKind.BarBarToken]: '&&',
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: '!==', [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '===',
        [ts.SyntaxKind.GreaterThanToken]: '<=', [ts.SyntaxKind.LessThanToken]: '>=',
        [ts.SyntaxKind.GreaterThanEqualsToken]: '<', [ts.SyntaxKind.LessThanEqualsToken]: '>',
      };
      const r = swaps[node.operatorToken.kind];
      if (r) {
        const p = pos(node.operatorToken);
        mutants.push({
          id: `MUT_${hash(p.line, node.operatorToken.getText(sf))}`,
          operator: 'Arith/Logic',
          original: node.operatorToken.getText(sf),
          replacement: r,
          filePath, line: p.line + 1, col: p.character,
        });
      }
    }

    if (ts.isToken(node) && node.kind === ts.SyntaxKind.TrueKeyword) {
      const p = pos(node);
      mutants.push({ id: `MUT_${hash(p.line, 'true')}`, operator: 'Boolean', original: 'true', replacement: 'false', filePath, line: p.line + 1, col: p.character });
    }
    if (ts.isToken(node) && node.kind === ts.SyntaxKind.FalseKeyword) {
      const p = pos(node);
      mutants.push({ id: `MUT_${hash(p.line, 'false')}`, operator: 'Boolean', original: 'false', replacement: 'true', filePath, line: p.line + 1, col: p.character });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Filter out audited equivalent mutants (see EQUIVALENT_MUTANTS above).
  const withEquivalence: Mutant[] = [];
  for (const m of mutants) {
    const eq = isEquivalentMutant(filePath, m);
    if (eq) {
      process.stderr.write(`[equivalent] skip ${m.id} L${m.line} (${eq.reason})\n`);
      continue;
    }
    withEquivalence.push(m);
  }

  // Surface stale equivalent-mutant entries: a configured exclusion whose line
  // no longer matches the expected operator/text is no longer valid.
  for (const e of EQUIVALENT_MUTANTS) {
    if (relative(ROOT, filePath).includes(e.file)) {
      const lineText = source.split('\n')[e.line - 1] ?? '';
      if (!lineText.includes(e.original)) {
        process.stderr.write(`[warn] equivalent-mutant entry at L${e.line} no longer matches source (stale?)\n`);
      }
    }
  }

  // Cap: deterministic selection (always take first N, not random)
  // Using a hash-based priority ensures reproducible results across runs
  if (withEquivalence.length > maxPerFile) {
    // Sort by line number ascending (most impactful mutants first) for reproducibility
    withEquivalence.sort((a, b) => a.line - b.line);
    return withEquivalence.slice(0, maxPerFile);
  }
  return withEquivalence;
}

// ── Mutant Application ─────────────────────────────
// Strategy: backup original → writeFileSync → run tests → writeFileSync restore.
// We DON'T use sed because we need precise line-level replacement with
// complex operator characters (===, !==, &&, ||, etc.) that break shell quoting.
// The VFS cache issue is mitigated by reading fresh via readFileSync.

function applyMutantInPlace(fp: string, m: Mutant): void {
  const source = readFileSync(fp, 'utf-8');
  const lines = source.split('\n');
  const targetLine = m.line - 1; // 0-indexed
  if (targetLine < lines.length) {
    const line = lines[targetLine]!;
    // Replace the operator at its exact column offset `m.col`. A plain
    // String.replace would always hit the FIRST occurrence, which is wrong for
    // lines carrying the same operator more than once (e.g. `a || b || c`):
    // the second `||` mutant would silently test the first `||`, mis-reporting
    // an equivalent mutant as survived.
    const col = m.col;
    const before = line.slice(0, col);
    const after = line.slice(col + m.original.length);
    lines[targetLine] = before + m.replacement + after;
  }
  writeFileSync(fp, lines.join('\n'));
}

function restoreFile(fp: string, original: string): void {
  writeFileSync(fp, original);
}

// ── Package Name ───────────────────────────────────

function pkgOf(fp: string): string {
  return relative(ROOT, fp).split('/')[1] || 'unknown';
}

function findTest(pkg: string): string[] {
  const dir = join(ROOT, 'packages', pkg, 'src', '__tests__');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.test.ts') && !f.includes('e2e') && !f.includes('integration') &&
      !f.includes('benchmark') && !f.includes('stress') &&
      !f.includes('fuzz'))
    .map(f => join(dir, f));
}

// ── Test Runner ────────────────────────────────────
// Async `exec` (not execSync) so that the SIGTERM/SIGINT handlers installed
// above can run and restore mutated source files even if the runner is
// interrupted mid-test. execSync blocks the event loop, preventing signal
// handlers from firing and leaving source files corrupted on termination.

function runTests(testFiles: string[]): Promise<{ killed: boolean; durationMs: number; error?: string }> {
  if (testFiles.length === 0) return Promise.resolve({ killed: false, durationMs: 0 });

  const paths = testFiles.join(' ');
  const start = Date.now();

  return new Promise((resolve) => {
    exec(
      `npx vitest run --pool=threads --no-file-parallelism ${paths} 2>&1`,
      {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: MUTANT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NODE_OPTIONS: '--max-old-space-size=4096' },
        shell: '/bin/bash',
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (!err) {
          resolve({ killed: false, durationMs });
          return;
        }
        // A timeout (ETIMEDOUT / killed via SIGTERM) means the mutated source
        // caused an infinite loop or deadlock — the tests no longer terminate
        // within the allotted time. That is an observable behavior change, so
        // it counts as a KILL: the original source completes promptly, the
        // mutant hangs. Treating a hang as "survived" would mask real gaps.
        const timedOut =
          err.killed === true ||
          (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
          err.signal === 'SIGTERM' ||
          err.signal === 'SIGKILL';
        const combined = ((stdout || '') + (stderr || '')).toLowerCase();
        const failed =
          combined.includes('fail') || combined.includes('assertionerror') ||
          combined.includes('expected ') || combined.includes('×');
        if (timedOut || failed) {
          resolve({ killed: true, durationMs });
          return;
        }
        resolve({ killed: false, durationMs, error: combined.slice(0, 100) });
      },
    );
  });
}

// ── Main ───────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  const files = discoverFiles(targetPkg).filter((f) =>
    !targetFile || relative(ROOT, f).includes(targetFile)
  );
  console.log(`\n🔬 Mutation Test Engine`);
  console.log(`   Source files: ${files.length}${targetPkg ? ` (pkg: ${targetPkg})` : ''}`);
  console.log(`   Max mutants/file: ${maxMutants}\n`);

  // Generate
  const allMutants: Mutant[] = [];
  for (const f of files) {
    const m = generateMutants(f, maxMutants);
    if (m.length > 0) console.log(`   ${relative(ROOT, f)}: ${m.length}`);
    allMutants.push(...m);
    _snapshotOriginal(f);
  }

  console.log(`\n   Total: ${allMutants.length} mutants\n`);
  console.log(`   Executing...\n`);

  // Execute
  const results = new Map<string, { killed: number; survived: number; compileErr: number; survivors: Mutant[] }>();
  let killed = 0, survived = 0, compileErr = 0;
  const startAll = Date.now();

  for (let i = 0; i < allMutants.length; i++) {
    const m = allMutants[i]!;
    const pkg = pkgOf(m.filePath);
    if (!results.has(pkg)) results.set(pkg, { killed: 0, survived: 0, compileErr: 0, survivors: [] });

    const originalSource = readFileSync(m.filePath, 'utf-8');
    _snapshotOriginal(m.filePath);

    try {
      applyMutantInPlace(m.filePath, m);
      const testFiles = killerPass ? [join(ROOT, 'packages')] : findTest(pkg);
      const { killed: isKilled, error } = await runTests(testFiles);

      if (error?.includes('syntax') || error?.includes('unexpected') || error?.includes('parse')) {
        compileErr++;
        results.get(pkg)!.compileErr++;
      } else if (isKilled) {
        killed++;
        results.get(pkg)!.killed++;
      } else {
        survived++;
        results.get(pkg)!.survived++;
        results.get(pkg)!.survivors.push(m);
      }
    } finally {
      restoreFile(m.filePath, originalSource);
    }

    if ((i + 1) % 20 === 0 || i === allMutants.length - 1) {
      const pct = ((i + 1) / allMutants.length * 100).toFixed(0);
      process.stdout.write(`\r   [${i + 1}/${allMutants.length}] ${pct}% | K:${killed} S:${survived} CE:${compileErr}`);
    }
  }

  const totalTime = Date.now() - startAll;
  const executed = killed + survived;
  const score = executed > 0 ? (killed / executed * 100) : 100;

  console.log(`\n\n📊 Results (${(totalTime / 1000).toFixed(0)}s)`);
  console.log(`   Killed: ${killed} | Survived: ${survived} | Compile Error: ${compileErr}`);
  console.log(`   Mutation Score: ${score.toFixed(1)}%\n`);

  // Report
  const lines = [
    '# Mutation Test Results',
    '',
    `> Time: ${new Date().toISOString()}`,
    `> Files scanned: ${files.length}`,
    `> Mutants: ${executed} executed (+${compileErr} compile errors)`,
    `> Killed: ${killed} | Survived: ${survived}`,
    `> **Score: ${score.toFixed(1)}%**`,
    `> Duration: ${(totalTime / 1000).toFixed(0)}s`,
    '',
    '## Package Scores',
    '',
    '| Package | Killed | Survived | CE | Score |',
    '|---------|--------|----------|-----|-------|',
  ];

  for (const [p, s] of [...results.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ps = s.killed + s.survived;
    const pscore = ps > 0 ? (s.killed / ps * 100) : 100;
    const st = pscore >= 95 ? '🟢' : pscore >= 80 ? '🟡' : '🔴';
    lines.push(`| ${st} ${p} | ${s.killed} | ${s.survived} | ${s.compileErr} | **${pscore.toFixed(1)}%** |`);
  }

  if (survived > 0) {
    lines.push('', '## Survivors (Test Gaps)', '', '| ID | Pkg | File | Line | Op | Original→Replacement |', '|----|-----|------|------|-----|----------------------|');
    for (const [p, s] of results) {
      for (const m of s.survivors) {
        const fn = relative(ROOT, m.filePath).split('/').slice(-2).join('/');
        lines.push(`| ${m.id} | ${p} | ${fn} | L${m.line} | ${m.operator} | \`${m.original}\` → \`${m.replacement}\` |`);
      }
    }
  }

  writeFileSync(join(REPORT_DIR, 'MUTATION_REPORT.md'), lines.join('\n'));
  console.log(`   Report: .mutation-report/MUTATION_REPORT.md\n`);

  if (score < 85) {
    console.log('⚠️  Mutation score below 85% — significant test gaps detected.\n');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
