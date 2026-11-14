#!/usr/bin/env node

/**
 * E2E Real Engine Integration Test Runner
 *
 * Orchestrates all `*-real.test.ts` test files against the SqlVec
 * and GraphVec real engines (plus InMemory baseline).
 *
 * Usage:
 *   npx tsx run-e2e-real.ts                      # run all real engine tests
 *   npx tsx run-e2e-real.ts --engine=sqlvec       # only SqlVec
 *   npx tsx run-e2e-real.ts --skip-inmem          # skip InMemory baseline
 *
 * @module @agentix-e/db-operations-core/__tests__/e2e
 */

import { execSync } from 'node:child_process';
import { E2E_CONFIG, SLOW_ENGINE_WARN_MS } from './e2e-real.config.js';

interface TestResult {
  file: string;
  engine: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors: string[];
}

interface EngineStat {
  passed: number;
  failed: number;
  skipped: number;
}

type Stats = {
  totalTests: number;
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  engineResults: Record<string, EngineStat>;
};

function parseCLI(): { engines: string[]; skipInMem: boolean } {
  const args = process.argv.slice(2);
  const engines: string[] = [];
  let skipInMem = false;

  for (const arg of args) {
    if (arg.startsWith('--engine=')) {
      engines.push(arg.split('=')[1]);
    }
    if (arg === '--skip-inmem') {
      skipInMem = true;
    }
  }

  return {
    engines: engines.length > 0 ? engines : ['InMemory', 'SqlVec', 'GraphVec'],
    skipInMem,
  };
}

function parseVitestOutput(output: string): { passed: number; failed: number; skipped: number; errors: string[] } {
  const passMatch = output.match(/(\d+)\s+passed/i);
  const failMatch = output.match(/(\d+)\s+failed/i);
  const skipMatch = output.match(/(\d+)\s+skipped/i);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;

  const errorLines = output
    .split('\n')
    .filter(l => l.includes('FAIL') || l.includes('AssertionError:') || l.includes('expected'))
    .slice(0, 5);

  return { passed, failed, skipped, errors: errorLines };
}

function runVitest(file: string): { output: string; durationMs: number; exitCode: number } {
  const startTime = Date.now();

  try {
    const output = execSync(
      `npx vitest run packages/core/src/__tests__/e2e/${file} --reporter=verbose`,
      {
        cwd: '/home/admin/openclaw/workspace/db-operations',
        env: { ...process.env, FORCE_COLOR: '0' },
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000, // 2 min per test file
      },
    );
    return { output, durationMs: Date.now() - startTime, exitCode: 0 };
  } catch (err: any) {
    return {
      output: err.stdout?.toString() ?? err.message ?? '',
      durationMs: Date.now() - startTime,
      exitCode: err.status ?? 1,
    };
  }
}

async function main(): Promise<void> {
  const { engines, skipInMem } = parseCLI();
  const testFiles = [
    'e2e-health-real.test.ts',
    'e2e-metrics-real.test.ts',
    'e2e-backup-real.test.ts',
    'e2e-security-real.test.ts',
    'e2e-tracing-real.test.ts',
    'e2e-maintenance-real.test.ts',
    'e2e-adapters-real.test.ts',
  ];

  const filteredEngines = skipInMem
    ? engines.filter(e => e !== 'InMemory')
    : engines;

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║    E2E Real Engine Integration Tests            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Engines: ${filteredEngines.join(', ')}`);
  console.log(`Test files: ${testFiles.length}`);
  console.log(`Engine startup timeout: ${E2E_CONFIG.timeouts.engineStartup}ms`);
  console.log(`Slow engine warning: >${SLOW_ENGINE_WARN_MS}ms`);
  console.log('');

  const allResults: TestResult[] = [];
  const stats: Stats = {
    totalTests: 0,
    totalPassed: 0,
    totalFailed: 0,
    totalSkipped: 0,
    engineResults: {},
  };

  for (const engine of filteredEngines) {
    stats.engineResults[engine] = { passed: 0, failed: 0, skipped: 0 };
  }

  for (const engine of filteredEngines) {
    console.log(`\n─── Engine: ${engine} ───`);

    for (const file of testFiles) {
      process.stdout.write(`  Running ${file}... `);

      const { output, durationMs, exitCode } = runVitest(file);
      const { passed, failed, skipped, errors } = parseVitestOutput(output);

      const result: TestResult = {
        file,
        engine,
        passed,
        failed,
        skipped,
        durationMs,
        errors,
      };

      allResults.push(result);
      stats.totalTests += passed + failed + skipped;
      stats.totalPassed += passed;
      stats.totalFailed += failed;
      stats.totalSkipped += skipped;

      if (stats.engineResults[engine]) {
        stats.engineResults[engine].passed += passed;
        stats.engineResults[engine].failed += failed;
        stats.engineResults[engine].skipped += skipped;
      }

      const status = exitCode === 0 && failed === 0 ? '✓' : '✗';
      const statusColor = exitCode === 0 && failed === 0 ? 'PASS' : 'FAIL';
      console.log(`${statusColor} ${passed}p/${failed}f/${skipped}s ${durationMs}ms`);

      if (errors.length > 0) {
        for (const err of errors) {
          console.log(`    → ${err.substring(0, 200)}`);
        }
      }
    }
  }

  // ── Final Report ────────────────────────────────────────────────

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║    E2E Summary                                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Total tests: ${stats.totalTests}`);
  console.log(`  Passed:    ${stats.totalPassed}`);
  console.log(`  Failed:    ${stats.totalFailed}`);
  console.log(`  Skipped:   ${stats.totalSkipped}`);
  console.log('');
  console.log('Per-engine breakdown:');
  for (const [engine, data] of Object.entries(stats.engineResults)) {
    console.log(`  ${engine}: ${data.passed}p / ${data.failed}f / ${data.skipped}s`);
  }

  if (stats.totalFailed > 0) {
    console.error('\n❌ Some tests FAILED');
    process.exit(1);
    return;
  }

  console.log('\n✅ All tests PASSED');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
