/**
 * FileSystemStorageBackend — a bucket that is a directory.
 *
 * The three storage backends a deployment actually picks between are "the cloud",
 * "a disk that is not this one", and "the disk this one has". `S3StorageBackend`
 * covers the first and `InMemoryStorageBackend` covers none of them: it is a `Map`,
 * so its objects are gone when the process is. This class covers the other two — an
 * NFS mount, a SAN volume, a bind mount into a backup host — and it is the one that
 * makes a backup survive the process that took it, which is the only property a
 * backup has ever been sold on.
 *
 * Two things here are not obvious and both are about what a *partial* write means:
 *
 *   1. **An object appears whole or not at all.** `upload` copies to
 *      `<key>.partial` and renames. A process killed mid-copy therefore leaves a
 *      file that `list` does not return, rather than an object at the right key with
 *      the wrong length. The rename is what makes the key mean something.
 *   2. **A key is not a path.** Keys come from a manager, but a bucket is an
 *      interface and the next implementation of it may be handed anything, so every
 *      key goes through `safeJoin`: `..` and absolute keys are refused instead of
 *      being resolved into the operator's home directory.
 *
 * `download` makes the same partial-then-rename move for the same reason: a
 * destination that exists is a destination somebody will read, and half an artefact
 * at a path that was promised a whole one is how a corrupt restore starts.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { IStorageBackend } from '../interfaces/index.js';
import { safeJoin } from './backupArtifact.js';

/** Suffix a half-written object carries until it is renamed into place. */
export const PARTIAL_SUFFIX = '.partial';

/**
 * A listing, ordered by key.
 *
 * A function rather than a sort call in the middle of a walk, because the ordering is
 * a *rule* — a listing is compared, and two runs against the same bucket have to produce
 * the same array — and a rule expressed as an inline comparator cannot be handed a
 * shuffled list by a test. A directory's read order is not a promise; this is.
 *
 * The equality arm returns `0` rather than falling through to `1`. A comparator that
 * answers "later" for both `(a, b)` and `(b, a)` is not a total order, and `Array.sort`
 * is then free to answer anything for a pair it cannot separate; keys from one bucket are
 * distinct, so it costs nothing to say so instead of leaving the answer to the engine.
 *
 * Two mutants of this line survive the suite, and both are invisible on purpose:
 *
 *   - `a.key <= b.key` — with equality decided by the arm above, the second comparison is
 *     only reached for distinct keys, where `<=` and `<` agree;
 *   - the equality arm replaced by a constant `false` — the comparator then answers `1` for
 *     an equal pair, which `Array.sort` treats as "already in order": measured on this
 *     engine for every length from 2 to 30, the permutation is unchanged. `FS.14` states
 *     the order that the surviving arm promises, and it is the strongest statement a test
 *     can make here — the engine's handling of an inconsistent comparator is not
 *     specified, so no input can distinguish the two.
 */
export function orderedByKey<T extends { key: string }>(objects: T[]): T[] {
  return objects.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));
}

/** Configuration for `FileSystemStorageBackend`. */
export interface FileSystemStorageBackendConfig {
  /**
   * Directory that holds the bucket.
   *
   * Resolved once, at construction: a relative root would be re-interpreted against
   * `process.cwd()` at every use, and the working directory belongs to the process
   * rather than to the bucket — so a service that changed it would write to a
   * different bucket without any call saying so.
   */
  root: string;
}

/**
 * A bucket backed by a directory tree.
 *
 * Objects are files; keys are POSIX-style relative paths (`backups/full/snap-1.artifact`).
 * The class holds no state beyond the resolved root, so two processes pointed at the
 * same directory see the same bucket — which is the point.
 */
export class FileSystemStorageBackend implements IStorageBackend {
  readonly name = 'filesystem';

  private readonly root: string;

  constructor(config: FileSystemStorageBackendConfig) {
    this.root = resolve(config.root);
  }

  /** The directory this bucket lives in, as an absolute path. */
  get directory(): string {
    return this.root;
  }

  /** @inheritdoc */
  async upload(sourcePath: string, destKey: string): Promise<void> {
    const target = safeJoin(this.root, destKey);
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}${PARTIAL_SUFFIX}`;
    await copyFile(sourcePath, partial);
    // The rename is the commit. A `.partial` file is not an object, and `list`
    // does not return one — so a killed upload leaves no key behind to be restored.
    await rename(partial, target);
  }

  /** @inheritdoc */
  async download(sourceKey: string, destPath: string): Promise<void> {
    const source = safeJoin(this.root, sourceKey);
    await mkdir(dirname(destPath), { recursive: true });
    const partial = `${destPath}${PARTIAL_SUFFIX}`;
    await copyFile(source, partial);
    await rename(partial, destPath);
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const found: Array<{ key: string; size: number; lastModified: string }> = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(directory, entry.name);
        // Symlinks are skipped rather than followed: a link is a name whose value
        // lives outside the bucket, and a listing that follows one reports an object
        // the bucket does not hold.
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(PARTIAL_SUFFIX)) continue;
        const key = relative(this.root, path).split(sep).join('/');
        if (!key.startsWith(prefix)) continue;
        const info = await stat(path);
        found.push({ key, size: info.size, lastModified: info.mtime.toISOString() });
      }
    };
    await walk(this.root);
    return orderedByKey(found);
  }

  /** @inheritdoc */
  async delete(key: string): Promise<void> {
    await rm(safeJoin(this.root, key), { force: true });
  }

  /** @inheritdoc */
  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await access(this.root, constants.W_OK);
      return { ok: true };
    } catch (error) {
      // The rejection itself, not a sentence about it: an operator greps this, and
      // `Error:` in front of `ENOENT` costs nothing a person reads.
      return { ok: false, message: String(error) };
    }
  }

  /** @inheritdoc */
  async getUsageBytes(): Promise<number> {
    const objects = await this.list('');
    return objects.reduce((total, object) => total + object.size, 0);
  }
}
