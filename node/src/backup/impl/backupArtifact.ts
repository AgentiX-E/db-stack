/**
 * The artefact a directory backup writes: a manifest, then the bytes it describes.
 *
 * The format exists because a backup is a file that has to survive a trip through
 * a bucket, a tape and a decade, and "the engine's own format" is not something the
 * middleware can verify. What it can verify is a container it wrote itself:
 *
 * ```
 * DBDIR1\n
 * {"version":1,"dirs":[...],"files":[{"path":"a/b","size":12,"sha256":"…"},…],"totalBytes":12}\n
 * <file 1 bytes><file 2 bytes>…
 * ```
 *
 * Three properties, each of which is why a line of this file looks the way it does:
 *
 *   1. **The manifest comes first.** A reader knows what the rest of the file must
 *      contain before it reads any of it, so a truncated artefact is refused at the
 *      size it claims, not discovered as a file that ends early.
 *   2. **Every file carries its own digest.** A restore recomputes it while writing
 *      and refuses the file, not the backup: "row 3 of this table is wrong" is an
 *      answer an operator can act on.
 *   3. **The capture hashes twice.** Once to build the manifest, once while copying.
 *      A file that changed in between — an engine that was not quiesced — fails the
 *      capture instead of producing an artefact that restores a state no moment
 *      ever held. This is the only thing in the format that costs I/O, and it is
 *      the difference between a backup and a copy of some files.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/** First line of every artefact. Bumped only when the layout changes. */
export const ARTIFACT_MAGIC = 'DBDIR1';

/** Manifest version, stored inside the manifest as well as in the magic. */
export const ARTIFACT_VERSION = 1;

/**
 * How large a manifest this reader will assemble before it gives up.
 *
 * A manifest for a directory with a hundred thousand files is legitimately a few
 * megabytes; a 64 MiB one is not a manifest any more. The ceiling exists so that a
 * corrupt header — or a bucket that returned something else entirely — fails the
 * read instead of becoming an allocation, and it is a parameter of the read rather
 * than a constant so that a deployment with an unusual tree can raise it and a test
 * can lower it.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** One captured file, as the manifest lists it. */
export interface ArtifactEntry {
  /** Path relative to the captured directory, `/`-separated. */
  path: string;
  /** Exact byte length. */
  size: number;
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
}

/** What a reader needs to know before it reads any content. */
export interface ArtifactManifest {
  version: number;
  /** Directories, relative and `/`-separated, including empty ones. */
  dirs: string[];
  /** Files, sorted by path, so two captures of one tree produce one manifest. */
  files: ArtifactEntry[];
  /** Sum of `files[].size` — the content length the reader must find. */
  totalBytes: number;
}

/** What a capture produced. */
export interface CaptureOutcome {
  /** Artefact size on disk, in bytes. */
  bytes: number;
  /** Number of files captured. */
  files: number;
  /** Sum of the captured files' sizes. */
  sourceBytes: number;
  manifest: ArtifactManifest;
}

/** What a restore consumed. */
export interface RestoreOutcome {
  files: number;
  /** Sum of the files' sizes. */
  bytes: number;
  dirs: number;
}

/**
 * Where a manifest path is allowed to land.
 *
 * A manifest is data from a bucket, and a bucket is not a trusted channel: an
 * attacker who can upload a backup can put `../../etc/cron.d/x` in it, and a restore
 * that joined it blindly would write outside the engine's directory — which turns
 * "restore this backup" into "run this code". Absolute paths and any `..` segment are
 * refused before a single byte is written.
 */
export function safeJoin(destination: string, path: string): string {
  const segments = path.split('/');
  if (path.startsWith('/') || segments.includes('..') || path === '') {
    throw new Error(`backup: ${path} is not a path inside the backup`);
  }
  return join(destination, ...segments);
}

/**
 * Refuse a file that changed between the pass that hashed it and the pass that copied it.
 *
 * A function rather than an inline `if` because the answer is the thing under test: a
 * runner cannot reliably change a file in the microseconds between two reads, and a
 * branch nobody can execute is a branch nobody has checked. A longer file, a shorter
 * one and a same-length edit are three different accidents, and the digest is what
 * catches the third.
 */
export function assertUnchanged(entry: ArtifactEntry, written: number, digest: string): void {
  if (written === entry.size && digest === entry.sha256) return;
  throw new Error(
    `backup: ${entry.path} changed while it was being captured ` +
      `(${entry.size} bytes hashed, ${written} copied) — quiesce the engine, or capture from its own snapshot`,
  );
}

/** Reading a file whole, hashing as it goes, in bounded chunks. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** A directory tree, split into the directories and the files, both sorted. */
async function walk(
  root: string,
  at = root,
  dirs: string[] = [],
  files: string[] = [],
): Promise<{ dirs: string[]; files: string[] }> {
  const names = await readdir(at, { withFileTypes: true });
  // Two entries in one directory cannot share a name, so the comparison needs no
  // equality arm — and an arm that can never be taken is an arm nobody has checked.
  names.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of names) {
    const full = join(at, entry.name);
    // A symlink is refused rather than followed. Following it either copies bytes
    // that do not belong to this directory (a backup that is bigger than it says)
    // or loops (a backup that never ends), and a silently skipped symlink is a
    // restore that is missing a file. Neither is a decision this format can make
    // on the caller's behalf.
    if (entry.isSymbolicLink()) {
      throw new Error(
        `backup: ${relative(root, full)} is a symbolic link — a backup cannot decide whether to follow it`,
      );
    }
    if (entry.isDirectory()) {
      dirs.push(relative(root, full).split('\\').join('/'));
      await walk(root, full, dirs, files);
      continue;
    }
    if (!entry.isFile()) {
      // Sockets, FIFOs, device nodes: a data directory that contains one is not a
      // data directory, and reading a FIFO would block the backup forever.
      throw new Error(`backup: ${relative(root, full)} is not a regular file`);
    }
    files.push(relative(root, full).split('\\').join('/'));
  }
  return { dirs, files };
}

/**
 * Capture `root` into `destination` as one artefact.
 *
 * The destination file is created empty first and written in one pass, so a
 * concurrent reader sees a partial artefact rather than no artefact — which is
 * what the manifest's `totalBytes` is for: the reader refuses it. An artefact that
 * is not complete never reaches a bucket, because the manager uploads only after
 * this resolves.
 */
export async function writeDirectoryArtifact(root: string, destination: string): Promise<CaptureOutcome> {
  const { dirs, files } = await walk(root);

  // Pass one: what the manifest will claim.
  const entries: ArtifactEntry[] = [];
  for (const path of files) {
    const { sha256, size } = await hashFile(join(root, path));
    entries.push({ path, size, sha256 });
  }
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const manifest: ArtifactManifest = { version: ARTIFACT_VERSION, dirs, files: entries, totalBytes };

  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, 'w');
  try {
    await handle.write(`${ARTIFACT_MAGIC}\n${JSON.stringify(manifest)}\n`);

    // Pass two: the bytes the manifest described, checked against pass one.
    for (const entry of entries) {
      const hash = createHash('sha256');
      let written = 0;
      for await (const chunk of createReadStream(join(root, entry.path))) {
        const bytes = chunk as Buffer;
        await handle.write(bytes);
        hash.update(bytes);
        written += bytes.length;
      }
      assertUnchanged(entry, written, hash.digest('hex'));
    }
  } finally {
    await handle.close();
  }

  const { size } = await stat(destination);
  return { bytes: size, files: entries.length, sourceBytes: totalBytes, manifest };
}

/** Read one `\n`-terminated line at `position`, growing the buffer as needed. */
async function readLine(
  handle: FileHandle,
  position: number,
  maxBytes: number,
): Promise<{ line: string; next: number }> {
  // The first attempt is the smaller of the usual read and the ceiling, so a budget
  // smaller than one read is enforced by the first attempt rather than ignored by it.
  let size = Math.min(4096, maxBytes);
  for (;;) {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    const slice = buffer.subarray(0, bytesRead);
    const newline = slice.indexOf(10);
    if (newline >= 0) {
      return { line: slice.subarray(0, newline).toString('utf8'), next: position + newline + 1 };
    }
    if (bytesRead < size) throw new Error('backup: the artefact ends before its manifest');
    if (size >= maxBytes) {
      throw new Error(`backup: the artefact manifest is larger than ${maxBytes} bytes`);
    }
    size *= 2;
  }
}

/**
 * Restore `source` into `destination`, replacing what is there.
 *
 * Replacing is the contract (`IBackupSource.restore`): merging leaves keys from the
 * present state that the snapshot never had, which is how a restored replica
 * diverges from the cluster it is about to rejoin.
 *
 * Every file is verified while it is written, and the destination is created only
 * after the manifest has been accepted, so a corrupt artefact fails before the
 * engine's state has been touched — except for the file being written when the
 * corruption is found, which is why the caller's engine must treat a rejected
 * restore as "my state is unknown, restore again".
 */
export async function readDirectoryArtifact(
  source: string,
  destination: string,
  options: { maxManifestBytes?: number } = {},
): Promise<RestoreOutcome> {
  const maxManifestBytes = options.maxManifestBytes ?? MAX_MANIFEST_BYTES;
  const handle = await open(source, 'r');
  try {
    const magic = await readLine(handle, 0, maxManifestBytes);
    if (magic.line !== ARTIFACT_MAGIC) {
      throw new Error(
        `backup: not a directory artefact (expected ${ARTIFACT_MAGIC}, found ${magic.line.slice(0, 16)})`,
      );
    }
    const header = await readLine(handle, magic.next, maxManifestBytes);
    const manifest = JSON.parse(header.line) as ArtifactManifest;
    if (manifest.version !== ARTIFACT_VERSION) {
      throw new Error(
        `backup: artefact version ${manifest.version} cannot be read by this build (${ARTIFACT_VERSION})`,
      );
    }

    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const dir of manifest.dirs) await mkdir(safeJoin(destination, dir), { recursive: true });

    let position = header.next;
    let restored = 0;
    for (const entry of manifest.files) {
      const target = safeJoin(destination, entry.path);
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, 'w');
      const hash = createHash('sha256');
      let remaining = entry.size;
      try {
        while (remaining > 0) {
          const length = Math.min(64 * 1024, remaining);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead === 0) {
            throw new Error(`backup: the artefact ends inside ${entry.path} (${remaining} bytes missing)`);
          }
          await out.write(buffer.subarray(0, bytesRead));
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await out.close();
      }
      if (hash.digest('hex') !== entry.sha256) {
        throw new Error(`backup: ${entry.path} does not match its digest — the artefact is corrupt`);
      }
      restored += entry.size;
    }

    if (restored !== manifest.totalBytes) {
      throw new Error(`backup: restored ${restored} bytes, the manifest promised ${manifest.totalBytes}`);
    }
    // Trailing bytes mean the artefact is not the one the manifest describes: a
    // second write appended something, or two artefacts were concatenated.
    const probe = Buffer.alloc(1);
    const { bytesRead } = await handle.read(probe, 0, 1, position);
    if (bytesRead > 0) throw new Error('backup: the artefact has bytes after the last file it describes');

    return { files: manifest.files.length, bytes: restored, dirs: manifest.dirs.length };
  } finally {
    await handle.close();
  }
}
