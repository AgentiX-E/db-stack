/**
 * AC 86 — two processes creating segments at the same instant.
 *
 * `AC85` shows the claim in one process: two stores, one directory, different names.
 * That is the decision, but not the mechanism — `O_CREAT | O_EXCL` is a promise the
 * kernel makes, and a test that only ever runs in one process is testing a JavaScript
 * variable. These cases put real processes behind it, released at the same moment,
 * rotating on every line so that each write re-runs the name choice.
 *
 *   TW.1  two processes released together, rotating on every line, lose nothing and
 *         leave no entry unreadable
 *   TW.2  every segment in the directory belongs to one writer — no name holds lines
 *         from both processes
 *
 * What this cannot show: that the claim is what prevented a collision. A run with the
 * claim removed *usually* collides, which is not the same as always — the
 * deterministic record of the defect is `AC85 SC.5`, and this is the confirmation that
 * the same guarantee holds across a process boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FileAuditStore, readSegmentFromDisk } from '../impl/FileAuditStore.js';

const CHILD = fileURLToPath(new URL('./fixtures/append-child.ts', import.meta.url));

interface Child {
  acked: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

/** Start a rotating child that waits for `release` before its first write. */
function startReleasedChild(dataDir: string, count: number, release: string): Child {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, dataDir, String(count), '--rotate', '--await', release],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const acked: string[] = [];
  let buffered = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf-8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line.startsWith('ACK ')) acked.push(line.slice(4));
  });

  return {
    acked,
    exited: once(child, 'exit').then(([code, signal]) => ({
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
    })),
    stderr: () => stderr,
  };
}

/**
 * Every entry in the directory, by segment, decoded — plain segments and archives
 * alike, because a rotated segment only exists as an archive.
 */
function entriesBySegment(dataDir: string): Map<string, Array<{ id: string; actor: string }>> {
  const bySegment = new Map<string, Array<{ id: string; actor: string }>>();
  for (const name of readdirSync(dataDir)) {
    const archived = name.endsWith('.ndjson.gz');
    if (!archived && !name.endsWith('.ndjson')) continue;
    const text = readSegmentFromDisk(join(dataDir, name), archived);
    if (text === null) continue;
    const entries: Array<{ id: string; actor: string }> = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as { id: string; actor: string });
      } catch {
        // A parse failure here is a different case's subject (AC81); this one is
        // about which process owns a name.
      }
    }
    bySegment.set(name.replace(/\.gz$/, ''), entries);
  }
  return bySegment;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ac86-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AC 86 — two writers, one directory', () => {
  it('TW.1: released together and rotating on every line, nothing is lost or unreadable', async () => {
    const release = join(dataDir, '..', `ac86-release-${process.pid}`);
    const [first, second] = [startReleasedChild(dataDir, 30, release), startReleasedChild(dataDir, 30, release)];

    writeFileSync(release, '');

    const [a, b] = await Promise.all([first.exited, second.exited]);
    rmSync(release, { force: true });
    expect(a, first.stderr()).toMatchObject({ code: 0, signal: null });
    expect(b, second.stderr()).toMatchObject({ code: 0, signal: null });

    const acked = [...first.acked, ...second.acked];
    expect(acked).toHaveLength(60);
    expect(new Set(acked).size).toBe(60);

    // The property the claim exists for: sixty entries written by two processes that
    // were competing for a name on every single line, and a third store reads all
    // sixty. Before the claim this is where the loss appeared — not in the file, which
    // kept every byte, but in what a reader could reach: a segment archived while the
    // other process was still writing it, recreated under the same name, and then
    // hidden behind its own archive.
    const store = new FileAuditStore({ dataDir });
    expect(await store.count()).toBe(60);
    for (const id of acked) {
      expect(await store.get(id), `acknowledged ${id} was lost`).not.toBeNull();
    }
  }, 90_000);

  it('TW.2: no segment holds lines from both processes', async () => {
    const release = join(dataDir, '..', `ac86-release-owner-${process.pid}`);
    const [first, second] = [startReleasedChild(dataDir, 12, release), startReleasedChild(dataDir, 12, release)];

    writeFileSync(release, '');
    await Promise.all([first.exited, second.exited]);
    rmSync(release, { force: true });

    // A segment with two authors is the state the claim rules out: while it lasts,
    // either process can rotate it and archive the other's lines, and the reader
    // prefers the archive. Every segment is inspected, archives included, because a
    // rotated segment exists only under its `.gz` name.
    const bySegment = entriesBySegment(dataDir);
    const authors = new Set<string>();
    let total = 0;
    for (const [segment, entries] of bySegment) {
      const owners = new Set(entries.map((e) => e.actor));
      expect(owners.size, `${segment} holds lines from ${[...owners].join(', ')}`).toBeLessThanOrEqual(1);
      for (const owner of owners) authors.add(owner);
      total += entries.length;
    }

    expect(total).toBe(24);
    // And there were two writers: without this the loop above would pass in a run
    // where one child never started.
    expect(authors.size).toBe(2);
  }, 90_000);
});
