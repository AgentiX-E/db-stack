/**
 * The operations layer against processes that can die, not against itself.
 *
 * `cluster` and `federation` have had real-process acceptance suites for a while:
 * a node that is killed is really gone, and every byte between peers crosses a
 * mutual-TLS socket. The operations packages were exercised in-process only —
 * `FileAuditStore`'s `dataDir` pinning had one child-process case (`AC 92`), but
 * nothing wrote a trail in one process, died, and asked a *second* process what
 * it could still read.
 *
 * That is the only question a durability recipe answers, and it is the question
 * the in-process suite cannot ask: `close()` runs the same code a crash skips.
 *
 *   AC-O1  every acknowledged entry survives SIGKILL, exactly once, in order
 *   AC-O2  rotation and archival happen under load, and a killed writer leaves a
 *          trail whose archived segments are still readable
 *   AC-O3  a half-written archive left by a killed process is swept by the next
 *          process that opens the directory, without losing a segment
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTempDir,
  removeTempDir,
  spawnAuditReader,
  spawnAuditWriter,
  waitUntil,
  type ChildNode,
} from '../harness/support';

interface TrailReport {
  count: number;
  ids: string[];
  segments: string[];
  partials: string[];
}

const dirs: string[] = [];
const children: ChildNode[] = [];

function tempDir(label: string): string {
  const dir = makeTempDir(label);
  dirs.push(dir);
  return dir;
}

function track(child: ChildNode): ChildNode {
  children.push(child);
  return child;
}

/** Read a trail from a process that did not write it. */
async function readTrail(dataDir: string, limit = 100_000): Promise<TrailReport> {
  const reader = track(spawnAuditReader({ store: { dataDir }, limit }, `reader-${Date.now()}`));
  await reader.waitForType('ready', 20_000);
  return reader.request<TrailReport>('read', {}, 'read', 30_000);
}

async function stopAll(): Promise<void> {
  while (children.length > 0) await children.pop()!.terminate();
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
}

describe('operations — real processes, real files, real crashes', () => {
  it('AC-O1: every acknowledged entry survives a SIGKILL, exactly once and in order', async () => {
    const dataDir = tempDir('audit-sigkill-');
    const writer = track(spawnAuditWriter({ store: { dataDir }, padding: 0 }, 'audit-writer'));
    await writer.waitForType('ready', 20_000);

    // Twenty acknowledgements, each one a line the store synced before answering.
    const acked: string[] = [];
    for (let batch = 0; batch < 4; batch++) {
      writer.send({ cmd: 'write', entries: 5 });
      const wanted = acked.length + 5;
      await waitUntil(
        async () => writer.messages.filter((m) => m.type === 'written').length >= wanted,
        20_000,
        `${wanted} acknowledgements`,
      );
      for (const message of writer.messages.filter((m) => m.type === 'written')) {
        const { id } = message.data as { id: string };
        if (!acked.includes(id)) acked.push(id);
      }
    }
    expect(acked).toHaveLength(20);

    writer.kill('SIGKILL');
    await writer.waitForExit(20_000);

    const trail = await readTrail(dataDir);
    // The contract is "acknowledged means durable", so every acked id must be
    // there; a write that was in flight when the signal landed may have reached
    // the disk without reaching the caller, which is why this is a floor rather
    // than an equality.
    for (const id of acked) expect(trail.ids, `entry ${id} was acknowledged and is gone`).toContain(id);
    expect(new Set(trail.ids).size, 'the same entry was reported twice').toBe(trail.ids.length);
    expect(trail.ids.slice(0, acked.length)).toEqual(acked);
    expect(trail.count).toBeGreaterThanOrEqual(acked.length);
    expect(trail.count, 'more entries survived than were ever written').toBeLessThanOrEqual(20);
    await stopAll();
  }, 90_000);

  it('AC-O2: rotation and archival run while the writer is alive, and the archive survives it', async () => {
    const dataDir = tempDir('audit-rotate-');
    // 4 KiB segments and 1 KiB entries: the second batch rotates, and the first
    // segment is compressed by the store's own background pass.
    const writer = track(spawnAuditWriter({ store: { dataDir, maxFileSize: 4096 }, padding: 1024 }, 'audit-rotating'));
    await writer.waitForType('ready', 20_000);

    for (let batch = 0; batch < 6; batch++) {
      writer.send({ cmd: 'write', entries: 2 });
      const wanted = (batch + 1) * 2;
      await waitUntil(
        async () => writer.messages.filter((m) => m.type === 'written').length >= wanted,
        20_000,
        `${wanted} acknowledgements`,
      );
    }
    const acked = writer.messages.filter((m) => m.type === 'written').map((m) => (m.data as { id: string }).id);
    expect(acked).toHaveLength(12);

    // Rotation is the writer's own work; the archive is a background pass. Wait for
    // the archive to exist before killing, so the case is about reading a *closed*
    // segment from another process rather than about how fast a gzip runs.
    await waitUntil(
      async () => readdirSync(dataDir).some((name) => name.endsWith('.ndjson.gz')),
      20_000,
      'the store to archive a rotated segment',
    );

    writer.kill('SIGKILL');
    await writer.waitForExit(20_000);

    const trail = await readTrail(dataDir);
    expect(trail.segments.length, 'the trail never rotated').toBeGreaterThan(1);
    expect(trail.segments.some((name) => name.endsWith('.ndjson.gz'))).toBe(true);
    for (const id of acked) expect(trail.ids, `entry ${id} is behind an archive the reader cannot open`).toContain(id);
    expect(trail.count).toBeGreaterThanOrEqual(acked.length);
    await stopAll();
  }, 90_000);

  it('AC-O3: a half-written archive left by a killed process is swept, and no segment is lost', async () => {
    const dataDir = tempDir('audit-partial-');
    mkdirSync(dataDir, { recursive: true });

    // The shape a SIGKILL during compression leaves: a `.part` whose bytes are a
    // truncated gzip. Nothing may read it, and nothing may keep it.
    writeFileSync(join(dataDir, 'audit-20200101-0001.ndjson.gz.part'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));

    const writer = track(spawnAuditWriter({ store: { dataDir }, padding: 0 }, 'audit-after-partial'));
    await writer.waitForType('ready', 20_000);
    writer.send({ cmd: 'write', entries: 3 });
    await waitUntil(
      async () => writer.messages.filter((m) => m.type === 'written').length >= 3,
      20_000,
      '3 acknowledgements',
    );
    await writer.terminate();

    const trail = await readTrail(dataDir);
    expect(trail.partials, 'the sweep left a half-written archive behind').toEqual([]);
    expect(trail.count).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(dataDir, 'audit-20200101-0001.ndjson.gz.part'))).toBe(false);
    await stopAll();
  }, 90_000);
});
