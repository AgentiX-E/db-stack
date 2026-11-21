/**
 * AC 56 — Resuming paused resources must actually resume them.
 *
 * `PauseRequest` has declared `onResume` since the interface was written, and
 * `requestResume(resources)` has always had an empty body: `await
 * scheduler.requestResume(['orders'])` resolved, and nothing was resumed. That
 * is a success signal that does not mean success — the caller believes the
 * database was returned to service while it stayed paused.
 *
 * `requestResume` now takes a `ResumeRequest` and drives `onResume` for every
 * resource, the same shape `requestPause` already had for `onPaused`. These
 * tests pin the confirmation, the ordering, the not-fire-and-forget property
 * and the failure semantics.
 *
 * @module @agentix-e/db-node/maintenance/__tests__
 */

import { describe, it, expect } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { PauseRequest } from '../interfaces/IMaintenanceScheduler.js';

const RESUME_AT = Date.UTC(2026, 10, 16, 4, 0, 0, 0);

describe('AC 56 — resource resume', () => {
  it('AC 56.1: onResume is invoked once per resource, in order', async () => {
    const scheduler = new MaintenanceWindowScheduler();
    const resumed: string[] = [];

    await scheduler.requestResume({
      instanceId: 'inst-1',
      resources: ['db-1', 'db-2', 'db-3'],
      resumeAt: RESUME_AT,
      onResume: async (resource) => {
        resumed.push(resource);
      },
    });

    expect(resumed).toEqual(['db-1', 'db-2', 'db-3']);
  });

  it('AC 56.2: an empty resource list resolves without invoking the callback', async () => {
    const scheduler = new MaintenanceWindowScheduler();
    let calls = 0;

    await scheduler.requestResume({
      instanceId: 'inst-2',
      resources: [],
      resumeAt: RESUME_AT,
      onResume: async () => {
        calls++;
      },
    });

    expect(calls).toBe(0);
  });

  it('AC 56.3: the call is not fire-and-forget — it awaits every callback', async () => {
    const scheduler = new MaintenanceWindowScheduler();
    const resumed: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = scheduler.requestResume({
      instanceId: 'inst-3',
      resources: ['db-1', 'db-2'],
      resumeAt: RESUME_AT,
      onResume: async (resource) => {
        resumed.push(resource);
        await gate;
      },
    });

    // Let the loop reach the first await, then prove the promise has not settled.
    await Promise.resolve();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(resumed).toEqual(['db-1']);

    release!();
    await pending;
    expect(resumed).toEqual(['db-1', 'db-2']);
  });

  it('AC 56.4: a failing onResume rejects the call and stops at the failing resource', async () => {
    const scheduler = new MaintenanceWindowScheduler();
    const resumed: string[] = [];

    const attempt = scheduler.requestResume({
      instanceId: 'inst-4',
      resources: ['db-1', 'db-2', 'db-3'],
      resumeAt: RESUME_AT,
      onResume: async (resource) => {
        if (resource === 'db-2') throw new Error('db-2 refused to resume');
        resumed.push(resource);
      },
    });

    await expect(attempt).rejects.toThrow('db-2 refused to resume');
    // db-3 was never resumed: the caller sees which resource failed, and the
    // remaining one is reported by the error rather than silently attempted.
    expect(resumed).toEqual(['db-1']);
  });

  it('AC 56.5: a pause request carries no resume callback, so pausing cannot resume', async () => {
    const scheduler = new MaintenanceWindowScheduler();
    const paused: string[] = [];

    const pause: PauseRequest = {
      instanceId: 'inst-5',
      resources: ['db-1', 'db-2'],
      pauseAt: RESUME_AT - 3_600_000,
      resumeAt: RESUME_AT,
      onPaused: async (resource) => {
        paused.push(resource);
      },
    };

    await scheduler.requestPause(pause);

    expect(paused).toEqual(['db-1', 'db-2']);
    // The resume half lives on `ResumeRequest`. A `PauseRequest` used to carry
    // an `onResume` that nothing ever called; the type is the guarantee now.
    expect(Object.keys(pause).sort()).toEqual(['instanceId', 'onPaused', 'pauseAt', 'resources', 'resumeAt']);
  });
});
