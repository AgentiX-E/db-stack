/**
 * InMemoryConnectionMonitor — IConnectionMonitor implementation.
 *
 * Tracks connection pool statistics per pool ID using an in-memory map.
 * Supports open/close/waiting reporting and utilization calculation.
 *
 * @module @agentix-e/db-operations-monitor/impl
 */

import type { ConnectionPoolStatus } from '@agentix-e/db-operations-core/types';
import type { IConnectionInfo, IConnectionMonitor } from '../interfaces/index.js';

interface PoolState {
  active: number;
  idle: number;
  waiting: number;
  maxSize: number;
}

interface PoolStat {
  poolId: string;
  status: ConnectionPoolStatus;
}

/**
 * In-memory connection monitor.
 */
export class InMemoryConnectionMonitor implements IConnectionMonitor {
  private readonly _poolStats = new Map<string, PoolState>();
  private _totalOpened = 0;
  private _connections: Map<string, IConnectionInfo> = new Map();
  private _exhaustionCallbacks: Array<(stats: { total: number; active: number; waiting: number }) => void> = [];

  /**
   * Start monitoring.
   */
  start(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Stop monitoring.
   */
  stop(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Report a connection opened in a pool.
   */
  reportConnectionOpened(poolId: string): void {
    const pool = this._getOrCreatePool(poolId);
    pool.active++;
    this._totalOpened++;
  }

  /**
   * Report a connection closed in a pool.
   */
  reportConnectionClosed(poolId: string): void {
    const pool = this._poolStats.get(poolId);
    if (pool && pool.active > 0) {
      pool.active--;
    }
  }

  /**
   * Report a connection waiting in a pool.
   */
  reportConnectionWaiting(poolId: string): void {
    const pool = this._getOrCreatePool(poolId);
    pool.waiting++;
  }

  /**
   * Get pool status for all pools.
   */
  getPoolStatus(): PoolStat[] {
    const result: PoolStat[] = [];
    for (const [poolId, state] of this._poolStats) {
      result.push({
        poolId,
        status: this._createStatus(state),
      });
    }
    return result;
  }

  /**
   * Get total connections opened.
   */
  getTotalOpened(): number {
    return this._totalOpened;
  }

  // ── IConnectionMonitor interface ──

  getConnections(): Promise<IConnectionInfo[]> {
    return Promise.resolve(Array.from(this._connections.values()));
  }

  getPoolUtilization(): Promise<{ total: number; active: number; idle: number; waiting: number }> {
    let total = 0;
    let active = 0;
    let idle = 0;
    let waiting = 0;
    for (const state of this._poolStats.values()) {
      total += state.active + state.idle;
      active += state.active;
      idle += state.idle;
      waiting += state.waiting;
    }
    return Promise.resolve({ total, active, idle, waiting });
  }

  onExhaustion(callback: (stats: { total: number; active: number; waiting: number }) => void): void {
    this._exhaustionCallbacks.push(callback);
  }

  // ── Private Helpers ──

  private _getOrCreatePool(poolId: string): PoolState {
    if (!this._poolStats.has(poolId)) {
      this._poolStats.set(poolId, { active: 0, idle: 0, waiting: 0, maxSize: 100 });
    }
    return this._poolStats.get(poolId)!;
  }

  private _createStatus(state: PoolState): ConnectionPoolStatus {
    const utilization = state.maxSize > 0 ? state.active / state.maxSize : 0;
    return {
      total: state.active + state.idle,
      active: state.active,
      idle: state.idle,
      waiting: state.waiting,
      maxSize: state.maxSize,
      utilization: Math.round(utilization * 10000) / 10000,
    };
  }

  /**
   * Add a connection for tracking.
   */
  addConnection(conn: IConnectionInfo): void {
    this._connections.set(conn.id, conn);
  }

  /**
   * Remove a connection from tracking.
   */
  removeConnection(connId: string): void {
    this._connections.delete(connId);
  }

  /**
   * Clear all pool stats.
   */
  reset(): void {
    this._poolStats.clear();
    this._totalOpened = 0;
    this._connections.clear();
  }
}
