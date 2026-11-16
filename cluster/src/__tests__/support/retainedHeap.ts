/**
 * Retained-heap sampling for the boundary suites.
 *
 * `process.memoryUsage().heapUsed` reports what V8 has allocated and not yet
 * collected. Sampled before and after a run, the difference therefore moves
 * with *when the collector happened to fire* as much as with what the workload
 * keeps — which is how a 10 000-proposal case came to carry a 100 MB bound and
 * then failed on a runner at 111.6 MB (CI run 43909923898) with nothing wrong
 * in the product. See P3-6 in plan/ROADMAP.md.
 *
 * A forced collection before each sample turns the same number into retention:
 * everything unreachable has been reclaimed, so the difference between two
 * samples is what the workload still holds.
 *
 * Why the flag is set at runtime
 * ------------------------------
 * `--expose-gc` cannot be handed to a worker thread: `new Worker(..., { execArgv:
 * ['--expose-gc'] })` answers `ERR_WORKER_INVALID_EXEC_ARGV`, and these suites
 * run in vitest's `threads` pool (see the pool note in vitest.config.ts). The
 * flag is set on the isolate at runtime instead, and the resulting collector is
 * taken from a fresh context — the mechanism the `expose-gc` package uses. It
 * works inside a worker because every worker owns its isolate.
 */

import vm from 'node:vm';
import v8 from 'node:v8';

let collector: (() => void) | undefined;

/**
 * The isolate's garbage collector, obtained once.
 *
 * Throws rather than returning a no-op: a caller that cannot collect must fail
 * loudly, because the alternative is a heap assertion that silently goes back
 * to measuring allocation — the exact defect this module exists to remove.
 */
function collect(): () => void {
  if (collector === undefined) {
    v8.setFlagsFromString('--expose-gc');
    const candidate = vm.runInNewContext('gc') as unknown;
    if (typeof candidate !== 'function') {
      throw new Error(
        'retainedHeap: no garbage collector available on this isolate; a heap ' +
          'assertion here would measure allocation instead of retention',
      );
    }
    collector = candidate as () => void;
  }
  return collector;
}

/**
 * Heap in MB, with everything unreachable reclaimed.
 *
 * Collected twice before sampling: the first pass frees ordinary garbage and
 * makes a second class of objects unreachable (cleared weak references,
 * finaliser-reachable wrappers), which the second pass then reclaims. One pass
 * leaves enough behind that consecutive samples of the same workload can differ
 * by more than the workload itself.
 */
export function retainedHeapMB(): number {
  const gc = collect();
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Retained growth allowed for a case regardless of how much it writes, in MB. */
const FLOOR_MB = 8;

/**
 * What one proposal is allowed to leave behind, in bytes.
 *
 * Measured on a 3-node cluster: 0.57 KB at 10 000 proposals (HC.1), 0.33 KB at
 * 30 000 (BC.2), 0.6 KB at 1 000 (HC.4) — the log entry, its index, and the
 * pending-commit bookkeeping. Twice the largest of those, rounded up, so that a
 * change which quadruples the per-entry cost fails the case while an ordinary
 * runner-to-runner difference does not.
 */
const BYTES_PER_PROPOSAL = 2 * 1024;

/**
 * A retained-growth budget scaled to the work a case asks for.
 *
 * The previous bounds were four constants for three different volumes — 100 MB
 * on 10 000 proposals and 300 MB on 2 000 — which is a statement about how
 * nervous each case felt rather than about what it should retain. A budget that
 * grows with the case keeps the property being asserted the same everywhere:
 * retention per proposal is bounded, so a leak shows up in the smallest case
 * too instead of only after it has grown large enough to cross a fixed line.
 */
export function retainedGrowthBudgetMB(proposals: number): number {
  return FLOOR_MB + (proposals * BYTES_PER_PROPOSAL) / (1024 * 1024);
}
