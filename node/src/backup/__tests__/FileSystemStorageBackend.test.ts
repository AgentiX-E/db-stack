/**
 * AC 96 — a bucket that is a directory.
 *
 * `FileSystemStorageBackend` exists for two reasons and the cases below are grouped
 * by them:
 *
 *   - **A backup has to survive the process that took it.** The in-memory backend is a
 *     `Map`; the objects in it are gone when the process is. A directory on a mounted
 *     volume is the smallest thing that is not — and it is what makes the
 *     out-of-process probe in `AC97` a measurement of the product rather than of a
 *     shared heap.
 *   - **A key is not a path.** A bucket is an interface, so the next implementation of
 *     it may be handed any string at all. Every key goes through `safeJoin`, which
 *     refuses `..` and absolute paths instead of resolving them into the operator's
 *     home directory.
 *
 * The other property that is worth stating is the one about half-written objects:
 * `upload` copies to `<key>.partial` and renames, so an object either exists at its
 * key or does not exist. A process killed mid-upload therefore leaves a file that
 * `list` will not return — not an object at the right key with the wrong length, which
 * is the shape a restore cannot tell from a good one.
 *
 *   FS.1  a round trip: upload, list, download, delete
 *   FS.2  a listing is filtered by key prefix and sorted, because it is compared
 *   FS.3  a key with `..` in it is refused
 *   FS.4  an absolute key is refused
 *   FS.5  a `.partial` file is not an object
 *   FS.6  `health()` answers about the directory, and says why when it cannot
 *   FS.7  `getUsageBytes()` is the sum of the objects
 *   FS.8  the root is pinned at construction, so a relative one cannot be re-read
 *   FS.9  a download of a key that is not there rejects
 *   FS.10 a nested key creates its directories, and a delete of a missing key is quiet
 *   FS.11 a symlink in the bucket is not an object
 *   FS.12 an upload over an existing key replaces it whole
 *   FS.13 the listing rule sorts a shuffled list, and the listing goes through it
 *   FS.14 two objects with the same key keep the order they arrived in
 *   FS.15 a bucket that does not exist yet is empty and unhealthy, not an error
 *   FS.16 the backend names itself, and so does the suffix it stages with
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { FileSystemStorageBackend, PARTIAL_SUFFIX, orderedByKey } from '../impl/FileSystemStorageBackend.js';

let root: string;
let bucket: FileSystemStorageBackend;

/** A file to upload, with a body. */
function file(name: string, body: string): string {
  const path = join(root, 'staging', name);
  mkdirSync(join(root, 'staging'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fsb-'));
  bucket = new FileSystemStorageBackend({ root: join(root, 'bucket') });
  mkdirSync(join(root, 'bucket'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AC 96 — a bucket that is a directory', () => {
  it('FS.1: a round trip keeps every byte and names the object the way it was named', async () => {
    await bucket.upload(file('a.bin', 'first object'), 'backups/full/a.artifact');

    expect(await bucket.list('backups/')).toMatchObject([{ key: 'backups/full/a.artifact', size: 12 }]);

    const down = join(root, 'down.bin');
    await bucket.download('backups/full/a.artifact', down);
    expect(readFileSync(down, 'utf8')).toBe('first object');

    await bucket.delete('backups/full/a.artifact');
    expect(await bucket.list('backups/')).toEqual([]);
  });

  it('FS.2: a listing is filtered by prefix and sorted, because it is compared', async () => {
    await bucket.upload(file('c', 'c'), 'backups/full/c.artifact');
    await bucket.upload(file('a', 'a'), 'backups/full/a.artifact');
    await bucket.upload(file('r', 'r'), 'backups/inventory/a.json');

    // A directory's read order is not a promise, so the order is made one: two runs
    // against the same bucket produce the same array.
    expect((await bucket.list('backups/full/')).map((o) => o.key)).toEqual([
      'backups/full/a.artifact',
      'backups/full/c.artifact',
    ]);
    // A full key works as a prefix, which is what the manager's confirmation asks for.
    expect((await bucket.list('backups/full/a.artifact')).map((o) => o.key)).toEqual(['backups/full/a.artifact']);
    expect(await bucket.list('nothing/')).toEqual([]);
  });

  it('FS.3: a key with `..` in it is refused', async () => {
    await expect(bucket.upload(file('x', 'x'), '../../escaped.bin')).rejects.toThrow(/is not a path inside the backup/);
    // Nothing landed beside the bucket either, which is where `..` would have put it.
    expect(readdirSync(root).includes('escaped.bin')).toBe(false);
  });

  it('FS.4: an absolute key is refused', async () => {
    await expect(bucket.upload(file('x', 'x'), '/tmp/absolute.bin')).rejects.toThrow(/is not a path inside the backup/);
    await expect(bucket.download('/etc/passwd', join(root, 'nope'))).rejects.toThrow(/is not a path inside/);
    await expect(bucket.delete('../outside')).rejects.toThrow(/is not a path inside/);
  });

  it('FS.5: a `.partial` file is not an object', async () => {
    // What a killed upload leaves behind. It is exactly the shape a naive `list`
    // would report, at the size it got to, which is why the rename is the commit.
    mkdirSync(join(root, 'bucket', 'backups'), { recursive: true });
    writeFileSync(join(root, 'bucket', 'backups', `half.artifact${PARTIAL_SUFFIX}`), 'half');

    expect(await bucket.list('backups/')).toEqual([]);
    expect(await bucket.getUsageBytes()).toBe(0);
  });

  it('FS.6: health answers about the directory, and says why when it cannot', async () => {
    expect(await bucket.health()).toEqual({ ok: true });

    const missing = new FileSystemStorageBackend({ root: join(root, 'absent') });
    const report = await missing.health();
    expect(report.ok).toBe(false);
    // The message is the failure, not a sentence about one: an operator greps it.
    expect(report.message).toMatch(/ENOENT/);
  });

  it('FS.7: getUsageBytes is the sum of the objects', async () => {
    await bucket.upload(file('a', 'aaaa'), 'x/a');
    await bucket.upload(file('b', 'bb'), 'x/b');
    // Not the size of the directory: a filesystem's own metadata is not the bucket's.
    expect(await bucket.getUsageBytes()).toBe(6);
  });

  it('FS.8: the root is pinned at construction, so a relative one cannot be re-read', async () => {
    // The lesson `AC 92` measured in a child process: a relative directory is
    // re-interpreted against `process.cwd()` at every use, and the working directory
    // belongs to the process rather than to the bucket.
    const relative = new FileSystemStorageBackend({ root: 'some/bucket' });
    expect(relative.directory).toBe(resolve('some/bucket'));
    expect(relative.directory.startsWith('/')).toBe(true);
  });

  it('FS.9: a download of a key that is not there rejects', async () => {
    await expect(bucket.download('backups/full/absent.artifact', join(root, 'out.bin'))).rejects.toThrow(/ENOENT/);
    // And it leaves nothing behind: a destination that exists is a destination
    // somebody will read as if it were an artefact.
    expect(readdirSync(root).includes('out.bin')).toBe(false);
  });

  it('FS.10: a nested key creates its directories, and a delete of a missing key is quiet', async () => {
    await bucket.upload(file('deep', 'deep'), 'a/b/c/d.artifact');
    expect(await bucket.list('a/b/')).toMatchObject([{ key: 'a/b/c/d.artifact' }]);
    // A delete is a statement about the end state, not about the start: deleting
    // something already gone is the state the caller asked for.
    await expect(bucket.delete('a/b/c/never.artifact')).resolves.toBeUndefined();
  });

  it('FS.11: a symlink in the bucket is not an object', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'secret.bin'), 'outside');
    symlinkSync(elsewhere, join(root, 'bucket', 'link'));

    // A link is a name whose value lives outside the bucket, and a listing that
    // followed one would report an object the bucket does not hold.
    expect(await bucket.list('')).toEqual([]);
  });

  it('FS.12: an upload over an existing key replaces it whole', async () => {
    await bucket.upload(file('long', 'a much longer body'), 'x/a');
    await bucket.upload(file('short', 'short'), 'x/a');
    expect(await bucket.list('x/')).toMatchObject([{ key: 'x/a', size: 5 }]);

    const down = join(root, 'down');
    await bucket.download('x/a', down);
    expect(readFileSync(down, 'utf8')).toBe('short');
  });
});

it('FS.13: a listing is ordered by key whatever order the filesystem read them', async () => {
  // `list` hands the walk's output through this, and the walk's order is a promise
  // only in that it is some order. The rule is expressed as a function so a shuffled
  // list can be handed to it.
  const shuffled = [{ key: 'x/z' }, { key: 'x/a' }, { key: 'x/m' }, { key: 'x/b' }];
  expect(orderedByKey(shuffled).map((object) => object.key)).toEqual(['x/a', 'x/b', 'x/m', 'x/z']);
  expect(orderedByKey([])).toEqual([]);

  // And the listing itself goes through it: created in an order that is not the
  // sorted one, returned in the sorted one.
  await bucket.upload(file('z', 'z'), 'k/z');
  await bucket.upload(file('a', 'a'), 'k/a');
  await bucket.upload(file('m', 'm'), 'k/m');
  expect((await bucket.list('k/')).map((object) => object.key)).toEqual(['k/a', 'k/m', 'k/z']);
});

it('FS.14: two objects with the same key keep the order they arrived in', () => {
  // A comparator has to answer `0` for a pair it cannot separate. Answering "later" for
  // both `(a, b)` and `(b, a)` is not a total order, and `Array.sort` may then reverse a
  // pair that is equal — which is a listing that differs between two runs of the same
  // bucket. A key is a path and a walk cannot visit one twice, so this never happens in
  // `list`; the case exists because `orderedByKey` is exported and the rule it states is
  // the reason a caller may rely on the order at all.
  const sameKey = [
    { key: 'x/a', seq: 1 },
    { key: 'x/a', seq: 2 },
    { key: 'x/a', seq: 3 },
  ];
  expect(orderedByKey(sameKey).map((object) => object.seq)).toEqual([1, 2, 3]);
});

it('FS.15: a bucket that does not exist yet is empty, not an error', async () => {
  // A deployment configures the root before the mount is there. A `list` that threw
  // would be a manager that cannot even report that it has no backups.
  const absent = new FileSystemStorageBackend({ root: join(root, 'not-mounted') });
  expect(await absent.list('')).toEqual([]);
  expect(await absent.list('backups/')).toEqual([]);
  expect(await absent.getUsageBytes()).toBe(0);
  // And it says so when asked about its health, rather than pretending.
  expect((await absent.health()).ok).toBe(false);
});

it('FS.16: the backend names itself, because a log line needs it', async () => {
  expect(bucket.name).toBe('filesystem');
  expect(PARTIAL_SUFFIX).toBe('.partial');
});
