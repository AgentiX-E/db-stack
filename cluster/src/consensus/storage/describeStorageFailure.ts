/**
 * describeStorageFailure — turn "disk I/O error" into something an operator can act on.
 *
 * Why this exists
 * ---------------
 * `better-sqlite3` reports every I/O problem as `SqliteError: disk I/O error`, with
 * no path, no errno and no sense of which filesystem it was writing to. The message
 * arrived at a caller as the *whole* diagnosis, and the interesting question — is the
 * disk full, or is the filesystem's host out of memory? — could not be answered from
 * the process.
 *
 * It matters here because the suites and, in some deployments, the storage directory
 * live on **tmpfs**: `/dev/shm` reports gigabytes free while a write fails with
 * `ENOSPC`, because tmpfs pages are charged to the memory cgroup rather than to the
 * mount's own accounting. Two such failures were investigated on 2026-11-18 from a
 * message that contained none of that (P3-31).
 *
 * So the failure carries the file, the directory, the free and total space, and the
 * one sentence that turns a puzzle into a hypothesis. It does not swallow anything:
 * the original error is the `cause`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Render a byte count the way an operator reads it.
 *
 * One decimal below ten and none above, because "8 GB free" is a decision and
 * "8.4 GB free" is noise at that magnitude. `statfs` reports unsigned block
 * counts, so there is no negative or non-finite case to guard.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Describe a storage failure with the context `better-sqlite3` leaves out.
 *
 * @param file - Database file the operation was working on.
 * @param err - The original failure; kept verbatim in the message and as `cause`.
 * @returns A single-sentence diagnosis including the directory's free space.
 */
export function describeStorageFailure(file: string, err: unknown): string {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);

  let space: string;
  try {
    const stat = fs.statfsSync(dir);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    space = `${formatBytes(free)} free of ${formatBytes(total)}`;
  } catch (spaceErr: unknown) {
    // A directory that cannot even be statted is itself the answer, and it must
    // not replace the original failure with a second one.
    space = `free space unknown (${messageOf(spaceErr)})`;
  }

  return (
    `SqliteStorage could not use ${resolved}: ${messageOf(err)}. ` +
    `Directory ${dir} has ${space}. ` +
    'A "disk I/O error" on a filesystem that reports free space usually means the ' +
    "filesystem's host is out of memory or quota — tmpfs pages are charged to the " +
    'memory cgroup, not to the mount — or that another process holds the file.'
  );
}
