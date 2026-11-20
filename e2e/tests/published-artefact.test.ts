/**
 * E2E — the published artefacts behave, in a process the test runner has not touched.
 *
 * Acceptance criteria covered:
 *   AC-P1  every published-claim probe passes against the built package, resolved by
 *          name through its exports map
 *   AC-P2  every control probe fails, and fails with its own diagnosis
 *
 * These are the three features that once shipped green while broken: a `require`
 * inside an ESM artefact, a trace id lost across an async boundary, and a
 * subscription pump that delivered nothing. The gate that was supposed to catch them
 * could not be measured by any test — it lived in a job without `dist/` — so it is
 * measured here instead, in the job that builds, and the debt entry it carried is
 * gone.
 *
 * `AC-P2` is not decoration. A runner that has never reported a failure is a runner
 * whose green is indistinguishable from a runner that did not run: the three
 * controls are the three ways a probe breaks, and each is run through the same child
 * process as the real ones.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  CONTROLS,
  PROBES,
  type PublishedProbe,
  describeFailure,
  probeProgram,
  runProbe,
} from '../harness/published-artefact';

/** The e2e package directory: `@agentix-e/*` resolves here through node_modules. */
const CWD = resolve(import.meta.dirname, '..');

describe('published artefacts (real consumer process)', () => {
  for (const probe of PROBES) {
    it(`AC-P1: ${probe.name}`, () => {
      const result = runProbe(probe, { cwd: CWD });

      // The message carries the child's own diagnosis, not the exit code: "missing
      // exports: SqliteStorage" and "AssertionError: …" are two different defects.
      expect(result.status, describeFailure(result)).toBe(0);
      expect(result.stdout).toMatch(/^ok \(\d+ exports, behaviour verified\)$/);
    }, 120_000);
  }

  it('AC-P2: an assertion that does not hold is a failure, and the message survives', () => {
    const result = runProbe(CONTROLS[0]!, { cwd: CWD });

    expect(result.status).not.toBe(0);
    const report = describeFailure(result);
    expect(report).toContain('the artefact must export one');
    // The diagnosis is first: the head of a crashed Node process is four frames of
    // `node:internal/…`, and printing those instead of the assertion is how a
    // failure becomes a mystery.
    expect(report.split(' | ')[0]).toMatch(/AssertionError/);
  }, 120_000);

  it('AC-P2: a probe that dies without a word is still a failure', () => {
    const result = runProbe(CONTROLS[1]!, { cwd: CWD });

    expect(result.status).toBe(1);
    expect(describeFailure(result)).toContain('<no output>');
  }, 120_000);

  it('AC-P2: a symbol the artefact does not publish is named', () => {
    const result = runProbe(CONTROLS[2]!, { cwd: CWD });

    expect(result.status).not.toBe(0);
    expect(describeFailure(result)).toContain('missing exports: NotARealExport');
  }, 120_000);

  it('runs a probe with no options at all: this directory, a real child, the default budget', () => {
    // The defaults are what every caller above relies on, and a default no case
    // exercises is a branch nobody has run.
    const result = runProbe(PROBES[2]!);

    expect(result.status, describeFailure(result)).toBe(0);
  }, 120_000);

  it('a programme that is neither a claim nor a control is refused before spawning', () => {
    const stranger: PublishedProbe = {
      name: 'a probe from nowhere',
      specifier: '@agentix-e/db-cluster',
      expect: ['RaftAdapter'],
      behaviour: () => undefined,
    };

    // The alternative is a child that fails for an unrelated reason — it would be
    // asked to run `RUNNABLE[-1]` — and a test that reads as a passing failure.
    expect(() => probeProgram(stranger)).toThrow(/unknown probe: a probe from nowhere/);
  });

  it('a child the timeout killed is a failure, not a pass with no output', () => {
    // `spawnSync` reports a process killed by its timeout as `status: null`, with no
    // streams. That is the shape a hung probe has, and the one a runner is most
    // tempted to read as "nothing went wrong" — `status ?? 1` is the difference
    // between a red suite and a green one built on a process that never finished.
    const result = runProbe(PROBES[0]!, {
      cwd: CWD,
      spawn: () => ({ status: null }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(describeFailure(result)).toContain('<no output>');
  });

  it('the program it runs imports the package by name, not by a path into dist', () => {
    // The distinction is the whole point of running this here: a path into `dist/`
    // resolves whether or not the exports map is correct.
    const program = probeProgram(PROBES[0]!);
    expect(program).toContain('await import(probe.specifier)');
    expect(program).not.toContain('dist/');
    expect(PROBES[0]!.specifier).toBe('@agentix-e/db-cluster');
  });
});
