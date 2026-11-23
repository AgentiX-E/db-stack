/**
 * AC 103 — the field is an enumeration, so nothing in it can fail to terminate.
 *
 * The seven `Timeout` verdicts the mutation run recorded against `cron.ts` had
 * one cause: every field form was a counted loop (`for (let value = low; …; value
 * += step)`), and an edit to the update expression or to the guard turns that
 * loop into one that never ends. A synchronous loop cannot be interrupted, so
 * vitest never reports the case that is running it — the worker wedges, Stryker
 * abandons the mutant, and the score takes "the suite could not object" for "the
 * suite objected" (P3-18).
 *
 * Two answers, and this file is the second half of both:
 *
 *   - **the loops are gone.** `cron.ts` now derives its values from an array
 *     whose length is arithmetic. A mutated update expression has nothing to
 *     mutate, so the worst an edit can do is name the wrong minutes — a failing
 *     assertion with a name, which is what a mutation score is supposed to count;
 *   - **the entry point is observed from outside.** These cases run
 *     `parseCronField` in a child process with a deadline. The parent owns the
 *     process, so "it did not return" is a verdict the parent can reach and
 *     report, whatever the child is doing — the one thing a case that calls the
 *     function directly cannot do.
 *
 * The four fields below are the shapes the aborts named: a whole field, a typo
 * that names nothing, a range wider than the field, and a range backwards. The
 * first three run in a child; `EN.4` runs in this process as well, because an
 * empty enumeration is the one shape whose bound can be asserted from inside.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { parseCronField } from '../impl/cron.js';

const CHILD = fileURLToPath(new URL('./fixtures/cron-field-child.ts', import.meta.url));

/**
 * How long the child may take.
 *
 * `AC103`'s entry point costs microseconds and its process start about a tenth of
 * a second (measured 2026-11-23: 0.09–0.25 s over three runs), so five seconds is
 * fifty times the observed cost and a third of the mutation suite's own 15 s case
 * budget. A deadline that a loaded runner can cross is a flake; a deadline that is
 * the suite's own budget is not a deadline at all.
 */
const DEADLINE_MS = 5_000;

interface Probe {
  /** What the child printed, or an empty list when it printed nothing. */
  values: number[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Parse one field in a process the test owns, and report how that process ended. */
async function parseInChild(field: string, min: number, max: number): Promise<Probe> {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, field, String(min), String(max)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEADLINE_MS,
    killSignal: 'SIGKILL',
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return { values: stdout.length > 0 ? (JSON.parse(stdout) as number[]) : [], code, signal, stderr };
}

/** The process returned on its own, and said so. */
function expectReturned(probe: Probe, field: string): void {
  expect(
    probe.signal,
    `parseCronField(${JSON.stringify(field)}) did not return within ${DEADLINE_MS} ms — the ` +
      `process was killed, so a loop in it never ended. stderr: ${probe.stderr || '(empty)'}`,
  ).toBeNull();
  expect(probe.code, `parseCronField(${JSON.stringify(field)}) exited ${probe.code}`).toBe(0);
}

describe('AC 103 — a cron field is enumerated, not counted', () => {
  it('EN.1 — `*` names every value in the field, and the process returns', async () => {
    const probe = await parseInChild('*', 0, 59);

    expectReturned(probe, '*');
    expect(probe.values).toHaveLength(60);
    expect(probe.values[0]).toBe(0);
    expect(probe.values[59]).toBe(59);
  });

  it('EN.2 — a zero step names nothing, and the process returns', async () => {
    // The abort the report recorded as `Hit limit reached (290901/290900)` was
    // this field with the guard removed: `value += 0` a hundred thousand times.
    const probe = await parseInChild('*/0', 0, 59);

    expectReturned(probe, '*/0');
    expect(probe.values).toEqual([]);
  });

  it('EN.3 — a range wider than the field is clamped, and the step keeps its phase', async () => {
    const probe = await parseInChild('0-70/5', 0, 59);

    expectReturned(probe, '0-70/5');
    expect(probe.values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('EN.4 — a range that runs backwards names nothing, in this process', () => {
    // In-process on purpose: this is the shape whose bound is observable from
    // inside — the list is empty, so the enumeration it drives has nothing to
    // walk. It is also the case that covers the enumeration without iterating it,
    // which is what makes the mutation run attribute this file to those lines.
    expect([...parseCronField('*', 5, 4)]).toEqual([]);
    expect([...parseCronField('10-5', 0, 59)]).toEqual([]);
    expect([...parseCronField('10-5/2', 0, 59)]).toEqual([]);
  });

  it('EN.5 — a step that is not a number names nothing, and the process returns', async () => {
    const probe = await parseInChild('*/x', 0, 59);

    expectReturned(probe, '*/x');
    expect(probe.values).toEqual([]);
  });
});
