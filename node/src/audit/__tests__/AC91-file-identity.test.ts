/**
 * AC 91 — file identity is about the file that is there.
 *
 * `unlinkIfUnchanged` exists because a rotation that removes a segment has to
 * remove the file it measured and no other. Between the measure and the unlink,
 * another writer can unlink the segment and recreate a file of the same name —
 * and a filesystem is free to hand the new file the same inode number, so the
 * decision cannot rest on the name alone. It cannot rest on the size alone
 * either: same name, same length, different file is the ordinary shape of a
 * segment recreated by a second writer.
 *
 * Two cases pin the two halves of that rule: a different file of the same size
 * is not the file that was measured, and an identity taken from a path that no
 * longer exists does not dereference.
 *
 * Both cases lived in the `security` package until iteration 54, importing these
 * helpers across a package boundary — possible only because they were exported
 * from this package's root. A test of `FileAuditStore`'s unlink path belongs next
 * to the store; the cross-package import was the symptom and the root export was
 * the cause.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileIdentity, unlinkIfUnchanged } from '../impl/FileAuditStore.js';

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac91-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AC 91 — a different file of the same size is not the file that was measured', () => {
  it('91.1 the unlink is refused when the inode changed under the same name', () => {
    const file = path.join(scratch(), 'same-size.ndjson');
    fs.writeFileSync(file, 'AAAAA');
    const measured = fileIdentity(file)!;

    // Same name, same length, different file. The recorded survivor replaced
    // `actual.ino !== expected.ino` with `false`, which leaves only the size
    // comparison — and a size is not an identity. This is the whole reason the
    // helper exists: delete only the file you measured.
    fs.rmSync(file);
    fs.writeFileSync(file, 'BBBBB');

    expect(unlinkIfUnchanged(file, measured)).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('BBBBB');
  });

  it('91.2 the unlink proceeds when the file is the one that was measured', () => {
    // The other direction, because "always refuse" would also satisfy 91.1 and
    // would leave every rotated segment on disk forever.
    const file = path.join(scratch(), 'untouched.ndjson');
    fs.writeFileSync(file, 'aline\n');
    const measured = fileIdentity(file)!;

    expect(unlinkIfUnchanged(file, measured)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('91.3 identity of a path that no longer exists is null, not a throw', () => {
    const file = path.join(scratch(), 'gone.ndjson');
    fs.writeFileSync(file, 'x');
    const identity = { ino: 1, size: 1 };
    fs.rmSync(file);

    // The recorded survivor dropped `if (!actual) return false`, which left the
    // comparison dereferencing null. Deleting a file between "measure" and
    // "unlink" is the case this helper exists for.
    expect(unlinkIfUnchanged(file, identity)).toBe(false);
  });
});
