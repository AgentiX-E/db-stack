/**
 * Retention windows — one derivation over the three numbers retention depends on.
 *
 * A backup's policy says how long a backup must survive (`keepRecent`). Two other
 * numbers decide whether that promise can be kept, and neither used to be related
 * to it:
 *
 *   - **how often a snapshot is taken.** A window shorter than the interval can
 *     expire between two backups, so a retention pass may delete the only restore
 *     that exists.
 *   - **how far back the engine's log can replay.** A backup older than the log
 *     horizon can be restored to its snapshot and no further, so a policy that
 *     keeps a week of backups in front of a two-hour log is keeping a week of
 *     objects that look restorable and are not.
 *
 * Both are refusals rather than warnings, because both produce a backup set an
 * operator believes in and cannot use. The shape is the one the federation half of
 * this work uses (`federation/src/storage/retention.ts`): a pure function, named
 * rules, and a table of legal and illegal tuples.
 *
 * The log horizon is the engine's to answer — it is the one number the middleware
 * cannot know — which is why `IBackupSource` gained an optional `logHorizon()`.
 *
 * @module @agentix-e/db-node/backup/impl
 */

/** The three numbers, as the caller knows them. */
export interface RetentionWindowInput {
  /** How long a backup must survive, in milliseconds. */
  keepRecentMs: number;
  /** How often a snapshot is taken, in milliseconds, when the caller said. */
  snapshotIntervalMs?: number;
  /** How far back the engine's log can replay, in milliseconds, when it keeps one. */
  logHorizonMs?: number;
}

/** The derivation, with the two consequences a caller needs. */
export interface RetentionWindows extends RetentionWindowInput {
  /**
   * The window a restore can be replayed forward through, and therefore the window
   * in which a backup is fully restorable.
   *
   * Equal to `keepRecentMs` by construction: a horizon shorter than the window is
   * refused, so the two can only agree. It is stated because it is the number an
   * operator asks for — "how far back can I go" — and because the equality is the
   * invariant this module exists to enforce rather than a coincidence to be
   * discovered at restore time.
   */
  replayWindowMs: number;
}

/** The rule a refusal names, so a caller can report it without parsing prose. */
export type RetentionWindowRule =
  | 'keep-recent-not-positive'
  | 'snapshot-interval-not-positive'
  | 'snapshot-interval-exceeds-keep-recent'
  | 'log-horizon-not-positive'
  | 'keep-recent-exceeds-log-horizon';

/** A retention configuration whose windows do not contain each other. */
export class RetentionWindowError extends Error {
  constructor(
    readonly rule: RetentionWindowRule,
    message: string,
  ) {
    super(message);
    this.name = 'RetentionWindowError';
  }
}

/**
 * Derive the windows, or refuse the configuration that produced them.
 *
 * The comparison is inclusive in the two places it can be: a window equal to the
 * interval still has a snapshot at every point in it, and a window equal to the
 * log horizon still replays. Only a window that is *shorter* loses a backup, and
 * only a horizon that is *shorter* loses the replay.
 */
export function deriveRetentionWindows(input: RetentionWindowInput): RetentionWindows {
  const { keepRecentMs, snapshotIntervalMs, logHorizonMs } = input;

  if (!Number.isFinite(keepRecentMs) || keepRecentMs <= 0) {
    throw new RetentionWindowError(
      'keep-recent-not-positive',
      `keepRecent must be a positive duration, got ${keepRecentMs} ms — ` +
        'a window of nothing keeps nothing, and retention would delete every backup it has',
    );
  }

  if (snapshotIntervalMs !== undefined) {
    if (!Number.isFinite(snapshotIntervalMs) || snapshotIntervalMs <= 0) {
      throw new RetentionWindowError(
        'snapshot-interval-not-positive',
        `snapshotInterval must be a positive duration, got ${snapshotIntervalMs} ms`,
      );
    }
    if (snapshotIntervalMs > keepRecentMs) {
      throw new RetentionWindowError(
        'snapshot-interval-exceeds-keep-recent',
        `snapshotInterval ${snapshotIntervalMs} ms is longer than keepRecent ${keepRecentMs} ms: ` +
          'the window can expire between two snapshots, so a retention pass may delete the only ' +
          'restore there is',
      );
    }
  }

  if (logHorizonMs !== undefined) {
    if (!Number.isFinite(logHorizonMs) || logHorizonMs <= 0) {
      throw new RetentionWindowError(
        'log-horizon-not-positive',
        `the engine reports a log horizon of ${logHorizonMs} ms — ` + 'a positive number, or null when it keeps no log',
      );
    }
    if (logHorizonMs < keepRecentMs) {
      throw new RetentionWindowError(
        'keep-recent-exceeds-log-horizon',
        `keepRecent ${keepRecentMs} ms is longer than the engine's log horizon ${logHorizonMs} ms: ` +
          'backups older than the horizon restore to their snapshot and cannot be replayed forward',
      );
    }
  }

  return {
    keepRecentMs,
    ...(snapshotIntervalMs === undefined ? {} : { snapshotIntervalMs }),
    ...(logHorizonMs === undefined ? {} : { logHorizonMs }),
    replayWindowMs: keepRecentMs,
  };
}
