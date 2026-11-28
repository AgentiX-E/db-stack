/**
 * AsyncProbes — the contract that a health probe may do real I/O.
 *
 * The old orchestrator refused a promise with an explanation, which was an
 * improvement over reading `undefined.ok` as "down" but still left the product
 * unable to answer the question a readiness probe exists to answer: can this
 * component reach the thing it depends on? Every case here drives a probe that
 * reads a real file from the filesystem, so a passing case is evidence that the
 * orchestrator awaited the answer rather than inspecting a promise's shape.
 *
 * @module @agentix-e/db-node/health/__tests__
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { componentProbe } from '../impl/ComponentProbe.js';
import { HealthOrchestrator } from '../impl/HealthOrchestrator.js';

let directory: string;
let stateFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'db-node-async-probe-'));
  stateFile = join(directory, 'state.txt');
  await writeFile(stateFile, 'ready', 'utf8');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A readiness answer that can only be known by reading the file. */
async function fileReadiness(): Promise<{ ok: boolean; message?: string }> {
  const state = await readFile(stateFile, 'utf8');
  return { ok: state === 'ready', message: `state is ${state}` };
}

describe('IHealthProbe with asynchronous answers', () => {
  it('AP.1 — awaits an async readiness probe and re-reads it on every call', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      componentProbe('storage', 'Storage', {
        liveness: () => ({ ok: true }),
        readiness: fileReadiness,
      }),
    );

    expect(await orchestrator.readiness()).toEqual({ ok: true, errors: [] });
    await writeFile(stateFile, 'draining', 'utf8');
    expect(await orchestrator.readiness()).toEqual({
      ok: false,
      errors: ['[storage] state is draining'],
    });
  });

  it('AP.2 — awaits async liveness, readiness and startup registered by function', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('io', 'I/O', {
      liveness: async () => ((await readFile(stateFile, 'utf8')) === 'ready' ? { ok: true } : { ok: false }),
      readiness: fileReadiness,
      startup: async () => ({ ok: (await readFile(stateFile, 'utf8')).length > 0 }),
    });

    expect(await orchestrator.liveness()).toEqual({ ok: true, errors: [] });
    expect(await orchestrator.readiness()).toEqual({ ok: true, errors: [] });
    expect(await orchestrator.startup()).toEqual({ ok: true, errors: [] });
  });

  it('AP.3 — awaits a hand-rolled thenable, not just a native Promise', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('deferred', 'Deferred', {
      liveness: () =>
        ({
          then(resolve: (value: { ok: boolean }) => void) {
            setTimeout(() => resolve({ ok: true }), 0);
          },
        }) as unknown as Promise<{ ok: boolean }>,
      readiness: fileReadiness,
    });

    expect(await orchestrator.liveness()).toEqual({ ok: true, errors: [] });
  });

  it('AP.4 — a rejected async probe is a named failure and does not hide later probes', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('broken', 'Broken', {
      liveness: async () => {
        throw new Error('socket closed');
      },
      readiness: async () => {
        throw new Error('socket closed');
      },
    });
    orchestrator.registerComponent(
      componentProbe('storage', 'Storage', {
        liveness: () => ({ ok: true }),
        readiness: fileReadiness,
      }),
    );

    expect(await orchestrator.liveness()).toEqual({
      ok: false,
      errors: ['[broken] liveness threw: socket closed'],
    });
    expect((await orchestrator.readiness()).errors).toEqual([
      '[broken] liveness threw: socket closed',
      '[broken] readiness threw: socket closed',
    ]);
  });

  it('AP.5 — structured views await the same answers the probes gave', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      componentProbe('storage', 'Storage', {
        liveness: () => ({ ok: true }),
        readiness: fileReadiness,
      }),
    );

    const components = await orchestrator.getComponentHealth();
    expect(components[0]?.readiness.ok).toBe(true);
    expect((await orchestrator.getAggregateStatus()).status).toBe('healthy');
    expect((await orchestrator.getHealthStatus()).components[0]?.readiness.ok).toBe(true);
    expect(await orchestrator.getSummary()).toContain('Components: 1/1 healthy');

    await writeFile(stateFile, 'draining', 'utf8');
    expect((await orchestrator.getAggregateStatus()).status).toBe('degraded');
    expect(await orchestrator.getSummary()).toContain('Failing: 1 component(s)');
  });
});
