/**
 * The runner for the three published-behaviour probes, and the reason they are here.
 *
 * Where they came from
 * --------------------
 * `check-package` used to carry these three closures in its data table, and the
 * Quality job — where that gate's own tests run — has no `dist/`, so they were the
 * one part of a gate no test could reach. Recorded as `functions 0 %` with a
 * roadmap id, which is a debt that names itself but does not stop being a debt.
 *
 * They run here because this job builds, and they run in a *child* process because
 * that is the whole claim: a `require` inside an ESM artefact, a trace id lost
 * across an async boundary, and a subscription pump that delivered to no sink all
 * passed the compiler and the whole test suite, since the test transform supplies a
 * `require` a consumer does not have. The probes themselves live in
 * `published-probes.mjs` — a child programme, like `raft-node.mjs`, verified by what
 * the process reports rather than by the runner's V8 counters.
 *
 * The import is by *package name*, not by a path into `dist/`. That is one step
 * further than the packaging gate goes, and it is the step that catches an exports
 * map which resolves in the workspace and nowhere else.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublishedProbe } from './published-probes.mjs';
import { PROBES, CONTROLS } from './published-probes.mjs';

export type { PublishedProbe, ProbeContext } from './published-probes.mjs';
export { PROBES, CONTROLS };

/** Every programme the child can be asked to run: the claims, then the controls. */
const RUNNABLE: PublishedProbe[] = [...PROBES, ...CONTROLS];

/** The probe programme, by absolute URL: the child is started in a directory of its own. */
const PROBES_URL = pathToFileURL(resolve(import.meta.dirname, 'published-probes.mjs')).href;

/**
 * The program the child runs: import by name, list what is missing, then behave.
 *
 * The probe is chosen by index rather than by name so that the child imports the
 * module it is told to and no message parsing sits between the two processes.
 */
export function probeProgram(probe: PublishedProbe): string {
  const index = RUNNABLE.indexOf(probe);
  if (index < 0) throw new Error(`unknown probe: ${probe.name}`);
  return `
    const { PROBES, CONTROLS } = await import(${JSON.stringify(PROBES_URL)});
    const probe = [...PROBES, ...CONTROLS][${index}];
    const loaded = await import(probe.specifier);
    const missing = probe.expect.filter((name) => !(name in loaded));
    if (missing.length > 0) {
      console.error('missing exports: ' + missing.join(', '));
      process.exit(1);
    }
    const assert = (await import('node:assert/strict')).default;
    await probe.behaviour({ loaded, assert });
    console.log('ok (' + Object.keys(loaded).length + ' exports, behaviour verified)');
  `;
}

/**
 * The part of `spawnSync` this runner uses.
 *
 * Spelled out so a caller can hand in a fake child — a killed process is the case
 * that matters (no `status`, no output) and it is the one a real child produces only
 * after a sixty-second wait.
 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: 'utf8'; timeout?: number },
) => { status: number | null; stdout?: string | null; stderr?: string | null };

export interface ProbeResult {
  probe: PublishedProbe;
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one probe in a child process the test runner has not touched.
 *
 * `spawn` and `cwd` are parameters so a test can run the runner against a probe
 * that throws without shelling out to a different programme: a runner that cannot
 * report a failure is a runner whose green means nothing. A probe that is not in
 * `PROBES` has no index to run, so the composition is rejected up front rather than
 * producing a child that fails for an unrelated reason.
 */
export function runProbe(
  probe: PublishedProbe,
  options: { cwd?: string; spawn?: SpawnLike; timeoutMs?: number } = {},
): ProbeResult {
  const spawn: SpawnLike = options.spawn ?? spawnSync;
  const result = spawn(process.execPath, ['--input-type=module', '-e', probeProgram(probe)], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
  });
  return {
    probe,
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/** The four lines a reader needs when a probe fails: what ran, and what it said. */
export function describeFailure(result: ProbeResult): string {
  const lines = (result.stderr || result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // A crashed Node process opens with frames of `node:internal/…`; the line that
  // names the failure is the one worth printing first.
  const diagnosis = lines.findIndex((line) => /\b\w*Error\b|missing exports:/.test(line));
  if (diagnosis > 0) lines.unshift(...lines.splice(diagnosis, 1));
  return `${result.probe.name}: ${lines.slice(0, 4).join(' | ') || '<no output>'}`;
}
