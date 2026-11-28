/**
 * I106 — a PITR target the log cannot reach is refused before the engine is asked.
 *
 * The policy already refuses a retention window longer than the log, but a
 * single `pitr()` call naming an old target walked past that check into the
 * engine, whose answer was whatever the engine chose. These cases use a real
 * directory source, a real bucket and a movable clock, so the horizon is a
 * number the source reports and the refusal happens on the manager's side.
 *
 * @module @agentix-e/db-node/backup/__tests__
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import type { IBackupSource } from '../interfaces/index.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');
const HOUR = 3_600_000;

let root: string;
let dataDir: string;
let workDir: string;
let now: number;
let storage: InMemoryStorageBackend;

beforeEach(() => {
  now = START;
  storage = new InMemoryStorageBackend();
  root = mkdtempSync(join(tmpdir(), 'i106-pitr-'));
  dataDir = join(root, 'data');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'state');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real directory source with one extra fact: the log's replay reach. */
function sourceWithHorizon(horizonMs: number | null): IBackupSource {
  const inner = new DirectoryBackupSource(dataDir);
  return {
    name: inner.name,
    whole: inner.whole,
    capture: (destination) => inner.capture(destination),
    restore: (path) => inner.restore(path),
    ...(horizonMs === null ? {} : { logHorizon: async () => horizonMs }),
  };
}

function manager(horizonMs: number | null): BackupManager {
  return new BackupManager(
    sourceWithHorizon(horizonMs),
    storage,
    new RetentionPolicyEvaluator({
      maxFullSnapshots: 10,
      maxTotalBytes: 0,
    }),
    { workDir, clock: () => new Date(now) },
  );
}

async function backupAt(time: number, horizonMs: number | null): Promise<void> {
  now = time;
  const result = await manager(horizonMs).createBackup({ type: 'full' });
  expect(result.success).toBe(true);
}

describe('I106: PITR against the log horizon', () => {
  it('PH.1 — a target older than the log horizon is refused by name', async () => {
    await backupAt(START, 2 * HOUR);
    now = START + 2 * HOUR;
    const result = await manager(2 * HOUR).pitr({ targetTime: new Date(START - HOUR).toISOString() });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/older than the engine's log horizon/);
    expect(result.error).toContain('7200000');
  });

  it('PH.2 — a target inside the horizon restores the snapshot at or before it', async () => {
    await backupAt(START, 2 * HOUR);
    now = START + HOUR;
    const result = await manager(2 * HOUR).pitr({ targetTime: new Date(START + HOUR).toISOString() });

    expect(result.success).toBe(true);
    expect(readFileSync(join(dataDir, 'table.bin'), 'utf8')).toBe('state');
  });

  it('PH.3 — a source that keeps no log is not refused for keeping none', async () => {
    await backupAt(START, null);
    now = START + 24 * HOUR;
    const result = await manager(null).pitr({ targetTime: new Date(START + HOUR).toISOString() });

    expect(result.success).toBe(true);
  });

  it('PH.4 — the chosen snapshot older than the horizon is refused even when the target is not', async () => {
    await backupAt(START, 2 * HOUR);
    now = START + 3 * HOUR;
    const result = await manager(2 * HOUR).pitr({ targetTime: new Date(START + 3 * HOUR).toISOString() });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshot .* is older than the log horizon/);
  });
});
