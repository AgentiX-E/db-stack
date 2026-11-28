/**
 * HealthProbe async contract — a registered readiness check may reach a peer.
 *
 * `HealthProbe` used to register only `() => ProbeResult`, so a readiness check
 * that had to ask the cluster about a peer had no way to say so. This case uses
 * a real file as the stand-in for that peer: the answer changes when the file
 * changes, which a promise read as a value could never report.
 *
 * @module db-cluster/observability
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HealthProbe } from './HealthProbe.js';

let directory: string;
let stateFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'db-cluster-async-probe-'));
  stateFile = join(directory, 'peer.txt');
  await writeFile(stateFile, 'connected', 'utf8');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('HealthProbe with an asynchronous readiness check', () => {
  it('awaits the registered probe and re-reads it on every verdict', async () => {
    const health = new HealthProbe();
    health.markStartupComplete();
    health.register('peer', async () => {
      const state = await readFile(stateFile, 'utf8');
      return { ok: state === 'connected', reason: `peer ${state}`, latencyMs: 0 };
    });

    expect((await health.readiness()).ok).toBe(true);
    await writeFile(stateFile, 'partitioned', 'utf8');
    const verdict = await health.readiness();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('unhealthy probes: peer (peer partitioned)');
    const status = await health.fullStatus();
    expect(status.probes.readiness?.ok).toBe(false);
  });
});
