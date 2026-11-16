/**
 * AC 65 — the answer does not depend on the order of the question.
 *
 * `buildBackupSets` groups the inventory into restorable sets, and every rule
 * afterwards decides per set. The set a snapshot belongs to is a property of the
 * metadata — who names whom as parent — so it must not depend on the order the
 * caller's listing happens to arrive in. `listBackups` sorts newest first, so the
 * *deepest incremental comes first* and its base comes last, which is exactly the
 * order a grouping written as "the first snapshot of a chain becomes the base"
 * gets wrong.
 *
 * Six mutants survived in that function because every existing case fed it a
 * chain in oldest-first order, where the mistake is invisible. Feeding it the
 * order a real listing produces is the test; a chain split into two sets shows up
 * as a base being deleted while the incremental that needs it survives, which is
 * the defect iteration 27 removed.
 *
 * The floors get one case here too. `keepRecent` and `minAge` compare an age
 * against a duration, and when neither floor is set there is no comparison to
 * make — a snapshot dated in the future has a negative age, and a comparison
 * against "no floor" that silently becomes `age < 0` protects it forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import type { BackupMetadata, RetentionPolicy } from '@agentix-e/db-operations-core/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0, 0);

interface Draft {
  id: string;
  /** Milliseconds before `NOW`; negative values are in the future. */
  ageMs?: number;
  sizeBytes?: number;
  parent?: string;
}

function snapshot(draft: Draft): BackupMetadata {
  return {
    snapshotId: draft.id,
    type: draft.parent === undefined ? 'full' : 'incremental',
    state: 'completed',
    sizeBytes: draft.sizeBytes ?? 100,
    createdAt: new Date(NOW - (draft.ageMs ?? 0)).toISOString(),
    fileCount: 1,
    location: `file:///backups/${draft.id}`,
    ...(draft.parent === undefined ? {} : { parentSnapshotId: draft.parent }),
  };
}

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { maxFullSnapshots: 0, maxTotalBytes: 0, ...overrides };
}

const ids = (snapshots: readonly BackupMetadata[]): string[] => snapshots.map((s) => s.snapshotId);

/** A base and two incrementals on top of it, one hour apart. */
function chain(): BackupMetadata[] {
  return [
    snapshot({ id: 'base', ageMs: 3 * HOUR_MS, sizeBytes: 1_000 }),
    snapshot({ id: 'delta-1', ageMs: 2 * HOUR_MS, parent: 'base', sizeBytes: 200 }),
    snapshot({ id: 'delta-2', ageMs: HOUR_MS, parent: 'delta-1', sizeBytes: 200 }),
  ];
}

describe('AC 65 — grouping does not depend on listing order', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 65.1: a chain listed newest first is still one set', () => {
    const inventory = chain().reverse();

    // `maxFullSnapshots: 1` keeps the single newest set. If the last entry of the
    // listing were taken as a base while the incrementals above it became bases
    // of their own, this count would keep the newest incremental and delete the
    // base it cannot be replayed without.
    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 1 }));

    expect(evaluator.evaluate(inventory)).toEqual([]);
  });

  it('AC 65.2: a chain listed oldest first stays one set', () => {
    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 1 }));

    expect(evaluator.evaluate(chain())).toEqual([]);
  });

  it('AC 65.3: a removed set is removed whole, oldest first', () => {
    const inventory = chain().reverse();

    const removed = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 0 })).evaluate(inventory);

    expect(ids(removed)).toEqual(['base', 'delta-1', 'delta-2']);
  });

  it('AC 65.4: the whole chain is one set even when the base names itself', () => {
    // Malformed metadata: `self` says its parent is itself. Following that edge
    // would make it its own child, and the traversal would then reach it once as
    // a child and never as a base — so the incremental that depends on it would
    // become a set of its own and the pair could be split by the count rule.
    const inventory = [
      snapshot({ id: 'delta', ageMs: HOUR_MS, parent: 'self' }),
      snapshot({ id: 'self', ageMs: 2 * HOUR_MS, parent: 'self' }),
    ];

    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 1 }));

    expect(evaluator.evaluate(inventory)).toEqual([]);
  });

  it('AC 65.5: a snapshot whose parent is not in the listing is a base of its own', () => {
    // The caller passes whatever listing it has. A filtered listing must not turn
    // into a delete order, so an absent parent makes the snapshot a base rather
    // than an orphan that is neither base nor member.
    const inventory = [
      snapshot({ id: 'delta', ageMs: HOUR_MS, parent: 'not-listed' }),
      snapshot({ id: 'base', ageMs: 2 * HOUR_MS }),
    ];

    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 1 }));

    // Two sets, one of which is kept: the newer `not-listed` chain wins and the
    // older base goes — but `delta` is never removed while it is kept.
    const removed = evaluator.evaluate(inventory);
    expect(ids(removed)).toEqual(['base']);
  });

  it('AC 65.6: an empty listing removes nothing', () => {
    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 0, maxTotalBytes: 1 }));

    expect(evaluator.evaluateWithOutcome([])).toEqual({ toDelete: [], unreclaimedBytes: 0 });
  });

  it('AC 65.7: a snapshot dated in the future is not protected by floors that are not set', () => {
    // Clock skew between the backup host and this one dates a snapshot after
    // "now", so its age is negative. With no floor configured there is no floor
    // to apply: `keepRecent` unset must not read as "keep anything younger than
    // zero milliseconds", which is everything.
    const future = snapshot({ id: 'skewed', ageMs: -HOUR_MS });

    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 0 }));

    expect(ids(evaluator.evaluate([future]))).toEqual(['skewed']);
  });

  it('AC 65.8: a floor that is set does protect the same snapshot', () => {
    // The same input, with `keepRecent` set: now the negative age is inside the
    // window, so the snapshot stays. Without this case the one above would also
    // pass for an evaluator that ignored the floors entirely.
    const future = snapshot({ id: 'skewed', ageMs: -HOUR_MS });

    const evaluator = new RetentionPolicyEvaluator(policy({ maxFullSnapshots: 0, keepRecent: 'P1D' }));

    expect(evaluator.evaluate([future])).toEqual([]);
  });

  it('AC 65.9: bytes a floor forbids reclaiming are reported, not swallowed', () => {
    const inventory = [
      snapshot({ id: 'old', ageMs: 30 * DAY_MS, sizeBytes: 1_000 }),
      snapshot({ id: 'new', ageMs: HOUR_MS, sizeBytes: 19_000 }),
    ];

    const outcome = new RetentionPolicyEvaluator(
      policy({ maxFullSnapshots: 10, maxTotalBytes: 15_000, keepRecent: 'P1D' }),
    ).evaluateWithOutcome(inventory);

    // 20 000 bytes against a 15 000 ceiling. The only removable set is 1 000
    // bytes, and the 19 000-byte set that could close the gap is protected, so
    // 4 000 bytes stay over the ceiling and are reported as unreclaimed rather
    // than quietly declared met.
    expect(ids(outcome.toDelete)).toEqual(['old']);
    expect(outcome.unreclaimedBytes).toBe(4_000);
  });
});
