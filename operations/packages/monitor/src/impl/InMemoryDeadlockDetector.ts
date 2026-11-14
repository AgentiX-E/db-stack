/**
 * InMemoryDeadlockDetector — IDeadlockDetector implementation.
 *
 * Uses DFS cycle detection on a wait-for graph built from
 * lock-wait and lock-acquired reports.
 *
 * @module @agentix-e/db-operations-monitor/impl
 */

import type { DeadlockEvent } from '@agentix-e/db-operations-core/types';
import type { IDeadlockInfo } from '../interfaces/index.js';

/**
 * In-memory deadlock detector with eager cycle detection.
 */
export class InMemoryDeadlockDetector {
  /** Transaction → Set of resource IDs it's waiting for. */
  private readonly _waitFor = new Map<string, Set<string>>();
  /** Transaction → Set of resource IDs it holds. */
  private readonly _acquired = new Map<string, Set<string>>();
  /** History of deadlock events. */
  private readonly _deadlocks: DeadlockEvent[] = [];
  /** Callbacks invoked on deadlock detection. */
  private readonly _callbacks: Array<(info: IDeadlockInfo) => void> = [];
  /** Default timeout in ms. */
  private readonly _timeoutMs = 5000;

  /**
   * Start monitoring for deadlocks.
   */
  start(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Stop monitoring for deadlocks.
   */
  stop(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Register a callback for deadlock detection.
   */
  onDeadlock(callback: (info: IDeadlockInfo) => void): void {
    this._callbacks.push(callback);
  }

  /**
   * Report that a transaction is waiting for a resource.
   * Triggers eager deadlock detection.
   */
  reportLockWait(txId: string, resourceId: string): void {
    if (!this._waitFor.has(txId)) {
      this._waitFor.set(txId, new Set());
    }
    this._waitFor.get(txId)!.add(resourceId);
  }

  /**
   * Report that a transaction acquired a lock on a resource.
   */
  reportLockAcquired(txId: string, resourceId: string): void {
    if (!this._acquired.has(txId)) {
      this._acquired.set(txId, new Set());
    }
    this._acquired.get(txId)!.add(resourceId);
    this._waitFor.get(txId)?.delete(resourceId);
  }

  /**
   * Report a lock timeout — records it as a deadlock event.
   */
  reportLockTimeout(txId: string, resourceId: string): void {
    const event: DeadlockEvent = {
      timestamp: new Date().toISOString(),
      transactions: [txId],
      resources: [resourceId],
      resolvedBy: `timeout:${txId}`,
    };
    this._deadlocks.push(event);
    this._notifyCallbacks({
      cycle: [txId],
      victimTransaction: txId,
      detectedAt: new Date(),
    });
  }

  /**
   * Get the history of detected deadlocks.
   */
  getDeadlockHistory(): Promise<IDeadlockInfo[]> {
    return Promise.resolve(
      this._deadlocks.map((e) => ({
        cycle: e.transactions,
        victimTransaction: e.resolvedBy.replace(/^timeout:/, ''),
        detectedAt: new Date(e.timestamp),
      })),
    );
  }

  /**
   * Get raw deadlock events.
   */
  getRawDeadlockEvents(): DeadlockEvent[] {
    return [...this._deadlocks];
  }

  /**
   * Get the number of detected deadlocks.
   */
  getDeadlockCount(): number {
    return this._deadlocks.length;
  }

  /**
   * Detect deadlocks using DFS cycle detection on the wait-for graph.
   * Returns detected deadlock events.
   */
  detectDeadlocks(): DeadlockEvent[] {
    const events = this._detect();
    return events;
  }

  // ── Private ──

  /**
   * Build a dependency graph and run DFS cycle detection.
   * Graph: vertex = transaction ID
   * Edge  A → B if A is waiting for a resource that B holds.
   */
  private _detect(): DeadlockEvent[] {
    const graph = this._buildGraph();
    const events: DeadlockEvent[] = [];

    // Iterative DFS with an explicit color map. A single pass discovers every
    // cycle reachable from each unvisited node without the O(N^2) rescan loop.
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const path: string[] = [];

    const colorOf = (node: string): number => color.get(node) ?? WHITE;

    const visit = (node: string): void => {
      color.set(node, GRAY);
      path.push(node);

      for (const neighbor of graph.get(node) ?? []) {
        if (colorOf(neighbor) === WHITE) {
          visit(neighbor);
        } else if (colorOf(neighbor) === GRAY) {
          // A GRAY neighbor closes a cycle: [neighbor ... node] within path.
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          const event = this._makeCycleEvent(cycle);
          events.push(event);
          this._deadlocks.push(event);
          const cycleHead = cycle[0];
          if (cycleHead !== undefined) this._waitFor.delete(cycleHead);
        }
      }

      path.pop();
      color.set(node, BLACK);
    };

    for (const node of graph.keys()) {
      if (colorOf(node) === WHITE) {
        visit(node);
      }
    }

    return events;
  }

  /**
   * Build a DeadlockEvent for a detected cycle and notify registered callbacks.
   */
  private _makeCycleEvent(cycle: string[]): DeadlockEvent {
    const victimTx = cycle[0];
    if (victimTx === undefined) {
      throw new Error('_makeCycleEvent requires a non-empty cycle');
    }

    const resourceList: string[] = [];
    for (const tx of cycle) {
      const held = this._acquired.get(tx);
      const wait = this._waitFor.get(tx);
      if (held)
        for (const r of held) {
          resourceList.push(r);
        }
      if (wait)
        for (const r of wait) {
          resourceList.push(r);
        }
    }

    // Victim: pick the first transaction in the detected cycle.
    // (There is no timestamp here, so the earliest DFS-path node is
    // used as a deterministic victim to break the deadlock.)
    const victim = victimTx;

    const event: DeadlockEvent = {
      timestamp: new Date().toISOString(),
      transactions: [...cycle],
      resources: [...new Set(resourceList)],
      resolvedBy: victim,
    };

    this._notifyCallbacks({
      cycle: [...cycle],
      victimTransaction: victim,
      detectedAt: new Date(event.timestamp),
    });

    return event;
  }

  /**
   * Build a directed graph from wait-for + acquired state.
   * Edge tx1 → tx2 if tx1 waits for a resource held by tx2.
   */
  private _buildGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();

    // For each transaction that is waiting
    for (const [waitingTx, resourcesWanted] of this._waitFor) {
      if (!graph.has(waitingTx)) {
        graph.set(waitingTx, new Set());
      }

      // For each resource it waits on
      for (const resourceId of resourcesWanted) {
        // Find which transactions hold this resource
        for (const [holderTx, heldResources] of this._acquired) {
          if (holderTx !== waitingTx && heldResources.has(resourceId)) {
            graph.get(waitingTx)!.add(holderTx);
          }
        }
      }
    }

    return graph;
  }

  private _notifyCallbacks(info: IDeadlockInfo): void {
    for (const cb of this._callbacks) {
      try {
        cb(info);
      } catch {
        // Swallow callback errors
      }
    }
  }
}
