/**
 * AC 81 — the durability claim, observed from outside the process that makes it.
 *
 * Everything in `AC80` asserts the recipe from inside one process: the order of
 * the calls, the identity of the file, the bytes that went to it. What none of it
 * can show is the property the recipe exists for, because the only observer of a
 * crash is another process. These cases are that observer.
 *
 *   OS.1  two processes appending to one trail lose nothing and duplicate nothing
 *   OS.2  a line acknowledged before `SIGKILL` is still readable after it
 *   OS.3  a trail left by a killed process is appendable again, without repair
 *
 * What `SIGKILL` proves and what it does not: the page cache outlives the process,
 * so a kill shows that acknowledged lines are *in the file*, and does not show
 * that they reached the medium — only a power cut does that, and no runner
 * provides one. The `fsync` half is argued in `AC80` (order, failure
 * propagation) and stated here as the limit of the evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FileAuditStore } from '../impl/FileAuditStore.js';

const CHILD = fileURLToPath(new URL('./fixtures/append-child.ts', import.meta.url));

interface Child {
  acked: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves once `count` acknowledgements have arrived. */
  waitForAcks(count: number): Promise<void>;
  /** Anything the child printed that was not an acknowledgement. */
  noise(): string[];
  kill(signal?: NodeJS.Signals): void;
  stderr(): string;
}

/** Start `append-child.ts`; `count === null` means "until killed". */
function startChild(dataDir: string, count: number | null): Child {
  const args = ['--import', 'tsx', CHILD, dataDir, String(count ?? 0)];
  if (count === null) args.push('--forever');

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const acked: string[] = [];
  let buffered = '';
  let stderr = '';
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  const noise: string[] = [];

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf-8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('ACK ')) acked.push(line.slice(4));
      else if (line.length > 0) noise.push(line);
    }
    for (const waiter of [...waiters]) {
      if (acked.length >= waiter.target) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });

  return {
    acked,
    exited: once(child, 'exit').then(([code, signal]) => ({
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
    })),
    /** Anything the child printed that was not an acknowledgement. */
    noise: () => noise,
    waitForAcks(target: number): Promise<void> {
      if (acked.length >= target) return Promise.resolve();
      return new Promise<void>((resolvePromise) => {
        waiters.push({ target, resolve: resolvePromise });
      });
    },
    kill(signal: NodeJS.Signals = 'SIGKILL'): void {
      child.kill(signal);
    },
    stderr: () => stderr,
  };
}

/** Every line in the trail that is not JSON, in file order, with its segment. */
function malformedLines(dataDir: string): Array<{ segment: string; line: string }> {
  const bad: Array<{ segment: string; line: string }> = [];
  for (const name of readdirSync(dataDir)
    .filter((n) => n.endsWith('.ndjson'))
    .sort()) {
    const text = readFileSync(join(dataDir, name), 'utf-8');
    const lines = text.split('\n');
    // The final element is whatever follows the last newline: empty after a clean
    // write, a fragment after a crash.
    lines.forEach((line, index) => {
      if (index === lines.length - 1) return;
      if (line.trim().length === 0) return;
      try {
        JSON.parse(line);
      } catch {
        bad.push({ segment: name, line });
      }
    });
  }
  return bad;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ac81-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AC 81 — writes from another process', () => {
  it('OS.1: two processes appending to one trail lose nothing and duplicate nothing', async () => {
    const [first, second] = [startChild(dataDir, 150), startChild(dataDir, 150)];

    const [a, b] = await Promise.all([first.exited, second.exited]);
    expect(a, first.stderr()).toMatchObject({ code: 0, signal: null });
    expect(b, second.stderr()).toMatchObject({ code: 0, signal: null });

    const store = new FileAuditStore({ dataDir });
    const acked = [...first.acked, ...second.acked];

    // The recipe this replaced read the whole segment, concatenated the new line
    // and renamed a replacement into place. Two processes doing that lose the
    // lines each read before the other wrote — silently, and in proportion to how
    // busy the trail is. An `O_APPEND` write is placed by the kernel, so there is
    // no window to lose.
    expect(acked).toHaveLength(300);
    expect(new Set(acked).size).toBe(300);
    expect(await store.count()).toBe(300);
    expect(malformedLines(dataDir)).toEqual([]);

    for (const id of acked) {
      expect(await store.get(id)).not.toBeNull();
    }
  }, 60_000);

  it('OS.2: a line acknowledged before SIGKILL is readable after it', async () => {
    const child = startChild(dataDir, null);
    await child.waitForAcks(120);
    const ackedBeforeKill = [...child.acked];

    child.kill('SIGKILL');
    const exit = await child.exited;
    expect(exit.signal).toBe('SIGKILL');
    // Nothing was acknowledged after the kill: the array is the pre-kill set.
    expect(ackedBeforeKill.length).toBeGreaterThanOrEqual(120);

    const store = new FileAuditStore({ dataDir });

    // Every acknowledged entry is there. This is the whole claim: `write()`
    // resolved before the process died, so the entry outlived the process.
    for (const id of ackedBeforeKill) {
      expect(await store.get(id), `acknowledged ${id} was lost`).not.toBeNull();
    }
    expect(await store.count()).toBeGreaterThanOrEqual(ackedBeforeKill.length);

    // The kill can land between the write and its newline. At most one line is
    // therefore unparsable, and it can only be the last one in the file.
    const bad = malformedLines(dataDir);
    expect(bad.length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('OS.3: a trail left by a killed process is appended to again, without repair', async () => {
    const doomed = startChild(dataDir, null);
    await doomed.waitForAcks(80);
    doomed.kill('SIGKILL');
    await doomed.exited;

    const store = new FileAuditStore({ dataDir });
    const survivors = await store.count();
    const id = await store.write({
      operation: 'AFTER_RECOVERY',
      actor: 'auditor',
      resource: '/trail',
      result: 'success',
    });

    // The next line does not join whatever fragment the crash left, which is what
    // a plain append would do: the entry would be glued to the fragment, both
    // unparsable, and the trail would lose an entry it acknowledged.
    expect(await store.get(id)).toMatchObject({ operation: 'AFTER_RECOVERY' });
    expect(await store.count()).toBe(survivors + 1);
    // The fragment the crash left is still unparsable, on its own line. What
    // matters is that it is no longer adjacent to a live entry.
    expect(malformedLines(dataDir).length).toBeLessThanOrEqual(1);
  }, 60_000);
});
