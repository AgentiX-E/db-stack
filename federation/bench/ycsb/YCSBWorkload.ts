/**
 * YCSBWorkload — YCSB-style workload type definitions
 *
 * Follows the Yahoo! Cloud Serving Benchmark methodology for defining
 * standard read/update/insert/scan workloads (A-F).
 *
 * @module bench/ycsb/YCSBWorkload
 */

/**
 * Standard YCSB workload types.
 *
 * | Type | Name              | Operations                      | Typical Use         |
 * |------|-------------------|---------------------------------|---------------------|
 * | A    | Update heavy      | 50% read, 50% update            | Session store       |
 * | B    | Read mostly       | 95% read, 5% update             | Photo tagging       |
 * | C    | Read only         | 100% read                       | User profile cache  |
 * | D    | Read latest       | 95% read, 5% insert             | Latest news feed    |
 * | E    | Short ranges      | 95% scan, 5% insert             | Threaded discussions|
 * | F    | Read-modify-write | 50% read, 50% read-modify-write | User database       |
 */
export type WorkloadType = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/**
 * YCSB benchmark configuration for a single workload run.
 */
export interface YCSBConfig {
  /** Workload type label */
  workload: WorkloadType;

  /** Number of records to pre-populate before measurement */
  recordCount: number;

  /** Number of operations to execute during measurement */
  operationCount: number;

  /** Number of fields per record */
  fieldCount: number;

  /** Bytes per field */
  fieldLength: number;

  /** Proportion of read operations (0-1) */
  readProportion: number;

  /** Proportion of update operations (0-1) */
  updateProportion: number;

  /** Proportion of insert operations (0-1) */
  insertProportion: number;

  /** Proportion of scan operations (0-1) */
  scanProportion: number;

  /** Proportion of read-modify-write operations (0-1) */
  readModifyWriteProportion: number;

  /** Key distribution: 'uniform' | 'zipfian' | 'latest' */
  requestDistribution: 'uniform' | 'zipfian' | 'latest';

  /** Target throughput in ops/sec (0 = no limit) */
  targetThroughput: number;

  /** Number of concurrent worker threads */
  threads: number;
}

/**
 * Default YCSB workload proportions per workload type.
 */
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

/**
 * Human-readable descriptions for each workload.
 */
export const WORKLOAD_DESCRIPTIONS: Record<WorkloadType, string> = {
  A: 'Update heavy — 50% read, 50% update (session store)',
  B: 'Read mostly — 95% read, 5% update (photo tagging)',
  C: 'Read only — 100% read (user profile cache)',
  D: 'Read latest — 95% read, 5% insert (latest news feed)',
  E: 'Short ranges — 95% scan, 5% insert (threaded discussions)',
  F: 'Read-modify-write — 50% read, 50% RMW (user database)',
};

/**
 * Default configuration based on workload type.
 */
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
