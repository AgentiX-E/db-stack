/**
 * I106 — the log horizon is measured by a rehearsal, not taken on trust.
 *
 * An engine that over-reports how far back it can replay makes retention pass
 * and the restore fail at the edge of the window. The manager now asks the
 * engine to rehearse a replay of the oldest retained artefact through a plain
 * callback and compares the measured horizon with the declared one. The rehearsal
 * here reads a real file from disk, so the answer comes from outside the manager
 * rather than from a stub's return value.
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

let root: string;
let dataDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'i106-drill-'));
  dataDir = join(root, 'data');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'state');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real directory source that can rehearse a replay without replacing state. */
function drillSource(declaredMs: number | null, drill = true): IBackupSource {
  const inner = new DirectoryBackupSource(dataDir);
  return {
    name: inner.name,
    whole: inner.whole,
    capture: (destination) => inner.capture(destination),
    restore: (path) => inner.restore(path),
    ...(declaredMs === null ? {} : { logHorizon: async () => declaredMs }),
    ...(drill
      ? {
          replayDrill: async (artifactPath: string) => {
            // The artefact must really be on disk before the engine answers.
            const bytes = readFileSync(artifactPath);
            const horizonPath = join(dataDir, 'horizon.txt');
            const measured = Number(readFileSync(horizonPath, 'utf8'));
            if (bytes.length === 0 || !Number.isFinite(measured)) throw new Error('drill cannot read the artefact');
            return { actualHorizonMs: measured };
          },
        }
      : {}),
  };
}

function manager(source: IBackupSource): BackupManager {
  return new BackupManager(
    source,
    storage,
    new RetentionPolicyEvaluator({
      maxFullSnapshots: 10,
      maxTotalBytes: 0,
    }),
    { workDir },
  );
}

async function backup(source: IBackupSource): Promise<void> {
  const result = await manager(source).createBackup({ type: 'full' });
  expect(result.success).toBe(true);
}

describe('I106: restore drill', () => {
  it('DR.1 — a rehearsal that reaches only part of the declared window is a mismatch', async () => {
    const source = drillSource(7200000);
    await backup(source);
    writeFileSync(join(dataDir, 'horizon.txt'), '3600000', 'utf8');

    const verdict = await manager(source).verifyLogHorizon();
    expect(verdict.checked).toBe(true);
    expect(verdict.declaredMs).toBe(7200000);
    expect(verdict.actualMs).toBe(3600000);
    expect(verdict.consistent).toBe(false);
  });

  it('DR.2 — a rehearsal that reaches the declared window agrees', async () => {
    const source = drillSource(7200000);
    await backup(source);
    writeFileSync(join(dataDir, 'horizon.txt'), '7200000', 'utf8');

    const verdict = await manager(source).verifyLogHorizon();
    expect(verdict.consistent).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it('DR.3 — a source with no drill says it was not checked', async () => {
    const source = drillSource(7200000, false);
    await backup(source);

    const verdict = await manager(source).verifyLogHorizon();
    expect(verdict.checked).toBe(false);
    expect(verdict.reason).toMatch(/does not offer a replay drill/);
  });

  it('DR.4 — no retained backup to rehearse is reported, not invented', async () => {
    const verdict = await manager(drillSource(7200000)).verifyLogHorizon();
    expect(verdict.checked).toBe(false);
    expect(verdict.reason).toMatch(/no completed snapshot to rehearse/);
  });
});
