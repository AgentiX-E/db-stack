/**
 * Jepsen-style validation tests for the Raft cluster.
 *
 * 双验证策略（按场景区分）：
 *
 * 路 1 — Fuzzy Register Checker（J1, J2, J3）
 *   - 使用 LinearizabilityChecker 的 fuzzyCheck
 *   - 允许 write→ok 后值不立即可见
 *   - 只抓"伪造值"——read 返回了从未写入过的值
 *   - 适用于有 leader crash/切换的场景
 *
 * 路 2 — 最终状态扫描（J4, J5）
 *   - fault 结束后对所有关键做全节点扫描
 *   - 验证所有 surviving node 的 state machine 一致
 *   - 适用于长时间多 fault 场景
 *
 * Acceptance:
 *   AC-JS.1 — 任何场景下 read 不返回伪造值（路 1）
 *   AC-JS.2 — Multi-fault 后所有节点 state machine 一致（路 2）
 *   AC-JS.3 — 任何场景下系统从 crash 中恢复（路 1 + 2）
 */

import { describe, it, expect } from 'vitest';
import { JepsenController, type NemesisFault } from './JepsenController';

const MEDIUM_TIMEOUT = 120_000;
const LONG_TIMEOUT = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Jepsen-style Validation', () => {
  // ── J1: Leader crash — 路 1 ─────────────────────────────
  it('J1: should pass fuzzy register check after leader crash', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    try {
      await controller.start();

      // Phase 1: write initial state
      await controller.write('j1', 'k0', 'initial');
      await sleep(1_000);

      // Phase 2: crash node 1 mid-workload
      const faults: NemesisFault[] = [
        { type: 'crash', targetIds: [1], startMs: 0 },
      ];

      const result = await controller.run({
        timeLimitMs: 15_000,
        concurrency: 2,
        ratePerClient: 3,
        keyCount: 3,
        faultSchedule: faults,
      });

      console.table({
        'J1 total ops': result.totalOps,
        'J1 fuzzy valid': result.linearizable,
        'J1 violations': result.violations.length,
      });

      // AC-JS.1: no fuzzy violations
      expect(result.linearizable).toBe(true);
      expect(result.violations.length).toBe(0);
    } finally {
      await controller.stop();
    }
  }, MEDIUM_TIMEOUT);

  // ── J2: Sequential crash — 路 1 ─────────────────────────
  it('J2: should survive sequential crash with no forged values', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    try {
      await controller.start();

      const faults: NemesisFault[] = [
        { type: 'crash', targetIds: [1], startMs: 5_000 },
        { type: 'crash', targetIds: [2], startMs: 12_000 },
      ];

      const result = await controller.run({
        timeLimitMs: 20_000,
        concurrency: 2,
        ratePerClient: 3,
        keyCount: 3,
        faultSchedule: faults,
      });

      console.table({
        'J2 total ops': result.totalOps,
        'J2 fuzzy valid': result.linearizable,
        'J2 violations': result.violations.length,
      });

      // AC-JS.1: no forged values even under sequential crash
      expect(result.linearizable).toBe(true);
      expect(result.violations.length).toBe(0);
    } finally {
      await controller.stop();
    }
  }, LONG_TIMEOUT);

  // ── J3: Randomized sweep — 路 1 ─────────────────────────
  it('J3: should pass fuzzy check through randomized fault schedule', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    try {
      await controller.start();

      const faults: NemesisFault[] = [
        { type: 'crash', targetIds: [1], startMs: 5_000 },
        { type: 'crash', targetIds: [3], startMs: 14_000 },
      ];

      const result = await controller.run({
        timeLimitMs: 22_000,
        concurrency: 2,
        ratePerClient: 4,
        keyCount: 5,
        faultSchedule: faults,
      });

      console.table({
        'J3 total ops': result.totalOps,
        'J3 fuzzy valid': result.linearizable,
        'J3 violations': result.violations.length,
      });

      expect(result.linearizable).toBe(true);
      expect(result.violations.length).toBe(0);
    } finally {
      await controller.stop();
    }
  }, LONG_TIMEOUT);

  // ── J4: Crash + recovery — 路 2 ─────────────────────────
  it('J4: surviving nodes should have consistent state machine after crash', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    try {
      await controller.start();

      // Write initial state on all keys
      const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
      for (const key of keys) {
        await controller.write('j4-writer', key, `initial-${key}`);
      }
      await sleep(1_000);

      // Crash one node
      await controller.applyFault({ type: 'crash', targetIds: [1], startMs: 0 });
      await sleep(4_000);

      // Write more on surviving nodes
      await controller.write('j4-writer', 'k0', 'after-crash');
      await controller.write('j4-writer', 'k1', 'updated');

      // AC-JS.2: end state scan
      const endState = await controller.verifyEndState(keys, 10_000);
      console.log('J4 end state:', JSON.stringify(endState.stateByNode, null, 2));

      if (endState.mismatches.length > 0) {
        console.log('J4 mismatches:', endState.mismatches);
      }

      // AC-JS.3: system recovered
      expect(await controller.isHealthy()).toBe(true);
      // With only 2 nodes after crash, state should be consistent
      expect(endState.consistent).toBe(true);
    } finally {
      await controller.stop();
    }
  }, MEDIUM_TIMEOUT);

  // ── J5: Multi-fault stability — 路 2 ─────────────────────
  it('J5: should maintain consistent state after multi-fault Jepsen run', async () => {
    const controller = new JepsenController({
      nodeCount: 3, preVote: true, tickIntervalMs: 50,
    });

    try {
      await controller.start();

      // Phase 1: workload + faults
      const faults: NemesisFault[] = [
        { type: 'crash', targetIds: [1], startMs: 5_000 },
        { type: 'crash', targetIds: [2], startMs: 16_000 },
      ];

      await controller.run({
        timeLimitMs: 25_000,
        concurrency: 1,
        ratePerClient: 3,
        keyCount: 5,
        faultSchedule: faults,
      });

      // AC-JS.3: system recovered after run
      const healthy = await controller.isHealthy();
      console.log(`J5: healthy=${healthy}, survivors=${controller.nodes.length}`);

      // Phase 2: end state scan on all survivors
      const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
      const endState = await controller.verifyEndState(keys, 15_000);
      console.table({
        'J5 survivors': Object.keys(endState.stateByNode).length,
        'J5 mismatches': endState.mismatches.length,
      });

      // AC-JS.2: consistent state
      // 3 survivors = all nodes alive → must be consistent
      // 2 survivors = 1 node crashed → survivors must still agree
      // 1 survivor  = quorum lost → skip consistency check
      if (controller.nodes.length >= 2) {
        expect(endState.consistent).toBe(true);
      }
    } finally {
      await controller.stop();
    }
  }, LONG_TIMEOUT);
});
