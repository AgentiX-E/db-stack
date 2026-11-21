/**
 * DirectoryBackupSource — the reference engine for a backup, over a directory.
 *
 * Every database that keeps its state on a local filesystem — SQLite, an embedded
 * KV store, a Postgres data directory after `pg_start_backup` — can be backed up by
 * capturing that directory. This class is that capture, in the one format the
 * package can verify (`backupArtifact.ts`), so the middleware ships something that
 * actually moves bytes instead of an interface with no implementation behind it.
 *
 * It is deliberately not clever: no incremental capture, no hard links, no
 * compression. Each of those is a decision that belongs to the engine (which pages
 * changed, which files are derivable), and an engine that needs them implements
 * `IBackupSource` against its own format. What this class must be is *correct*: a
 * capture that refuses a moving target, a restore that replaces, and a digest for
 * every file so that neither has to be taken on trust.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import type { IBackupSource, SnapshotCapture } from '../interfaces/index.js';
import { readDirectoryArtifact, writeDirectoryArtifact } from './backupArtifact.js';

/** How this source appears in logs and backup listings. */
export const DIRECTORY_SOURCE_NAME = 'directory';

/**
 * Backs up one directory tree.
 *
 * The directory is captured, not watched: a caller that mutates it while a capture
 * is in flight gets an error (see `backupArtifact.ts`), because the alternative is
 * an artefact that restores a state that never existed.
 */
export class DirectoryBackupSource implements IBackupSource {
  readonly name = DIRECTORY_SOURCE_NAME;

  constructor(private readonly directory: string) {}

  /** @inheritdoc */
  async capture(destination: string): Promise<SnapshotCapture> {
    const outcome = await writeDirectoryArtifact(this.directory, destination);
    return {
      bytes: outcome.bytes,
      files: outcome.files,
      // Recorded with the snapshot because they are the two numbers an operator
      // compares between backups: a file count that fell is a table that stopped
      // being included, and it is invisible in any other field.
      facts: { 'dir.files': String(outcome.files), 'dir.bytes': String(outcome.sourceBytes) },
    };
  }

  /** @inheritdoc */
  async restore(source: string): Promise<void> {
    await readDirectoryArtifact(source, this.directory);
  }
}
