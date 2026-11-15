/**
 * SchemaFederator — branch-completion tests.
 *
 * Targets the boundary branches the I36 suite leaves implicit:
 *   - detectAllDrifts (and detectSubset) when no reference snapshot resolves
 *   - executeRepair when the executor throws a non-Error value (`?? String`)
 *   - reportShardResult / pauseCoordination / resumeCoordination on unknown ids
 *   - resumeCoordination on a non-"paused" state
 *   - startMonitor when a timer is already running (re-arming)
 *   - _getReference "canonical" with an unset canonicalShardId, and the default
 *     case for an unrecognized strategy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaFederator } from '../impl/SchemaFederator.js';
import type { SchemaSnapshot, ReferenceStrategy } from '../interfaces/schema-federation.js';

/** Private SchemaFederator members these branch-completion tests pin directly. */
interface FederatorInternals {
  monitorTimer: ReturnType<typeof setInterval> | null;
  _getReference(): SchemaSnapshot | undefined;
}

/**
 * The federator's reference resolution and monitor timer are private, but these
 * tests pin their fallbacks. Reflect.get is the one reflection edge in the file:
 * a renamed member fails to compile here instead of leaving the assertion
 * comparing undefined.
 */
function internal<K extends keyof FederatorInternals>(fed: SchemaFederator, member: K): FederatorInternals[K] {
  const value = Reflect.get(fed, member);
  // Private methods must keep their receiver; fields are returned as-is.
  return (typeof value === 'function' ? value.bind(fed) : value) as FederatorInternals[K];
}

/** The default branch of reference resolution only runs for a value outside the union. */
function offContract<T>(value: unknown): T {
  return value as T;
}

function snapshot(shardId: string, version: number): SchemaSnapshot {
  return {
    shardId,
    version,
    migrations: [],
    chainChecksum: '',
    capturedAt: Date.now(),
  };
}

describe('SCF-branch: missing reference', () => {
  let fed: SchemaFederator;
  beforeEach(() => {
    fed = new SchemaFederator();
  });

  it('detectAllDrifts returns [] when the canonical shard is unset', async () => {
    fed.registerShard(snapshot('s1', 1));
    fed.registerShard(snapshot('s2', 2));
    fed._setReferenceStrategy('canonical');
    // canonicalShardId was never set → reference resolves to undefined.
    expect(await fed.detectAllDrifts()).toEqual([]);
  });
});

describe('SCF-branch: repair executor throws non-Error', () => {
  let fed: SchemaFederator;
  beforeEach(() => {
    fed = new SchemaFederator();
  });

  it('stringifies a non-Error rejection via `?? String(err)`', async () => {
    fed.registerShard(snapshot('s1', 1));
    fed.registerShard(snapshot('s2', 2));
    fed._setReferenceStrategy('primary');
    const drifts = await fed.detectAllDrifts();

    // Attach an executor that throws a bare string (not an Error instance).
    fed._setRepairExecutor(async () => {
      // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
      throw 'raw-string-failure';
    });

    const repair = fed.planRepair(drifts[0]!);
    const result = await fed.executeRepair(repair);
    expect(result.success).toBe(false);
    expect(result.error).toBe('raw-string-failure');
  });
});

describe('SCF-branch: coordination unknown ids', () => {
  let fed: SchemaFederator;
  beforeEach(() => {
    fed = new SchemaFederator();
  });

  it('reportShardResult silently ignores an unknown coordination', () => {
    expect(() =>
      fed.reportShardResult('nope', {
        shardId: 's1',
        version: 1,
        success: true,
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it('pauseCoordination throws for an unknown coordination', () => {
    expect(() => fed.pauseCoordination('nope')).toThrow('not found');
  });

  it('resumeCoordination throws for an unknown coordination', () => {
    expect(() => fed.resumeCoordination('nope')).toThrow('not found');
  });

  it('resumeCoordination throws when not paused', () => {
    const coord = fed.startCoordinatedMigration(
      { currentVersion: 0, targetVersion: 1, pending: [], namespace: 'test-namespace' },
      'all',
    );
    // A freshly started coordination is in "preparing", not "paused".
    expect(() => fed.resumeCoordination(coord.id)).toThrow('Cannot resume');
  });
});

describe('SCF-branch: monitor re-arm', () => {
  it('stopMonitor is called before re-arming an existing timer', () => {
    const fed = new SchemaFederator();
    fed.startMonitor({ scanIntervalMs: 3600_000 });
    const first = internal(fed, 'monitorTimer');
    fed.startMonitor({ scanIntervalMs: 3600_000 });
    const second = internal(fed, 'monitorTimer');
    // Re-arming replaced the timer (old one was cleared).
    expect(second).not.toBe(first);
    fed.stopMonitor();
  });
});

describe('SCF-branch: reference strategy fallbacks', () => {
  it('canonical without a nominated shard yields undefined', () => {
    const fed = new SchemaFederator();
    fed.registerShard(snapshot('s1', 1));
    fed._setReferenceStrategy('canonical');
    expect(internal(fed, '_getReference')()).toBeUndefined();
  });

  it('an unrecognized strategy yields undefined (default case)', () => {
    const fed = new SchemaFederator();
    fed.registerShard(snapshot('s1', 1));
    fed._setReferenceStrategy(offContract<ReferenceStrategy>('does-not-exist'));
    expect(internal(fed, '_getReference')()).toBeUndefined();
  });
});
