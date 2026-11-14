/**
 * CDCEngine — Change Data Capture engine.
 *
 * Watches tables (simulated), produces CDCChangeEvent streams,
 * and supports:
 *   - Table-level subscriptions (insert/update/delete)
 *   - HLC timestamp attachment
 *   - onChange event emission
 *   - Start / stop lifecycle
 *
 * In real deployment, the engine wraps a PostgreSQL logical replication
 * decoder or similar WAL-level change stream. For testing, it simulates
 * change events via appendChange().
 */

import type { ICDCEngine, CDCChangeEvent } from '../interfaces/replication/ICDCManager';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC } from '../hlc/HLC';
import { randomUUID } from 'crypto';

export type CDCEngineConfig = {
  nodeId: string;
  hlc?: HLC;
};

export class CDCEngine implements ICDCEngine {
  private readonly hlc: HLC;
  private readonly watchedTables = new Set<string>();
  private readonly listeners = new Set<(event: CDCChangeEvent) => void>();
  private _started = false;

  constructor(config: CDCEngineConfig) {
    this.hlc = config.hlc ?? new HLC(config.nodeId);
  }

  async start(): Promise<void> {
    this._started = true;
  }

  async stop(): Promise<void> {
    this._started = false;
    this.listeners.clear();
  }

  watchTable(tableName: string): void {
    this.watchedTables.add(tableName);
  }

  unwatchTable(tableName: string): void {
    this.watchedTables.delete(tableName);
  }

  getWatchedTables(): string[] {
    return Array.from(this.watchedTables);
  }

  onChange(callback: (event: CDCChangeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Test-only: simulate a CDC change event.
   * In production, this would be triggered by WAL decoding.
   */
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent {
    const timestamp = this.hlc.now();
    const event: CDCChangeEvent = {
      lsn: `0/${(Date.now() * 1000).toString(16)}`,
      timestamp,
      txId: randomUUID(),
      ...change,
    };

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  get started(): boolean {
    return this._started;
  }
}
