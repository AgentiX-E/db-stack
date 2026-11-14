/**
 * Direct Jepsen linearizability debug — creates a simplified JepsenController
 * run and dumps the paired operations + DFS state.
 */

import { describe, it, expect } from 'vitest';
import { JepsenController, type NemesisFault } from './JepsenController';

describe('Jepsen Debug', () => {
  it('should dump J1 history for analysis', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    let linearizable: boolean | 'unknown' = false;
    let totalOps = 0;
    let completedOps = 0;

    try {
      await controller.start();

      // Simple single-client writes
      const faults: NemesisFault[] = [
        { type: 'crash', targetIds: [1], startMs: 5_000 },
      ];

      const result = await controller.run({
        timeLimitMs: 10_000,  // shorter for faster debug
        concurrency: 1,       // single client
        ratePerClient: 5,
        keyCount: 3,
        faultSchedule: faults,
      });

      linearizable = result.linearizable;
      totalOps = result.totalOps;
      completedOps = result.completedOps;

      console.log(`\n=== J1 Debug ===`);
      console.log(`Total ops: ${totalOps}`);
      console.log(`Completed ops: ${completedOps}`);
      console.log(`Linearizable: ${linearizable}`);

      if (linearizable === false) {
        // Dump events for manual analysis
        // Access recorder events through the controller's internal state
        const history = result.history;
        console.log(`\nHistory entries: ${history.length}`);
        
        // Group by key
        const byKey = new Map<string, Array<{ type: string; op: string; val: string | null; time: number }>>();
        for (const op of history) {
          const [key, val] = op.value;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key)!.push({ type: op.type, op: op.f, val, time: op.time });
        }

        for (const [key, ops] of byKey) {
          console.log(`\nKey ${key}: ${ops.length} operations`);
          const samples = ops.slice(-10); // last 10
          for (const s of samples) {
            console.log(`  ${s.type} ${s.op} ${s.val} @${s.time}`);
          }
        }

        console.log(`\n=== Debug complete ===`);
      }
    } finally {
      await controller.stop();
    }

    // Don't assert — just dump info
    expect(true).toBe(true);
  }, 120_000);
});
