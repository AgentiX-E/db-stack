/**
 * AC 87 — retention is a decision, and the decision has four answers.
 *
 * The mutation gate reported a change to this one expression as *survived* — and it
 * was right. `mtime === null || mtime >= cutoff` → `false || mtime >= cutoff` is a
 * different program only for a segment whose date cannot be read, and no case in the
 * suite ever produced one: all 162 cases pass with the mutant in place. The line was
 * covered; the *arm* was not, which is the difference between "this code ran" and
 * "this code was asked a question".
 *
 * So the rule is a function, and the question is asked directly:
 *
 *   EX.1  a date that cannot be read is not an expiry
 *   EX.2  the boundary is the cutoff, and the comparison is strict
 *   EX.3  the sweep deletes what is past retention and keeps what is inside it — the
 *         store-level version, asked through a planted segment rather than a stub
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAuditStore, isExpired } from '../impl/FileAuditStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac87-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (operation: string) => ({ operation, actor: 'user', resource: '/db', result: 'success' as const });

describe('AC 87 — what counts as expired', () => {
  it('EX.1: a date that cannot be read is not an expiry', () => {
    // Deleting a segment because its `stat` failed turns an I/O error into permanent
    // loss of evidence. The rule is "unknown is not expired", and it is one of four
    // cases rather than the left half of a disjunction nothing could reach.
    expect(isExpired(null, Date.now())).toBe(false);
    // Even with a cutoff in the far future, where everything *readable* is expired:
    // the answer is about the missing date, not about the window.
    expect(isExpired(null, Date.now() + 10 * 86_400_000)).toBe(false);
  });

  it('EX.2: the boundary is the cutoff, and the comparison is strict', () => {
    const cutoff = 1_700_000_000_000;

    // Exactly at the cutoff is still inside the window. A `<=` here would delete a
    // segment whose newest possible line is the first outside retention — the wrong
    // side of a boundary customers reason about.
    expect(isExpired(cutoff, cutoff)).toBe(false);
    expect(isExpired(cutoff + 1, cutoff)).toBe(false);

    // Outside it, by one millisecond.
    expect(isExpired(cutoff - 1, cutoff)).toBe(true);
    expect(isExpired(0, cutoff)).toBe(true);
  });

  it('EX.3: the sweep deletes what is past retention and keeps what is inside it', async () => {
    // A planted segment is the only way to ask this at the store level: the sweep runs
    // on rotation and reads the directory, so a file that is already old when the
    // rotation happens is the "past retention" answer and the live one is the "inside"
    // answer, both present at the same moment.
    //
    // The planted name is older than the live segment on purpose. A store adopts the
    // newest open segment, and an adopted file is archived by the first rotation — its
    // entries would survive under a fresh archive, which is a different (and correct)
    // behaviour, and would hide the one this case is about.
    const first = new FileAuditStore({ dataDir: dir, maxFileSize: 1, retentionDays: 1 });
    await first.write(entry('FRESH_1'));
    await first.close();

    const old = join(dir, 'audit-19990101-0001.ndjson');
    writeFileSync(old, JSON.stringify({ id: 'ancient', operation: 'ANCIENT' }) + '\n');
    utimesSync(old, new Date('1999-01-01T00:00:00Z'), new Date('1999-01-01T00:00:00Z'));

    const second = new FileAuditStore({ dataDir: dir, maxFileSize: 1, retentionDays: 1 });
    await second.write(entry('FRESH_2'));
    await second.close();

    expect(existsSync(old), 'a segment past retention was left behind').toBe(false);
    // And the segments inside the window are untouched: a sweep that deletes by
    // accident passes the assertion above and fails this one — both entries are still
    // readable, one of them through the archive rotation made.
    expect(await second.count()).toBe(2);
  });
});
