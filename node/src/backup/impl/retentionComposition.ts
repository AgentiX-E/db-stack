/**
 * The composition root that connects a retention policy to its snapshot schedule.
 *
 * Both objects were constructible on their own, and both answered questions
 * that sounded related: the policy said how long a backup must survive, and the
 * schedule said how often one is taken. Nothing compared the two, so a policy
 * promising a day and a schedule taking one every two days was a deployment
 * that passed every gate and deleted the only restore it had. This module is the
 * place where both are in hand, so it is the place that checks the pair.
 *
 * The schedule is the deployment's `IBackupScheduleConfig`; no scheduler method
 * is invented here and no engine appears in the signature. A caller with no
 * schedule passes `null` and gets an evaluator that says it cannot check the
 * interval rather than one that pretends to.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import type { IBackupScheduleConfig } from '../interfaces/index.js';
import type { RetentionPolicy } from '../../core/types.js';
import { RetentionPolicyEvaluator } from './RetentionPolicyEvaluator.js';

/**
 * Build the evaluator the deployment will actually use, with the period its
 * scheduler will actually run.
 *
 * A disabled schedule is refused rather than treated as uncheckable: an
 * interval of zero snapshots an infinite time apart, and the policy's window
 * expires before the first backup exists. `null` means a caller genuinely has
 * no schedule and is told that by `getWindows()` returning no interval.
 */
export function createRetentionForSchedule(
  policy: RetentionPolicy,
  schedule: IBackupScheduleConfig | null,
): RetentionPolicyEvaluator {
  if (schedule !== null && !schedule.enabled) {
    throw new Error('the schedule is disabled, so no snapshot will ever be taken and no retention window can be kept');
  }
  return new RetentionPolicyEvaluator(policy, schedule === null ? {} : { snapshotIntervalMs: schedule.intervalMs });
}
