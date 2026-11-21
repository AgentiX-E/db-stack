/**
 * AC 97 — a backup is a thing that exists after the process that took it.
 *
 * `AC 94` proves the inventory survives a *new manager*, and that is not the same
 * claim: a second `BackupManager` in the same process shares the filesystem, the
 * clock, and the module instance. The property a backup is sold on is stronger — the
 * binary that has to restore it is started after the one that took it exited, on a
 * machine that may not be the same one — and it is a property of a *process*, so it is
 * measured in one.
 *
 * Three processes take part and each case is one of the ways a backup can die:
 *
 *   OP.1  a child takes a backup and exits; this process — which never saw the child's
 *         heap — lists it, and restores it into a directory that has never held a row
 *   OP.2  a child is killed after the artefact is in the bucket and before the record
 *         is written: the bytes are there, nothing lists them, and nothing claims them
 *   OP.3  two children take a full and an incremental in sequence; a third reads the
 *         chain and restores the incremental, so the parent link crossed two exits
 *
 * OP.2 is the one that would be hardest to see in-process, and it is the reason the
 * record is written last and confirmed: the window between "the artefact is uploaded"
 * and "a snapshot exists" is a real window, and what a crash leaves in it must be
 * invisible rather than half-announced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { FileSystemStorageBackend } from '../impl/FileSystemStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';

/** The backup module's root: what a child process imports by absolute path. */
const MODULE_DIR = resolve(import.meta.dirname, '..');

/** The public surface, as a child sees it. */
const IMPORTS = `import { BackupManager, DirectoryBackupSource, FileSystemStorageBackend, RetentionPolicyEvaluator } from ${JSON.stringify(
  join(MODULE_DIR, 'index.ts'),
)};`;

/** How a child builds a manager. Inlined into every script so the shape is the product's. */
const MAKE = `const make = (data, root, work) => new BackupManager(
  new DirectoryBackupSource(data),
  new FileSystemStorageBackend({ root }),
  new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
  { workDir: work },
);`;

let root: string;
let dataDir: string;
let bucketDir: string;
let restoreDir: string;

function bucket(): FileSystemStorageBackend {
  return new FileSystemStorageBackend({ root: bucketDir });
}

function manager(target: string, work: string): BackupManager {
  return new BackupManager(
    new DirectoryBackupSource(target),
    bucket(),
    new RetentionPolicyEvaluator({
      maxFullSnapshots: 100,
      maxTotalBytes: 0,
    }),
    { workDir: work },
  );
}

/** Run a snippet in a real process, from the module directory, and return its stdout. */
function inChild(script: string): string {
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return execFileSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
    cwd: MODULE_DIR,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac97-'));
  dataDir = join(root, 'data');
  bucketDir = join(root, 'bucket');
  restoreDir = join(root, 'restore');
  for (const dir of [dataDir, bucketDir, restoreDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha-rows');
  writeFileSync(join(dataDir, 'wal.log'), 'lsn 0/1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AC 97 — a backup outlives its process', () => {
  it('OP.1: a backup taken by one process is listed and restored by another', async () => {
    const work = join(root, 'work-child');
    const reported = inChild(`${IMPORTS}
      ${MAKE}
      const result = await make(${JSON.stringify(dataDir)}, ${JSON.stringify(bucketDir)}, ${JSON.stringify(work)})
        .createBackup({ type: 'full' });
      console.log(JSON.stringify(result));`);

    const created = JSON.parse(reported) as {
      success: boolean;
      snapshot: { snapshotId: string; sizeBytes: number; fileCount: number };
    };
    expect(created.success).toBe(true);
    // The child's staging directory is empty: it cleaned up after itself on the way out.
    expect(readdirSync(work)).toEqual([]);

    // This process has never seen the child's heap, its `Map`, or its clock.
    const here = manager(restoreDir, join(root, 'work-parent'));
    const listed = await here.listBackups();
    expect(listed.map((snapshot) => snapshot.snapshotId)).toEqual([created.snapshot.snapshotId]);
    expect(listed[0]!.sizeBytes).toBe(created.snapshot.sizeBytes);
    expect(listed[0]!.fileCount).toBe(created.snapshot.fileCount);

    const restored = await here.restoreFromSnapshot(created.snapshot.snapshotId);
    expect(restored.success).toBe(true);
    // The rows are in a directory that had nothing in it before this line, and they
    // are the rows the child captured — byte for byte, not a count of them.
    expect(readFileSync(join(restoreDir, 'table.bin'), 'utf8')).toBe('alpha-rows');
    expect(readFileSync(join(restoreDir, 'wal.log'), 'utf8')).toBe('lsn 0/1');
  });

  it('OP.2: a process killed between the artefact and its record leaves bytes nobody claims', async () => {
    const work = join(root, 'work-killed');
    // The child is killed inside the artefact's confirmation — after `upload` resolved,
    // before the record exists. That window is a few milliseconds wide in a healthy
    // run and it is the whole of what a crash can leave behind.
    const script = `${IMPORTS}
      import { writeFileSync } from 'node:fs';
      ${MAKE}
      const real = new FileSystemStorageBackend({ root: ${JSON.stringify(bucketDir)} });
      // Delegation spelled out rather than spread: a class instance's methods live on
      // its prototype, so a spread would produce an object with no upload method at all.
      const slow = {
        name: 'filesystem',
        upload: (source, key) => real.upload(source, key),
        download: (key, destination) => real.download(key, destination),
        async list(prefix) {
          if (prefix.endsWith('.artifact')) {
            console.log('confirmed-upload');
            await new Promise(() => {});
          }
          return real.list(prefix);
        },
        delete: (key) => real.delete(key),
        health: () => real.health(),
        getUsageBytes: () => real.getUsageBytes(),
      };
      const manager = new BackupManager(
        new DirectoryBackupSource(${JSON.stringify(dataDir)}),
        slow,
        new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
        { workDir: ${JSON.stringify(work)} },
      );
      // Without a live handle the loop would drain and the child would exit on its own,
      // which would be a different case: this one has to be killed.
      setInterval(() => {}, 1_000);
      await manager.createBackup({ type: 'full' });
      console.log('unreachable');`;

    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
      cwd: MODULE_DIR,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolveMarker, rejectMarker) => {
      let seen = '';
      const timer = setTimeout(() => rejectMarker(new Error('the child never reached the upload')), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes('confirmed-upload')) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolveMarker();
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        rejectMarker(new Error(`the child exited before the kill: ${seen}`));
      });
    });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((settled) => child.on('exit', settled));
    }
    // The kill left the staging file behind, which is the one thing a crash should
    // leave: a capture that has not been uploaded is garbage, not a snapshot.
    expect(readdirSync(work)).toHaveLength(1);

    // The artefact is in the bucket — the upload really did resolve — and nothing names
    // it: no record, so no listing, so no snapshot anywhere.
    const objects = await bucket().list('backups/');
    const artifacts = objects.filter((object) => object.key.endsWith('.artifact'));
    expect(artifacts).toHaveLength(1);
    expect(objects.filter((object) => object.key.endsWith('.json'))).toEqual([]);

    const here = manager(restoreDir, join(root, 'work-parent'));
    expect(await here.listBackups()).toEqual([]);
    expect(here.inventoryProblems()).toEqual([]);

    // Even handed the id the artefact's own key carries, the answer is that there is no
    // such snapshot: bytes are not a backup until something says they are.
    const id = artifacts[0]!.key.replace(/^backups\/full\//, '').replace(/\.artifact$/, '');
    expect(await here.getBackup(id)).toBeNull();
    expect(await here.restoreFromSnapshot(id)).toMatchObject({ success: false, error: 'not found' });
  });

  it('OP.3: the chain crosses two exits — a third process restores an incremental', async () => {
    const first = inChild(`${IMPORTS}
      ${MAKE}
      const result = await make(${JSON.stringify(dataDir)}, ${JSON.stringify(bucketDir)}, ${JSON.stringify(join(root, 'work-1'))})
        .createBackup({ type: 'full' });
      console.log(JSON.stringify(result.snapshot));`);

    const base = JSON.parse(first) as { snapshotId: string };

    const second = inChild(`${IMPORTS}
      ${MAKE}
      const result = await make(${JSON.stringify(dataDir)}, ${JSON.stringify(bucketDir)}, ${JSON.stringify(join(root, 'work-2'))})
        .createBackup({ type: 'incremental' });
      console.log(JSON.stringify(result.snapshot));`);

    const child = JSON.parse(second) as { snapshotId: string; parentSnapshotId?: string };
    // The second process named its base from the bucket, not from a heap it did not have.
    expect(child.parentSnapshotId).toBe(base.snapshotId);

    const here = manager(restoreDir, join(root, 'work-3'));
    expect(await here.listBackups()).toHaveLength(2);
    expect((await here.restoreFromSnapshot(child.snapshotId)).success).toBe(true);
    expect(readFileSync(join(restoreDir, 'table.bin'), 'utf8')).toBe('alpha-rows');

    // And the link is load-bearing: deleting the base takes the child with it, because
    // a delta whose base is gone is bytes nobody can replay.
    expect(await here.deleteBackup(base.snapshotId)).toBe(true);
    expect(await here.listBackups()).toEqual([]);
    expect(await bucket().list('backups/')).toEqual([]);
  });
});
