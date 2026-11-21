/**
 * AC 94 — the artefact a backup actually is.
 *
 * `InMemoryBackupManager` never wrote a file, so nothing in this package had ever
 * asked what a backup *is* on disk. The answer is a container this package writes and
 * reads: a manifest, then the bytes it describes, with a digest for every file and a
 * length for the whole. These cases are about the container, not about the manager —
 * a manager that uploads it is tested next door.
 *
 * What each group is for:
 *
 *   Format — what a capture produces
 *     FA.1  a tree round-trips: nested directories, an empty directory, binary bytes
 *     FA.2  the same tree produces the same manifest, whatever order the directory is in
 *     FA.3  an empty directory is a backup of nothing, and restores as nothing
 *     FA.4  the outcome reports the artefact's size, not the source's
 *
 *   Refusals — what a capture will not do
 *     FA.5  a symbolic link is refused instead of followed or skipped
 *     FA.6  a file that changed between the two passes is refused, by name
 *     FA.7  an absolute path or a `..` segment out of a manifest is refused
 *
 *   Restore — what a reader trusts and what it checks
 *     FA.8  restore replaces: a file the snapshot never had is gone
 *     FA.9  a flipped byte is refused at the file whose digest it broke
 *     FA.10 an artefact that ends inside a file says how much is missing
 *     FA.11 trailing bytes are refused: this is not the artefact the manifest describes
 *     FA.12 a file that is not an artefact is refused by its magic
 *     FA.13 an artefact from a newer layout is refused by its version
 *     FA.14 an artefact that ends inside its manifest is refused, not guessed at
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  ARTIFACT_MAGIC,
  ARTIFACT_VERSION,
  assertUnchanged,
  readDirectoryArtifact,
  safeJoin,
  writeDirectoryArtifact,
} from '../impl/backupArtifact.js';
import type { ArtifactEntry, ArtifactManifest } from '../impl/backupArtifact.js';

let root: string;
let source: string;
let destination: string;
let artefact: string;

function put(path: string, content: string | Buffer): void {
  const full = join(source, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac94-'));
  source = join(root, 'source');
  destination = join(root, 'destination');
  artefact = join(root, 'artefact.dbsnap');
  mkdirSync(source, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The manifest a capture wrote, read back out of the artefact. */
function manifestOf(path: string): ArtifactManifest {
  const content = readFileSync(path);
  const first = content.indexOf(10);
  const second = content.indexOf(10, first + 1);
  return JSON.parse(content.subarray(first + 1, second).toString('utf8')) as ArtifactManifest;
}

describe('AC 94 — format', () => {
  it('FA.1: a tree round-trips: nested directories, an empty directory, binary bytes', async () => {
    put('a.txt', 'alpha');
    put('nested/b.bin', Buffer.from([0, 1, 2, 255, 254]));
    mkdirSync(join(source, 'empty'), { recursive: true });

    const capture = await writeDirectoryArtifact(source, artefact);
    expect(capture.files).toBe(2);
    expect(capture.sourceBytes).toBe(10);
    expect(capture.manifest.dirs).toEqual(['empty', 'nested']);

    const restore = await readDirectoryArtifact(artefact, destination);
    expect(restore).toMatchObject({ files: 2, bytes: 10, dirs: 2 });
    expect(readFileSync(join(destination, 'a.txt'), 'utf8')).toBe('alpha');
    expect([...readFileSync(join(destination, 'nested/b.bin'))]).toEqual([0, 1, 2, 255, 254]);
    expect(statSync(join(destination, 'empty')).isDirectory()).toBe(true);
  });

  it('FA.2: the same tree produces the same manifest, whatever order the directory is in', async () => {
    put('z.txt', 'last');
    put('m.txt', 'middle');
    put('a.txt', 'first');

    await writeDirectoryArtifact(source, artefact);
    const first = manifestOf(artefact);
    expect(first.files.map((f) => f.path)).toEqual(['a.txt', 'm.txt', 'z.txt']);

    // A second capture of the same tree must produce the same manifest: a backup
    // whose manifest depends on `readdir` order cannot be compared with the one
    // before it, which is how an operator notices a table that stopped being
    // included.
    await writeDirectoryArtifact(source, `${artefact}.2`);
    expect(manifestOf(`${artefact}.2`)).toEqual(first);
  });

  it('FA.3: an empty directory is a backup of nothing, and restores as nothing', async () => {
    const capture = await writeDirectoryArtifact(source, artefact);
    expect(capture.files).toBe(0);
    expect(capture.manifest).toEqual({ version: ARTIFACT_VERSION, dirs: [], files: [], totalBytes: 0 });

    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'stale.txt'), 'should not survive');
    const restore = await readDirectoryArtifact(artefact, destination);
    expect(restore.files).toBe(0);
    // Replacing is the contract: a restore into a populated directory leaves the
    // state the snapshot described, and nothing else.
    expect(() => readFileSync(join(destination, 'stale.txt'))).toThrow(/ENOENT/);
  });

  it('FA.4: the outcome reports the artefact size, not the source size', async () => {
    put('data.bin', Buffer.alloc(4096, 7));
    const capture = await writeDirectoryArtifact(source, artefact);
    const onDisk = readFileSync(artefact).length;
    expect(capture.bytes).toBe(onDisk);
    expect(capture.bytes).toBeGreaterThan(capture.sourceBytes);
  });
});

describe('AC 94 — refusals', () => {
  it('FA.5: a symbolic link is refused instead of followed or skipped', async () => {
    put('real.txt', 'content');
    symlinkSync(join(source, 'real.txt'), join(source, 'link.txt'));
    await expect(writeDirectoryArtifact(source, artefact)).rejects.toThrow(
      /link\.txt is a symbolic link — a backup cannot decide whether to follow it/,
    );
  });

  it('FA.6: a file that changed between the two passes is refused, by name', () => {
    const entry: ArtifactEntry = { path: 'a/b.txt', size: 5, sha256: 'a'.repeat(64) };
    expect(() => assertUnchanged(entry, 5, 'a'.repeat(64))).not.toThrow();
    // A shorter file and a same-length edit are two different accidents, and both
    // have to be refused: the second is the one a checksum exists for.
    expect(() => assertUnchanged(entry, 4, 'a'.repeat(64))).toThrow(
      /a\/b\.txt changed while it was being captured \(5 bytes hashed, 4 copied\)/,
    );
    expect(() => assertUnchanged(entry, 5, 'b'.repeat(64))).toThrow(/a\/b\.txt changed while it was being captured/);
  });

  it('FA.7: an absolute path or a .. segment out of a manifest is refused', () => {
    // A manifest is data from a bucket, and a bucket is not a trusted channel.
    expect(() => safeJoin('/srv/data', '../../etc/cron.d/x')).toThrow(/is not a path inside the backup/);
    expect(() => safeJoin('/srv/data', '/etc/passwd')).toThrow(/is not a path inside the backup/);
    expect(() => safeJoin('/srv/data', '')).toThrow(/is not a path inside the backup/);
    expect(safeJoin('/srv/data', 'db/table.bin')).toBe(join('/srv/data', 'db', 'table.bin'));
  });
});

describe('AC 94 — restore', () => {
  /** Capture a one-file tree and return the raw artefact bytes. */
  async function captured(): Promise<Buffer> {
    put('table.bin', '0123456789');
    await writeDirectoryArtifact(source, artefact);
    return readFileSync(artefact);
  }

  /** Replace the artefact with `bytes`, as a bucket that lost integrity would. */
  function damaged(bytes: Buffer, path = artefact): void {
    writeFileSync(path, bytes);
  }

  it('FA.8: restore replaces: a file the snapshot never had is gone', async () => {
    await captured();
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'invented.txt'), 'not in the backup');

    await readDirectoryArtifact(artefact, destination);
    expect(() => readFileSync(join(destination, 'invented.txt'))).toThrow(/ENOENT/);
    expect(readFileSync(join(destination, 'table.bin'), 'utf8')).toBe('0123456789');
  });

  it('FA.9: a flipped byte is refused at the file whose digest it broke', async () => {
    const bytes = await captured();
    const index = bytes.indexOf('0123456789');
    bytes[index + 3] = 'X'.charCodeAt(0);
    damaged(bytes);

    // The message names the file, not the backup: "row 3 of this table is wrong" is
    // an answer an operator can act on; "the backup is corrupt" is not.
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /table\.bin does not match its digest — the artefact is corrupt/,
    );
  });

  it('FA.10: an artefact that ends inside a file says how much is missing', async () => {
    const bytes = await captured();
    damaged(bytes.subarray(0, bytes.length - 4));
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /the artefact ends inside table\.bin \(4 bytes missing\)/,
    );
  });

  it('FA.11: trailing bytes are refused: this is not the artefact the manifest describes', async () => {
    const bytes = await captured();
    damaged(Buffer.concat([bytes, Buffer.from('appended')]));
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /the artefact has bytes after the last file it describes/,
    );
  });

  it('FA.12: a file that is not an artefact is refused by its magic', async () => {
    damaged(Buffer.from('PK\u0003\u0004 this is a zip, not a backup\n'));
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /not a directory artefact \(expected DBDIR1, found PK/,
    );
  });

  it('FA.13: an artefact from a newer layout is refused by its version', async () => {
    put('a.txt', 'x');
    await writeDirectoryArtifact(source, artefact);
    const manifest = { ...manifestOf(artefact), version: 99 };
    damaged(Buffer.from(`${ARTIFACT_MAGIC}\n${JSON.stringify(manifest)}\n`));
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /artefact version 99 cannot be read by this build/,
    );
  });

  it('FA.14: an artefact that ends inside its manifest is refused, not guessed at', async () => {
    damaged(Buffer.from(`${ARTIFACT_MAGIC}\n{"version":1,`));
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(/the artefact ends before its manifest/);
  });
});

describe('AC 94 — the manifest is data, and data can lie', () => {
  /** Write an artefact whose header is exactly what the test wants it to be. */
  function crafted(manifest: unknown, content: Buffer, path = artefact): void {
    writeFileSync(path, Buffer.concat([Buffer.from(`${ARTIFACT_MAGIC}\n${JSON.stringify(manifest)}\n`), content]));
  }

  it('FA.15: a manifest whose total disagrees with its files is refused', async () => {
    crafted(
      {
        version: ARTIFACT_VERSION,
        dirs: [],
        files: [{ path: 'a.txt', size: 3, sha256: createHash('sha256').update('abc').digest('hex') }],
        totalBytes: 99,
      },
      Buffer.from('abc'),
    );
    await expect(readDirectoryArtifact(artefact, destination)).rejects.toThrow(
      /restored 3 bytes, the manifest promised 99/,
    );
  });

  it('FA.16: a manifest larger than the reader allows is refused, not allocated', async () => {
    put('a.txt', 'x');
    await writeDirectoryArtifact(source, artefact);
    // The ceiling is a parameter, so the branch that enforces it is a branch a test
    // can reach: an artefact whose header alone exceeds the budget.
    await expect(readDirectoryArtifact(artefact, destination, { maxManifestBytes: 32 })).rejects.toThrow(
      /the artefact manifest is larger than 32 bytes/,
    );
  });

  it('FA.17: a named pipe is refused rather than blocking the capture forever', async () => {
    // A data directory that contains a FIFO is not a data directory: opening one for
    // reading waits for a writer that never comes, which is a backup that hangs
    // instead of failing.
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('mkfifo', [join(source, 'pipe')]);
    } catch {
      // A platform without `mkfifo` cannot produce the input; the case is skipped
      // rather than asserted against a file it could not create.
      return;
    }
    await expect(writeDirectoryArtifact(source, artefact)).rejects.toThrow(/pipe is not a regular file/);
  });
});

describe('AC 94 — the manifest grows', () => {
  it('FA.18: a tree whose manifest exceeds one read still round-trips', async () => {
    // The reader starts with a 4 KiB buffer and doubles it. A manifest under that
    // size never exercises the doubling, which is the path a directory with a few
    // hundred files takes every time.
    for (let i = 0; i < 200; i += 1) put(`dir-${String(i).padStart(3, '0')}/file.txt`, `row ${i}`);
    const capture = await writeDirectoryArtifact(source, artefact);
    expect(capture.files).toBe(200);

    const manifestLine = readFileSync(artefact)
      .subarray(0, 4096 * 2)
      .toString('utf8')
      .split('\n')[1]!;
    expect(Buffer.byteLength(manifestLine)).toBeGreaterThan(4096);

    const restore = await readDirectoryArtifact(artefact, destination);
    expect(restore.files).toBe(200);
    expect(readFileSync(join(destination, 'dir-199/file.txt'), 'utf8')).toBe('row 199');
  });
});
