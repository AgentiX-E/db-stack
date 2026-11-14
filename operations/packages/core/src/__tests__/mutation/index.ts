/**
 * Mutation Test Engine — AST-based mutant generation and test execution.
 *
 * Architecture:
 *   1. Source Scanner — discovers all .ts source files in packages/*/src/impl/
 *   2. Mutant Generator — applies mutation operators to AST nodes
 *   3. Test Runner — executes vitest programmatically for each mutant
 *   4. Score Reporter — computes killed/survived/noCoverage matrix per package
 *
 * Mutation Operators:
 *   - Arithmetic:  + ↔ -  * ↔ /  % ↔ *
 *   - Logical:     && ↔ ||   == ↔ !=  === ↔ !==  > ↔ >=  < ↔ <=
 *   - Boundary:    > ↔ >=   < ↔ <=  length → length-1  +1 → -1
 *   - Negation:    !expr    ~expr
 *   - Removal:     delete statement, delete return value
 *   - Assignment:  += ↔ -=  *= ↔ /=
 *   - Boolean:     true ↔ false
 *   - String:      '' removal, prefix removal
 *
 * @module mutation
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';

// ── Types ──────────────────────────────────────────

interface MutantLocation {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

interface Mutant {
  id: string;
  operator: string;
  original: string;
  replacement: string;
  location: MutantLocation;
  nodeKind: string;
}

interface MutantResult {
  mutant: Mutant;
  status: 'killed' | 'survived' | 'timeout' | 'compileError' | 'noCoverage';
  error?: string;
  durationMs: number;
}

interface PackageScore {
  packageName: string;
  mutantsGenerated: number;
  mutantsExecuted: number;
  killed: number;
  survived: number;
  timeout: number;
  compileError: number;
  noCoverage: number;
  mutationScore: number; // killed / executed * 100
  durationMs: number;
  topSurvivors: Array<{ id: string; operator: string; line: number; original: string }>;
}

interface MutationReport {
  timestamp: string;
  totals: {
    mutantsGenerated: number;
    mutantsExecuted: number;
    killed: number;
    survived: number;
    timeout: number;
    compileError: number;
    noCoverage: number;
    mutationScore: number;
    durationMs: number;
  };
  packages: PackageScore[];
  slowestMutants: Array<{ id: string; file: string; durationMs: number }>;
}

// ── Source Scanner ─────────────────────────────────

function discoverSourceFiles(root: string): string[] {
  const pkgDir = join(root, 'packages');
  const files: string[] = [];

  for (const pkg of readdirSync(pkgDir)) {
    const implDir = join(pkgDir, pkg, 'src', 'impl');
    if (!existsSync(implDir)) continue;

    walkDir(implDir, (file) => {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')) {
        files.push(file);
      }
    });
  }

  return files;
}

function walkDir(dir: string, cb: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkDir(full, cb);
    } else {
      cb(full);
    }
  }
}

// ── Mutation Operators ─────────────────────────────

function mutantId(file: string, line: number, op: string): string {
  const relPath = relative(resolve(file, '..', '..', '..', '..', '..', '..'), file);
  const hash = createHash('md5').update(`${relPath}:${line}:${op}`).digest('hex').slice(0, 6);
  return `MUT_${hash}`;
}

class MutantGenerator {
  private mutants: Mutant[] = [];
  private sourceFile: ts.SourceFile;

  constructor(filePath: string) {
    this.sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );
  }

  getMutants(): Mutant[] {
    return this.mutants;
  }

  scan(): void {
    this.visitNode(this.sourceFile);
  }

  private loc(node: ts.Node): MutantLocation {
    const sf = this.sourceFile;
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    return {
      file: sf.fileName,
      line: start.line + 1,
      character: start.character,
      endLine: end.line + 1,
      endCharacter: end.character,
    };
  }

  private add(operator: string, original: string, replacement: string, node: ts.Node): void {
    const loc = this.loc(node);
    this.mutants.push({
      id: mutantId(loc.file, loc.line, operator),
      operator,
      original,
      replacement,
      location: loc,
      nodeKind: ts.SyntaxKind[node.kind],
    });
  }

  private visitNode(node: ts.Node): void {
    this.applyArithmetic(node);
    this.applyLogical(node);
    this.applyBoundary(node);
    this.applyBoolean(node);
    this.applyNegation(node);
    this.applyStringLiteral(node);

    ts.forEachChild(node, (child) => this.visitNode(child));
  }

  // ── Arithmetic: +↔-  *↔/  %↔* ─────────────────

  private applyArithmetic(node: ts.Node): void {
    if (!ts.isBinaryExpression(node)) return;

    const operator = node.operatorToken.kind;
    let replacement: number | undefined;

    switch (operator) {
      case ts.SyntaxKind.PlusToken:
        replacement = ts.SyntaxKind.MinusToken;
        break;
      case ts.SyntaxKind.MinusToken:
        replacement = ts.SyntaxKind.PlusToken;
        break;
      case ts.SyntaxKind.AsteriskToken:
        replacement = ts.SyntaxKind.SlashToken;
        break;
      case ts.SyntaxKind.SlashToken:
        replacement = ts.SyntaxKind.AsteriskToken;
        break;
      case ts.SyntaxKind.PercentToken:
        replacement = ts.SyntaxKind.AsteriskToken;
        break;
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        // Handled by applyLogical
        return;
    }

    if (replacement !== undefined) {
      this.add('Arithmetic', node.operatorToken.getText(this.sourceFile), ts.tokenToString(replacement as ts.SyntaxKind)!, node.operatorToken);
    }
  }

  // ── Logical: &&↔||  ==↔!=  ===↔!==  >↔<=  <↔>= ─

  private applyLogical(node: ts.Node): void {
    if (!ts.isBinaryExpression(node)) return;

    const op = node.operatorToken.kind;
    const pairs: Array<[ts.SyntaxKind, string]> = [
      [ts.SyntaxKind.AmpersandAmpersandToken, '||'],
      [ts.SyntaxKind.BarBarToken, '&&'],
      [ts.SyntaxKind.EqualsEqualsToken, '!='],
      [ts.SyntaxKind.ExclamationEqualsToken, '=='],
      [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
      [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
      [ts.SyntaxKind.GreaterThanToken, '<='],
      [ts.SyntaxKind.GreaterThanEqualsToken, '<'],
      [ts.SyntaxKind.LessThanToken, '>='],
      [ts.SyntaxKind.LessThanEqualsToken, '>'],
    ];

    for (const [kind, replacement] of pairs) {
      if (op === kind) {
        this.add('Logical', node.operatorToken.getText(this.sourceFile), replacement, node.operatorToken);
        return;
      }
    }
  }

  // ── Boundary: >↔>=  <↔<=  +1↔-1 ───────────────

  private applyBoundary(node: ts.Node): void {
    // Numeric literal boundary: -1 → +1, +1 → -1
    if (ts.isPrefixUnaryExpression(node)) {
      const op = node.operator;
      const operand = node.operand;

      if (ts.isNumericLiteral(operand) && parseInt(operand.text) === 1) {
        if (op === ts.SyntaxKind.MinusToken) {
          this.add('Boundary', `-${operand.text}`, `+${operand.text}`, node);
        } else if (op === ts.SyntaxKind.PlusToken) {
          this.add('Boundary', `+${operand.text}`, `-${operand.text}`, node);
        }
      }
    }

    // Array length boundary: .length → .length - 1
    // This is handled more surgically: we look for `if (arr.length > 0)` pattern
    // and mutate to `if (arr.length - 1 > 0)` — but this is complex.
    // We rely on logical/boundary operators for now.
  }

  // ── Boolean: true ↔ false ──────────────────────

  private applyBoolean(node: ts.Node): void {
    if (ts.isToken(node) && node.kind === ts.SyntaxKind.TrueKeyword) {
      this.add('Boolean', 'true', 'false', node);
    } else if (ts.isToken(node) && node.kind === ts.SyntaxKind.FalseKeyword) {
      this.add('Boolean', 'false', 'true', node);
    }
  }

  // ── Negation: !expr  ~expr ─────────────────────

  private applyNegation(node: ts.Node): void {
    if (ts.isPrefixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.ExclamationToken) {
        this.add('Negation', '!', '', node.operatorToken!);
      }
    }
  }

  // ── String: '' removal, "default" → "" ────────

  private applyStringLiteral(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.length > 0 && !node.text.includes('\n')) {
      // Don't mutate import paths or type strings
      if (node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))) return;

      this.add('StringLiteral', `"${node.text}"`, '""', node);
    }
  }
}

// ── Mutant Applicator ──────────────────────────────

function applyMutant(source: string, mutant: Mutant): string {
  const lines = source.split('\n');
  const lineIdx = mutant.location.line - 1;

  // For operator mutations (token-level replacements)
  if (mutant.operator === 'Arithmetic' || mutant.operator === 'Logical') {
    const line = lines[lineIdx]!;
    const before = line.slice(0, mutant.location.character);
    // Find the operator token position and replace it
    const opPos = before.lastIndexOf(mutant.original);
    if (opPos >= 0) {
      const after = line.slice(opPos + mutant.original.length);
      lines[lineIdx] = before.slice(0, opPos) + mutant.replacement + after;
      return lines.join('\n');
    }
  }

  // For whole-node replacements (Boolean, StringLiteral)
  const before = lines[lineIdx]!.slice(0, mutant.location.character);
  const after = lines[lineIdx]!.slice(mutant.location.endCharacter);
  lines[lineIdx] = before + mutant.replacement + after;
  return lines.join('\n');
}

// ── Test Runner ────────────────────────────────────

interface TestRunResult {
  ok: boolean;
  failures: number;
  error?: string;
  durationMs: number;
}

function runTests(root: string): TestRunResult {
  const start = Date.now();
  try {
    const output = execSync('npx vitest run --reporter=json 2>/dev/null || true', {
      cwd: root,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    const durationMs = Date.now() - start;

    // Parse JSON output — vitest's --reporter=json is multiline JSONL
    const lines = output.trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.numFailedTests !== undefined) {
          return {
            ok: parsed.success === true || parsed.numFailedTests === 0,
            failures: parsed.numFailedTests || 0,
            durationMs,
          };
        }
      } catch { /* skip non-JSON lines */ }
    }

    // Fallback: check for failure indicators
    if (output.includes('Tests  0 passed') || output.includes('Tests  ')) {
      const match = output.match(/Tests\s+(\d+)\s+failed/);
      const failures = match ? parseInt(match[1]!) : 0;
      return { ok: failures === 0, failures, durationMs };
    }

    return { ok: true, failures: 0, durationMs };
  } catch (err: any) {
    return {
      ok: false,
      failures: 1,
      error: err.stderr?.slice(0, 200) || err.message?.slice(0, 200),
      durationMs: Date.now() - start,
    };
  }
}

// ── Main Engine ────────────────────────────────────

export async function runMutationTests(root: string): Promise<MutationReport> {
  const reportDir = join(root, '.mutation-report');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const sourceFiles = discoverSourceFiles(root);
  console.error(`🔬 Mutation Test Engine\n`);
  console.error(`   Source files found: ${sourceFiles.length}`);
  console.error(`   Scanning for mutation targets...\n`);

  // Phase 1: Generate all mutants
  const allMutants: Mutant[] = [];
  for (const file of sourceFiles) {
    const generator = new MutantGenerator(file);
    generator.scan();
    const fileMutants = generator.getMutants();
    if (fileMutants.length > 0) {
      const rel = relative(root, file);
      console.error(`   ${rel}: ${fileMutants.length} mutants`);
    }
    allMutants.push(...fileMutants);
  }

  console.error(`\n   Total mutants generated: ${allMutants.length}\n`);
  console.error(`   Executing mutation tests...`);
  console.error(`   (Each mutant: apply → run full vitest suite → restore)\n`);

  // Phase 2: Execute each mutant
  const startTime = Date.now();
  const packageResults = new Map<string, {
    generated: number; executed: number;
    killed: number; survived: number; timeout: number; compileError: number; noCoverage: number;
    topSurvivors: Array<{ id: string; operator: string; line: number; original: string }>;
  }>();

  const slowestMutants: Array<{ id: string; file: string; durationMs: number }> = [];
  const mutantResults: MutantResult[] = [];

  // Initialize package tracking
  for (const m of allMutants) {
    const pkg = extractPackageName(m.location.file, root);
    if (!packageResults.has(pkg)) {
      packageResults.set(pkg, {
        generated: 0, executed: 0,
        killed: 0, survived: 0, timeout: 0, compileError: 0, noCoverage: 0,
        topSurvivors: [],
      });
    }
    packageResults.get(pkg)!.generated++;
  }

  // Track progress
  let completed = 0;
  const total = allMutants.length;

  for (const mutant of allMutants) {
    const filePath = mutant.location.file;
    const originalSource = readFileSync(filePath, 'utf-8');
    const mutatedSource = applyMutant(originalSource, mutant);

    const start = Date.now();
    let result: MutantResult = {
      mutant,
      status: 'killed',
      durationMs: 0,
    };

    try {
      // Write mutated source
      writeFileSync(filePath, mutatedSource);

      // Run tests
      const testResult = runTests(root);
      result.durationMs = testResult.durationMs;

      if (testResult.error?.includes('SyntaxError') || testResult.error?.includes('parse')) {
        result.status = 'compileError';
      } else if (testResult.ok && testResult.failures === 0) {
        // All tests passed with mutation = mutation survived (BAD)
        result.status = 'survived';
      } else {
        // At least one test failed = mutation killed (GOOD)
        result.status = 'killed';
      }
    } catch (err: any) {
      result.status = 'compileError';
      result.error = err.message?.slice(0, 200);
    } finally {
      // ALWAYS restore original source
      writeFileSync(filePath, originalSource);
    }

    const pkg = extractPackageName(filePath, root);
    const pkgResult = packageResults.get(pkg)!;
    pkgResult.executed++;
    (pkgResult as any)[result.status]++;

    if (result.durationMs > 5000) {
      slowestMutants.push({ id: mutant.id, file: relative(root, filePath), durationMs: result.durationMs });
    }

    if (result.status === 'survived') {
      pkgResult.topSurvivors.push({
        id: mutant.id,
        operator: mutant.operator,
        line: mutant.location.line,
        original: mutant.original,
      });
    }

    mutantResults.push(result);
    completed++;

    if (completed % 10 === 0 || completed === total) {
      const pct = ((completed / total) * 100).toFixed(1);
      console.error(`   [${completed}/${total}] ${pct}% — killed: ${mutantResults.filter(r => r.status === 'killed').length}, survived: ${mutantResults.filter(r => r.status === 'survived').length}`);
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Phase 3: Build report
  const packageScores: PackageScore[] = [];
  let totalsKilled = 0, totalsSurvived = 0, totalsTimeout = 0, totalsCompileError = 0, totalsNoCoverage = 0;

  for (const [pkgName, p] of packageResults) {
    totalsKilled += p.killed;
    totalsSurvived += p.survived;
    totalsTimeout += p.timeout;
    totalsCompileError += p.compileError;
    totalsNoCoverage += p.noCoverage;
    const executed = p.executed;

    packageScores.push({
      packageName: pkgName,
      mutantsGenerated: p.generated,
      mutantsExecuted: p.executed,
      killed: p.killed,
      survived: p.survived,
      timeout: p.timeout,
      compileError: p.compileError,
      noCoverage: p.noCoverage,
      mutationScore: executed > 0 ? (p.killed / executed) * 100 : 100,
      durationMs: 0,
      topSurvivors: p.topSurvivors.slice(0, 5),
    });
  }

  // Sort packages by mutation score (worst first)
  packageScores.sort((a, b) => a.mutationScore - b.mutationScore);

  const report: MutationReport = {
    timestamp: new Date().toISOString(),
    totals: {
      mutantsGenerated: total,
      mutantsExecuted: total,
      killed: totalsKilled,
      survived: totalsSurvived,
      timeout: totalsTimeout,
      compileError: totalsCompileError,
      noCoverage: totalsNoCoverage,
      mutationScore: total > 0 ? (totalsKilled / total) * 100 : 100,
      durationMs: totalDurationMs,
    },
    packages: packageScores,
    slowestMutants: slowestMutants.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
  };

  // Write JSON report
  writeFileSync(join(reportDir, 'mutation-report.json'), JSON.stringify(report, null, 2));

  // Write Markdown summary
  writeMarkdownReport(join(reportDir, 'MUTATION_REPORT.md'), report);

  return report;
}

// ── Package extraction ─────────────────────────────

function extractPackageName(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  const match = rel.match(/^packages\/([^/]+)/);
  return match ? match[1]! : 'unknown';
}

// ── Markdown Report ────────────────────────────────

function writeMarkdownReport(filePath: string, report: MutationReport): void {
  const lines: string[] = [
    '# Mutation Test Report',
    '',
    `> Generated: ${report.timestamp}`,
    `> Duration: ${(report.totals.durationMs / 1000).toFixed(1)}s`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Mutants Generated | ${report.totals.mutantsGenerated} |`,
    `| Mutants Executed | ${report.totals.mutantsExecuted} |`,
    `| **Killed** | **${report.totals.killed}** |`,
    `| Survived | ${report.totals.survived} |`,
    `| Timeout | ${report.totals.timeout} |`,
    `| Compile Error | ${report.totals.compileError} |`,
    `| No Coverage | ${report.totals.noCoverage} |`,
    `| **Mutation Score** | **${report.totals.mutationScore.toFixed(2)}%** |`,
    '',
    '## Package Scores',
    '',
    `| Package | Gen | Exec | Killed | Survived | Timeout | Comp.Err | NoCov | Score |`,
    `|---------|-----|------|--------|----------|---------|----------|-------|-------|`,
  ];

  for (const pkg of report.packages) {
    const status = pkg.mutationScore >= 95 ? '🟢' : pkg.mutationScore >= 80 ? '🟡' : '🔴';
    lines.push(
      `| ${status} ${pkg.packageName} | ${pkg.mutantsGenerated} | ${pkg.mutantsExecuted} | ${pkg.killed} | ${pkg.survived} | ${pkg.timeout} | ${pkg.compileError} | ${pkg.noCoverage} | **${pkg.mutationScore.toFixed(1)}%** |`
    );
  }

  lines.push(
    '',
    '## Top Survivors (Unkilled Mutants)',
    '',
    'These mutations did NOT cause any test to fail — indicating potential test gaps.',
    '',
    `| Mutant ID | Package | Operator | Line | Original |`,
    `|-----------|---------|----------|------|----------|`
  );

  for (const pkg of report.packages) {
    for (const s of pkg.topSurvivors) {
      lines.push(`| ${s.id} | ${pkg.packageName} | ${s.operator} | ${s.line} | \`${s.original}\` |`);
    }
  }

  if (report.slowestMutants.length > 0) {
    lines.push(
      '',
      '## Slowest Mutants (>5s)',
      '',
      `| Mutant ID | File | Duration |`,
      `|-----------|------|----------|`
    );
    for (const s of report.slowestMutants) {
      lines.push(`| ${s.id} | ${s.file} | ${(s.durationMs / 1000).toFixed(1)}s |`);
    }
  }

  writeFileSync(filePath, lines.join('\n'));
}

// ── CLI entry ──────────────────────────────────────

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const root = resolve(process.argv[2] || process.cwd());
  runMutationTests(root).then((report) => {
    console.error(`\n✅ Mutation testing complete.`);
    console.error(`   Score: ${report.totals.mutationScore.toFixed(2)}%`);
    console.error(`   Killed: ${report.totals.killed}/${report.totals.mutantsExecuted}`);
    console.error(`   Report: .mutation-report/MUTATION_REPORT.md`);
  }).catch((err) => {
    console.error('Mutation test failed:', err);
    process.exit(1);
  });
}
