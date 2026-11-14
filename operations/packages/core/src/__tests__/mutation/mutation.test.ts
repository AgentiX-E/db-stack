/**
 * Mutation Test Runner — vitest-native integration.
 *
 * This test file orchestrates the mutation test engine within vitest.
 * It's designed to be run as a focused test suite:
 *
 *   npx vitest run packages/core/src/__tests__/mutation/mutation.test.ts
 *
 * Strategy:
 *   - Mutate source files in packages/{asterisk}/src/impl/
 *   - For each mutant: run only the package's dedicated test file
 *   - This is ~50x faster than full suite re-run but catches most survivors
 *   - After initial pass, run full suite only for priority packages
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';

// ── Configuration ──────────────────────────────────

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const REPORT_DIR = join(ROOT, '.mutation-report');
const TIMEOUT_PER_MUTANT_MS = 30_000;
const MAX_MUTANTS_PER_PACKAGE = 80; // cap per package for CI viability

// ── Types ──────────────────────────────────────────

interface Mutant {
  id: string;
  operator: string;
  original: string;
  replacement: string;
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  nodeKind: string;
}

interface MutantResult {
  mutant: Mutant;
  status: 'killed' | 'survived' | 'timeout' | 'compileError';
  durationMs: number;
}

// ── Source Discovery ───────────────────────────────

function discoverImplFiles(): string[] {
  const pkgDir = join(ROOT, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(pkgDir)) {
    const implDir = join(pkgDir, pkg, 'src', 'impl');
    if (!existsSync(implDir)) continue;
    walkSync(implDir, (file) => {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')) {
        files.push(file);
      }
    });
  }
  return files;
}

function walkSync(dir: string, cb: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSync(full, cb);
    else cb(full);
  }
}

// ── Mutant Generation ──────────────────────────────

function makeId(filePath: string, line: number, op: string): string {
  const hash = createHash('md5').update(`${relative(ROOT, filePath)}:${line}:${op}`).digest('hex').slice(0, 6);
  return `MUT_${hash}`;
}

function generateMutants(filePath: string): Mutant[] {
  const source = readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const mutants: Mutant[] = [];

  function loc(node: ts.Node): { line: number; character: number; endLine: number; endCharacter: number } {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    return { line: start.line + 1, character: start.character, endLine: end.line + 1, endCharacter: end.character };
  }

  function visit(node: ts.Node): void {
    // Binary expressions — arithmetic & logical
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      const swaps: Record<number, string> = {
        [ts.SyntaxKind.PlusToken]: '-',
        [ts.SyntaxKind.MinusToken]: '+',
        [ts.SyntaxKind.AsteriskToken]: '/',
        [ts.SyntaxKind.SlashToken]: '*',
        [ts.SyntaxKind.PercentToken]: '*',
        [ts.SyntaxKind.AmpersandAmpersandToken]: '||',
        [ts.SyntaxKind.BarBarToken]: '&&',
        [ts.SyntaxKind.EqualsEqualsToken]: '!=',
        [ts.SyntaxKind.ExclamationEqualsToken]: '==',
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: '!==',
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '===',
        [ts.SyntaxKind.GreaterThanToken]: '<=',
        [ts.SyntaxKind.GreaterThanEqualsToken]: '<',
        [ts.SyntaxKind.LessThanToken]: '>=',
        [ts.SyntaxKind.LessThanEqualsToken]: '>',
      };
      const repl = swaps[opKind];
      if (repl) {
        const l = loc(node.operatorToken);
        mutants.push({
          id: makeId(filePath, l.line, 'Logical/Arithmetic'),
          operator: opKind === ts.SyntaxKind.PlusToken || opKind === ts.SyntaxKind.MinusToken || opKind === ts.SyntaxKind.AsteriskToken || opKind === ts.SyntaxKind.SlashToken || opKind === ts.SyntaxKind.PercentToken ? 'Arithmetic' : 'Logical',
          original: node.operatorToken.getText(sf),
          replacement: repl,
          filePath, ...l,
          nodeKind: ts.SyntaxKind[node.kind],
        });
      }
    }

    // Boolean literals
    if (ts.isToken(node)) {
      if (node.kind === ts.SyntaxKind.TrueKeyword) {
        const l = loc(node);
        mutants.push({ id: makeId(filePath, l.line, 'Boolean'), operator: 'Boolean', original: 'true', replacement: 'false', filePath, ...l, nodeKind: 'TrueKeyword' });
      } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
        const l = loc(node);
        mutants.push({ id: makeId(filePath, l.line, 'Boolean'), operator: 'Boolean', original: 'false', replacement: 'true', filePath, ...l, nodeKind: 'FalseKeyword' });
      }
    }

    // Negation: !expr removal
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const l = loc(node);
      mutants.push({ id: makeId(filePath, l.line, 'Negation'), operator: 'Negation', original: node.getText(sf), replacement: node.operand.getText(sf), filePath, ...l, nodeKind: 'PrefixUnaryExpression' });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Cap per file
  const sampled = mutants.length > MAX_MUTANTS_PER_PACKAGE
    ? [...mutants].sort(() => Math.random() - 0.5).slice(0, MAX_MUTANTS_PER_PACKAGE)
    : mutants;

  return sampled;
}

function applyMutant(source: string, m: Mutant): string {
  const lines = source.split('\n');
  const lineIdx = m.line - 1;
  const before = lines[lineIdx]!.slice(0, m.character);
  const after = lines[lineIdx]!.slice(m.endCharacter);

  // For negation: the original includes entire !expr, replacement is expr without !
  // Just strip the ! prefix
  if (m.operator === 'Negation' && lines[lineIdx]!.slice(m.character).startsWith('!')) {
    lines[lineIdx] = before + lines[lineIdx]!.slice(m.character + 1);
    return lines.join('\n');
  }

  lines[lineIdx] = before + m.replacement + after;
  return lines.join('\n');
}

// ── Test Execution ─────────────────────────────────

function extractPackageName(fp: string): string {
  const match = relative(ROOT, fp).match(/^packages\/([^/]+)/);
  return match ? match[1]! : 'unknown';
}

function findTestFile(pkgName: string): string | null {
  const testDir = join(ROOT, 'packages', pkgName, 'src', '__tests__');
  if (!existsSync(testDir)) return null;

  // Prefer package-specific test files, avoid e2e/integration/mutation/stress
  const files = readdirSync(testDir);
  const preferred = files
    .filter(f => f.endsWith('.test.ts') && !f.includes('e2e') && !f.includes('integration') &&
      !f.includes('mutation') && !f.includes('benchmark') && !f.includes('stress') && !f.includes('fuzz') && !f.includes('chaos'))
    .sort((a, b) => a.length - b.length); // shortest first = main test file

  if (preferred.length > 0) {
    return join(testDir, preferred[0]!);
  }

  // Fallback: any test file
  const any = files.filter(f => f.endsWith('.test.ts'));
  return any.length > 0 ? join(testDir, any[0]!) : null;
}

function runPkgTests(testFiles: string[]): { ok: boolean; durationMs: number; error?: string } {
  if (testFiles.length === 0) {
    return { ok: true, durationMs: 0 }; // no test file = can't kill mutant = consider "ok" (survived)
  }

  const start = Date.now();
  try {
    const paths = testFiles.join(' ');
    execSync(`npx vitest run ${paths} --reporter=json 2>/dev/null || true`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: TIMEOUT_PER_MUTANT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    return { ok: true, durationMs: Date.now() - start };
  } catch (err: any) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';

    // Test failures → mutant killed (GOOD)
    if (stderr.includes('FAIL') || stdout.includes('FAIL') ||
      stderr.includes('failed') || stdout.includes('failed') ||
      stderr.includes('AssertionError') || stdout.includes('AssertionError')) {
      return { ok: false, durationMs: Date.now() - start };
    }

    // Compile error or syntax error
    if (stderr.includes('SyntaxError') || stderr.includes('parse') || stderr.includes('unexpected token')) {
      return { ok: true, durationMs: Date.now() - start, error: 'compileError' };
    }

    // Unknown error
    return { ok: true, durationMs: Date.now() - start, error: stderr.slice(0, 200) };
  }
}

// ── Main Test Suite ─────────────────────────────────

/**
 * Mutation testing is opt-in.
 *
 * The harness rewrites product source files in place, spawns a vitest run per
 * mutant and restores the file afterwards — up to 500 mutants x 30s. That is
 * incompatible with a pull-request gate (hours of wall clock, and an
 * interrupted run leaves mutated sources on disk). It runs from the scheduled
 * `mutation` workflow, or locally with:
 *
 *   MUTATION=1 pnpm --filter ./operations run test:mutation
 */
const MUTATION_ENABLED = process.env.MUTATION === '1' || process.env.MUTATION === 'true';

describe.skipIf(!MUTATION_ENABLED)('MUT: Mutation Test Suite', () => {
  const report: {
    totalMutants: number;
    killed: number;
    survived: number;
    compileError: number;
    byPackage: Map<string, { generated: number; killed: number; survived: number; compileError: number; survivors: Mutant[] }>;
  } = {
    totalMutants: 0,
    killed: 0,
    survived: 0,
    compileError: 0,
    byPackage: new Map(),
  };

  // Discover source files
  const implFiles = discoverImplFiles();
  console.error(`\n🔬 Mutation Test Engine`);
  console.error(`   Source files: ${implFiles.length}`);

  // For each source file, generate mutants
  const allMutants: Mutant[] = [];
  for (const file of implFiles) {
    const mutants = generateMutants(file);
    const rel = relative(ROOT, file);
    if (mutants.length > 0) console.error(`   ${rel}: ${mutants.length} mutants`);
    allMutants.push(...mutants);
  }

  console.error(`\n   Total mutants: ${allMutants.length}`);

  it(`MUT_SCAN: found ${allMutants.length} mutations across ${implFiles.length} source files`, () => {
    expect(allMutants.length).toBeGreaterThan(0);

    // Show distribution
    const dist = new Map<string, number>();
    for (const m of allMutants) {
      dist.set(m.operator, (dist.get(m.operator) || 0) + 1);
    }
    for (const [op, count] of dist) {
      console.error(`     ${op}: ${count}`);
    }
  });

  // Execute mutants — one test per mutant
  // We group by file to batch restore operations
  const mutantsByFile = new Map<string, Mutant[]>();
  for (const m of allMutants.slice(0, 500)) { // cap total runtime ~15-20 min
    const list = mutantsByFile.get(m.filePath) || [];
    list.push(m);
    mutantsByFile.set(m.filePath, list);
  }

  report.totalMutants = allMutants.slice(0, 500).length;

  for (const [filePath, mutants] of mutantsByFile) {
    const pkgName = extractPackageName(filePath);
    if (!report.byPackage.has(pkgName)) {
      report.byPackage.set(pkgName, { generated: 0, killed: 0, survived: 0, compileError: 0, survivors: [] });
    }
    const pkgStats = report.byPackage.get(pkgName)!;

    for (const mutant of mutants) {
      pkgStats.generated++;

      const testName = `${mutant.id}: ${mutant.operator} ${mutant.original}→${mutant.replacement} @ L${mutant.line}`;

      it(testName, async () => {
        const originalSource = readFileSync(filePath, 'utf-8');
        const mutatedSource = applyMutant(originalSource, mutant);

        // Write mutation
        writeFileSync(filePath, mutatedSource);

        let result: MutantResult;
        try {
          const pkgTestFile = findTestFile(pkgName);
          const testFiles = pkgTestFile ? [pkgTestFile] : [];
          const testResult = runPkgTests(testFiles);

          if (testResult.error === 'compileError') {
            result = { mutant, status: 'compileError', durationMs: testResult.durationMs };
          } else if (testResult.ok) {
            result = { mutant, status: 'survived', durationMs: testResult.durationMs };
          } else {
            result = { mutant, status: 'killed', durationMs: testResult.durationMs };
          }
        } catch {
          result = { mutant, status: 'compileError', durationMs: 0 };
        } finally {
          // RESTORE original source
          writeFileSync(filePath, originalSource);
        }

        // Track in report
        if (result.status === 'killed') {
          report.killed++;
          pkgStats.killed++;
        } else if (result.status === 'survived') {
          report.survived++;
          pkgStats.survived++;
          pkgStats.survivors.push(mutant);
        } else {
          report.compileError++;
          pkgStats.compileError++;
        }

        expect(result.status).toBe('killed');
      });
    }
  }

  // Summary test runs last (alphabetically first due to MUT_ prefix for mutants)
  it('MUT_SUMMARY: report', () => {
    // Write report
    if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

    const executed = report.killed + report.survived + report.compileError;
    const score = executed > 0 ? (report.killed / executed * 100) : 0;

    const lines: string[] = [
      '# Mutation Test Results',
      '',
      `> Total mutants executed: ${executed}`,
      `> Killed: ${report.killed} | Survived: ${report.survived} | Compile Error: ${report.compileError}`,
      `> **Mutation Score: ${score.toFixed(2)}%**`,
      '',
      '## Package Scores',
      '',
      '| Package | Gen | Killed | Survived | Comp.Err | Score |',
      '|---------|-----|--------|----------|----------|-------|',
    ];

    for (const [pkg, stats] of [...report.byPackage].sort()) {
      const pkgExec = stats.killed + stats.survived + stats.compileError;
      const pkgScore = pkgExec > 0 ? (stats.killed / pkgExec * 100) : 100;
      const status = pkgScore >= 95 ? '🟢' : pkgScore >= 80 ? '🟡' : '🔴';
      lines.push(`| ${status} ${pkg} | ${stats.generated} | ${stats.killed} | ${stats.survived} | ${stats.compileError} | **${pkgScore.toFixed(1)}%** |`);
    }

    if (report.survived > 0) {
      lines.push('', '## Survivors (Test Gaps)', '', '| ID | Package | Operator | Line | Original |', '|----|---------|----------|------|----------|');
      for (const [pkg, stats] of report.byPackage) {
        for (const s of stats.survivors.slice(0, 10)) {
          lines.push(`| ${s.id} | ${pkg} | ${s.operator} | ${s.line} | \`${s.original}\` |`);
        }
      }
    }

    writeFileSync(join(REPORT_DIR, 'MUTATION_REPORT.md'), lines.join('\n'));
    console.error(`\n   Report: ${join(REPORT_DIR, 'MUTATION_REPORT.md')}`);
  });

  it(`MUT_SCORE: mutation score ≥ 85%`, () => {
    const executed = report.killed + report.survived + report.compileError;
    const score = executed > 0 ? (report.killed / executed * 100) : 0;
    console.error(`\n   Mutation Score: ${score.toFixed(2)}%`);
    console.error(`   Killed: ${report.killed} | Survived: ${report.survived} | Compile Error: ${report.compileError}`);
    expect(score).toBeGreaterThanOrEqual(85);
  });
});
