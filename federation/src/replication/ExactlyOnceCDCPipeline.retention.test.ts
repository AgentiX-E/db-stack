/**
 * ExactlyOnceCDCPipeline — the window the pipeline's dedup ring must hold.
 *
 * The pipeline has the shortest dedup window in the package (10 minutes, where
 * the manager uses 30) and the only acknowledgement wait (5 seconds). Both are
 * inside the sender's retry budget: an entry is retried, and each attempt waits
 * for a verdict. A ring shorter than the budget plus the wait forgets the id
 * exactly when the retry that needs it is in flight.
 *
 *   PR.1  the defaults are the pipeline's documented windows, and they are legal
 *   PR.2  a dedup window shorter than budget plus wait is refused, before start
 *   PR.3  the reported window is the one the ring was built with
 *   PR.4  an outbox budget the pipeline's ring cannot cover is refused
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExactlyOnceCDCPipeline, type ExactlyOnceCDCPipelineConfig } from './ExactlyOnceCDCPipeline';
import { RetentionViolation } from '../storage/retention';

const MINUTE = 60_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdc-retention-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function config(overrides: Partial<ExactlyOnceCDCPipelineConfig> = {}): ExactlyOnceCDCPipelineConfig {
  return {
    nodeId: 'dc-east-1',
    cdcConfig: { nodeId: 'dc-east-1' } as never,
    outboxConfig: { dataDir: dir },
    ...overrides,
  };
}

describe('ExactlyOnceCDCPipeline — retention windows', () => {
  it('PR.1: the defaults are the documented windows and they contain each other', () => {
    const pipeline = new ExactlyOnceCDCPipeline(config());
    const windows = pipeline.getRetention();
    expect(windows.dedupMs).toBe(10 * MINUTE);
    expect(windows.ackTimeoutMs).toBe(5_000);
    expect(windows.retryWindowMs).toBe(MINUTE);
    expect(windows.dedupMs).toBeGreaterThanOrEqual(windows.retryWindowMs + windows.ackTimeoutMs);
    pipeline.stop();
  });

  it('PR.2: a dedup window shorter than budget plus wait is refused', () => {
    expect(() => new ExactlyOnceCDCPipeline(config({ dedupTtlMs: 30_000 }))).toThrow(RetentionViolation);
  });

  it('PR.3: the reported window is the configured one', () => {
    const pipeline = new ExactlyOnceCDCPipeline(config({ dedupTtlMs: 20 * MINUTE }));
    expect(pipeline.getRetention().dedupMs).toBe(20 * MINUTE);
    pipeline.stop();
  });

  it('PR.4: an outbox budget the ring cannot cover is refused', () => {
    expect(
      () => new ExactlyOnceCDCPipeline(config({ outboxConfig: { dataDir: dir, retryWindowMs: 15 * MINUTE } })),
    ).toThrow(/dedup-covers-retry/);
  });
});
