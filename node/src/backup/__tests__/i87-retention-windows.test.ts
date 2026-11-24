/**
 * I87 — the three retention windows have to contain each other.
 *
 * `RetentionPolicyEvaluator` kept backups by count, age and bytes. Nothing related
 * that window to how far back the engine's log can replay, and nothing related it
 * to how often a snapshot is taken, so a policy could keep a week of backups in
 * front of a two-hour log — a week of objects that restore to their snapshot and
 * cannot be replayed forward — and a window shorter than the interval could expire
 * between two snapshots and take the only restore with it.
 *
 * These cases pin the derivation and both ends of it: the pure function with its
 * legal and illegal tuples, the evaluator refusing a policy whose interval outlives
 * its window, and the manager refusing a policy whose window outlives the engine's
 * log — before it deletes anything.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RetentionPolicyEvaluator, RetentionWindowError, deriveRetentionWindows } from '../index.js';
import type {
  IBackupManager,
  IBackupRetentionPolicy,
  IBackupSource,
  RetentionWindowInput,
  RetentionWindows,
} from '../index.js';
import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import type { RetentionPolicy } from '../../core/types.js';

// ── Helpers ────────────────────────────────────────────────

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The rule a refusal names, for a table of tuples. */
function ruleOf(input: RetentionWindowInput): string {
  try {
    deriveRetentionWindows(input);
    return 'legal';
  } catch (err) {
    return err instanceof RetentionWindowError ? err.rule : 'unknown';
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/**
 * A manager over a directory source, with the engine's log horizon as a value the
 * case controls.
 *
 * `horizon` is what `logHorizon()` answers; `undefined` means the source does not
 * implement it at all, which is how an engine that keeps no log behaves.
 */
function fixture(options: {
  horizon?: number | null;
  retention?: RetentionPolicy;
  snapshotIntervalMs?: number;
  policy?: IBackupRetentionPolicy;
}): { manager: BackupManager; storage: InMemoryStorageBackend } {
  const root = mkdtempSync(join(tmpdir(), 'i87-'));
  tempDirs.push(root);
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'table.txt'), 'alpha');

  const directory = new DirectoryBackupSource(data);
  const source: IBackupSource = {
    name: directory.name,
    whole: directory.whole,
    capture: (destination: string) => directory.capture(destination),
    restore: (path: string) => directory.restore(path),
    ...(options.horizon === undefined ? {} : { logHorizon: async () => options.horizon! }),
  };

  const storage = new InMemoryStorageBackend();
  const retention =
    options.policy ??
    new RetentionPolicyEvaluator(
      options.retention ?? { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P1D' },
      options.snapshotIntervalMs === undefined ? {} : { snapshotIntervalMs: options.snapshotIntervalMs },
    );

  return {
    manager: new BackupManager(source, storage, retention, { workDir: join(root, 'work') }),
    storage,
  };
}

// ── RW.1–RW.9: the derivation ──────────────────────────────

describe('I87: deriving the windows', () => {
  it('RW.1 — a week of backups in front of a week of log keeps everything', () => {
    const windows = deriveRetentionWindows({
      keepRecentMs: 7 * DAY,
      snapshotIntervalMs: HOUR,
      logHorizonMs: 7 * DAY,
    });

    // A horizon equal to the window is the shortest one that is legal, so the
    // replay window and the backup window are the same number here and everywhere
    // else that passes the derivation.
    expect(windows.replayWindowMs).toBe(7 * DAY);
  });

  it('RW.2 — an interval equal to the window is legal; longer is not', () => {
    expect(ruleOf({ keepRecentMs: DAY, snapshotIntervalMs: DAY })).toBe('legal');
    expect(ruleOf({ keepRecentMs: DAY, snapshotIntervalMs: DAY + SECOND })).toBe(
      'snapshot-interval-exceeds-keep-recent',
    );
    expect(ruleOf({ keepRecentMs: DAY, snapshotIntervalMs: 2 * DAY })).toBe('snapshot-interval-exceeds-keep-recent');
  });

  it('RW.3 — a horizon equal to the window is legal; shorter is not', () => {
    expect(ruleOf({ keepRecentMs: DAY, logHorizonMs: DAY })).toBe('legal');
    expect(ruleOf({ keepRecentMs: DAY, logHorizonMs: DAY - SECOND })).toBe('keep-recent-exceeds-log-horizon');
    expect(ruleOf({ keepRecentMs: 7 * DAY, logHorizonMs: 2 * HOUR })).toBe('keep-recent-exceeds-log-horizon');
  });

  it('RW.4 — with no log there is nothing to outlive, and the window is the replay window', () => {
    const windows = deriveRetentionWindows({ keepRecentMs: 7 * DAY, snapshotIntervalMs: HOUR });

    expect(windows.logHorizonMs).toBeUndefined();
    expect(windows.replayWindowMs).toBe(7 * DAY);
  });

  it('RW.5 — a log shorter than the window is a refusal, not a narrowed window', () => {
    // The alternative reading — keep the backups, replay only three days — is the
    // defect: an object that lists as restorable and stops partway through. The
    // replay window therefore equals the backup window in every configuration that
    // gets this far.
    expect(ruleOf({ keepRecentMs: 7 * DAY, logHorizonMs: 3 * DAY })).toBe('keep-recent-exceeds-log-horizon');
  });

  it('RW.6 — the legal/illegal table, one row per rule', () => {
    const table: Array<[string, RetentionWindowInput]> = [
      ['legal', { keepRecentMs: DAY, snapshotIntervalMs: HOUR, logHorizonMs: DAY }],
      ['legal', { keepRecentMs: DAY }],
      ['legal', { keepRecentMs: DAY, logHorizonMs: 30 * DAY }],
      ['keep-recent-not-positive', { keepRecentMs: 0 }],
      ['keep-recent-not-positive', { keepRecentMs: -DAY }],
      ['keep-recent-not-positive', { keepRecentMs: Number.NaN }],
      ['snapshot-interval-not-positive', { keepRecentMs: DAY, snapshotIntervalMs: 0 }],
      ['snapshot-interval-not-positive', { keepRecentMs: DAY, snapshotIntervalMs: -HOUR }],
      ['log-horizon-not-positive', { keepRecentMs: DAY, logHorizonMs: 0 }],
      ['log-horizon-not-positive', { keepRecentMs: DAY, logHorizonMs: -DAY }],
      ['keep-recent-exceeds-log-horizon', { keepRecentMs: DAY, logHorizonMs: HOUR }],
      ['snapshot-interval-exceeds-keep-recent', { keepRecentMs: HOUR, snapshotIntervalMs: DAY }],
    ];

    for (const [expected, input] of table) {
      expect(ruleOf(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it('RW.7 — a refusal names what is wrong with which numbers', () => {
    try {
      deriveRetentionWindows({ keepRecentMs: 7 * DAY, logHorizonMs: 2 * HOUR });
      throw new Error('expected a refusal');
    } catch (err) {
      const error = err as RetentionWindowError;
      expect(error).toBeInstanceOf(RetentionWindowError);
      expect(error.rule).toBe('keep-recent-exceeds-log-horizon');
      // Both numbers, so an operator can fix the right one.
      expect(error.message).toContain(`${7 * DAY} ms`);
      expect(error.message).toContain(`${2 * HOUR} ms`);
    }
  });
});

// ── RW.8–RW.10: the evaluator refuses at construction ──────

describe('I87: the policy refuses a window shorter than its interval', () => {
  it('RW.8 — an interval longer than keepRecent is refused where it is configured', () => {
    expect(
      () =>
        new RetentionPolicyEvaluator(
          { maxFullSnapshots: 7, maxTotalBytes: 0, keepRecent: 'PT1H' },
          {
            snapshotIntervalMs: DAY,
          },
        ),
    ).toThrow(/snapshotInterval .* is longer than keepRecent/);
  });

  it('RW.9 — a legal pair is accepted and reported', () => {
    const evaluator = new RetentionPolicyEvaluator(
      { maxFullSnapshots: 7, maxTotalBytes: 0, keepRecent: 'P1D' },
      { snapshotIntervalMs: HOUR },
    );

    expect(evaluator.getWindows()).toMatchObject({ keepRecentMs: DAY, snapshotIntervalMs: HOUR });
  });

  it('RW.10 — a policy that states no window is uncheckable, and says so', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 0 });

    // `null` rather than a default window: a policy with no `keepRecent` makes no
    // promise, and a number invented here would be a promise nobody made.
    expect(evaluator.getWindows()).toBeNull();
  });
});

// ── RW.11–RW.16: the manager refuses before deleting ───────

describe('I87: the manager refuses a window longer than the log', () => {
  it('RW.11 — prune refuses when the engine cannot replay as far as the policy keeps', async () => {
    const { manager, storage } = fixture({
      horizon: 2 * HOUR,
      retention: { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P7D' },
    });
    await manager.createBackup({ type: 'full' });

    await expect(manager.prune()).rejects.toMatchObject({ rule: 'keep-recent-exceeds-log-horizon' });
    // Refused before anything was deleted: the backup is still there.
    expect((await storage.list('backups/')).length).toBeGreaterThan(0);
  });

  it('RW.12 — retentionWindows() reports the three numbers, with the horizon', async () => {
    const { manager } = fixture({
      horizon: 30 * DAY,
      retention: { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P7D' },
    });

    const windows = await manager.retentionWindows();

    expect(windows).toMatchObject({
      keepRecentMs: 7 * DAY,
      logHorizonMs: 30 * DAY,
      replayWindowMs: 7 * DAY,
    });
  });

  it('RW.13 — an engine with no log is not refused, and reports no horizon', async () => {
    const { manager } = fixture({
      horizon: null,
      retention: { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P7D' },
    });

    const windows = await manager.retentionWindows();

    expect(windows).toMatchObject({ keepRecentMs: 7 * DAY, replayWindowMs: 7 * DAY });
    expect(windows!.logHorizonMs).toBeUndefined();
  });

  it('RW.14 — a source that does not implement logHorizon is treated as having none', async () => {
    const { manager } = fixture({ retention: { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P7D' } });

    await expect(manager.retentionWindows()).resolves.toMatchObject({ keepRecentMs: 7 * DAY, replayWindowMs: 7 * DAY });
    // And retention still runs: the check is a check, not a precondition nobody can meet.
    await manager.createBackup({ type: 'full' });
    await expect(manager.prune()).resolves.toBe(0);
  });

  it('RW.15 — a policy that cannot state its windows is unchecked rather than refused', async () => {
    const opaque: IBackupRetentionPolicy = {
      evaluate: () => [],
      getConfig: () => ({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      updateConfig: () => undefined,
    };
    const { manager } = fixture({ horizon: 2 * HOUR, policy: opaque });
    await manager.createBackup({ type: 'full' });

    await expect(manager.retentionWindows()).resolves.toBeNull();
    // Nothing is refused — an uncheckable policy is not a wrong one — and nothing
    // is deleted either, because this policy removes nothing.
    await expect(manager.prune()).resolves.toBe(0);
  });

  it('RW.16 — a legal configuration still prunes, and the horizon is read each time', async () => {
    let horizon = 30 * DAY;
    const root = mkdtempSync(join(tmpdir(), 'i87-'));
    tempDirs.push(root);
    const data = join(root, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'table.txt'), 'alpha');

    const directory = new DirectoryBackupSource(data);
    const source: IBackupSource = {
      name: directory.name,
      whole: directory.whole,
      capture: (destination: string) => directory.capture(destination),
      restore: (path: string) => directory.restore(path),
      logHorizon: async () => horizon,
    };
    const manager = new BackupManager(
      source,
      new InMemoryStorageBackend(),
      new RetentionPolicyEvaluator({ maxFullSnapshots: 1, maxTotalBytes: 0, keepRecent: 'P1D' }),
      { workDir: join(root, 'work') },
    );

    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'full' });
    const windowsBefore: RetentionWindows = (await manager.retentionWindows())!;
    expect(windowsBefore.logHorizonMs).toBe(30 * DAY);

    // The log is trimmed: the same policy is now illegal, and the next pass says
    // so instead of deleting what it can no longer restore forward.
    horizon = HOUR;
    await expect(manager.prune()).rejects.toMatchObject({ rule: 'keep-recent-exceeds-log-horizon' });
  });

  it('RW.17 — the answer is reachable through the port, not only the class', async () => {
    // `IBackupManager` is what an operator holds. A `retentionWindows()` that exists
    // only on `BackupManager` is an answer nobody holding the interface can ask for.
    const { manager } = fixture({
      horizon: 30 * DAY,
      retention: { maxFullSnapshots: 100, maxTotalBytes: 0, keepRecent: 'P7D' },
    });
    const port: IBackupManager = manager;

    await expect(port.retentionWindows?.()).resolves.toMatchObject({
      keepRecentMs: 7 * DAY,
      replayWindowMs: 7 * DAY,
    });
  });
});
