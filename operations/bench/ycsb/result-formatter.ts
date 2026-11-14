/**
 * result-formatter — Formats YCSB benchmark results as JSON and Markdown
 *
 * @module bench/ycsb/result-formatter
 */

import type { YCSBResult } from './YCSBExecutor.js';
import type { WorkloadType } from './YCSBWorkload.js';

export function formatMarkdown(results: YCSBResult[]): string {
  const lines: string[] = [];
  lines.push('## YCSB Benchmark Results');
  lines.push('');
  lines.push('| Workload | Total Ops | Duration (ms) | Throughput (ops/s) | Read P50 (ms) | Read P95 (ms) | Read P99 (ms) | Update P50 (ms) | Update P95 (ms) | Update P99 (ms) | Errors |');
  lines.push('|----------|-----------|---------------|--------------------|---------------|---------------|---------------|-----------------|-----------------|-----------------|--------|');

  for (const r of results) {
    lines.push(
      `| ${r.workload} | ${r.totalOps} | ${r.durationMs} | ${r.throughput} | ` +
      `${r.readLatency.p50.toFixed(2)} | ${r.readLatency.p95.toFixed(2)} | ${r.readLatency.p99.toFixed(2)} | ` +
      `${r.updateLatency.p50.toFixed(2)} | ${r.updateLatency.p95.toFixed(2)} | ${r.updateLatency.p99.toFixed(2)} | ` +
      `${r.errors} |`,
    );
  }

  lines.push('');
  if (results.length > 0) {
    lines.push(`**Run at:** ${results[0].timestamp}`);
    lines.push(`**Node.js:** ${results[0].nodeVersion}`);
    lines.push(`**Platform:** ${results[0].platform}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatJSON(results: YCSBResult[]): string {
  return JSON.stringify(results, null, 2);
}

export function compareWithBaseline(
  results: YCSBResult[],
  baseline: Partial<Record<WorkloadType, number>>,
): string {
  const lines: string[] = [];
  lines.push('## YCSB Baseline Comparison');
  lines.push('');
  lines.push('| Workload | Current (ops/s) | Baseline (ops/s) | Delta (%) | Verdict |');
  lines.push('|----------|-----------------|------------------|-----------|---------|');

  for (const r of results) {
    const current = r.throughput;
    const base = baseline[r.workload];
    if (base === undefined) {
      lines.push(`| ${r.workload} | ${current} | N/A | — | No baseline |`);
      continue;
    }
    const delta = current > 0 ? ((current - base) / base) * 100 : -100;
    const verdict = delta >= -5 ? '✅ Pass' : delta >= -10 ? '⚠️ Degraded' : '❌ Regression';
    lines.push(`| ${r.workload} | ${current} | ${base} | ${delta.toFixed(1)}% | ${verdict} |`);
  }

  lines.push('');
  return lines.join('\n');
}

export async function saveJSON(results: YCSBResult[], filePath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, formatJSON(results), 'utf-8');
}
