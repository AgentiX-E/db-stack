/**
 * YCSBWorkload — YCSB-style workload type definitions
 *
 * Follows the Yahoo! Cloud Serving Benchmark methodology for defining
 * standard read/update/insert/scan workloads (A-F).
 *
 * @module bench/ycsb/YCSBWorkload
 */

export type WorkloadType = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface YCSBConfig {
  workload: WorkloadType;
  recordCount: number;
  operationCount: number;
  fieldCount: number;
  fieldLength: number;
  readProportion: number;
  updateProportion: number;
  insertProportion: number;
  scanProportion: number;
  readModifyWriteProportion: number;
  requestDistribution: 'uniform' | 'zipfian' | 'latest';
  targetThroughput: number;
  threads: number;
}

export const WORKLOAD_PROPORTIONS: Record<WorkloadType, {
  readProportion: number;
  updateProportion: number;
  insertProportion: number;
  scanProportion: number;
  readModifyWriteProportion: number;
}> = {
  A: { readProportion: 0.50, updateProportion: 0.50, insertProportion: 0, scanProportion: 0, readModifyWriteProportion: 0 },
  B: { readProportion: 0.95, updateProportion: 0.05, insertProportion: 0, scanProportion: 0, readModifyWriteProportion: 0 },
  C: { readProportion: 1.00, updateProportion: 0,    insertProportion: 0, scanProportion: 0, readModifyWriteProportion: 0 },
  D: { readProportion: 0.95, updateProportion: 0,    insertProportion: 0.05, scanProportion: 0, readModifyWriteProportion: 0 },
  E: { readProportion: 0,    updateProportion: 0,    insertProportion: 0.05, scanProportion: 0.95, readModifyWriteProportion: 0 },
  F: { readProportion: 0.50, updateProportion: 0,    insertProportion: 0, scanProportion: 0, readModifyWriteProportion: 0.50 },
};

export const WORKLOAD_DESCRIPTIONS: Record<WorkloadType, string> = {
  A: 'Update heavy — 50% read, 50% update (session store)',
  B: 'Read mostly — 95% read, 5% update (photo tagging)',
  C: 'Read only — 100% read (user profile cache)',
  D: 'Read latest — 95% read, 5% insert (latest news feed)',
  E: 'Short ranges — 95% scan, 5% insert (threaded discussions)',
  F: 'Read-modify-write — 50% read, 50% RMW (user database)',
};

export function defaultYCSBConfig(workload: WorkloadType, overrides?: Partial<YCSBConfig>): YCSBConfig {
  const proportions = WORKLOAD_PROPORTIONS[workload];
  return {
    workload,
    recordCount: 1000,
    operationCount: 1000,
    fieldCount: 10,
    fieldLength: 100,
    ...proportions,
    requestDistribution: 'zipfian',
    targetThroughput: 0,
    threads: 4,
    ...overrides,
  };
}
