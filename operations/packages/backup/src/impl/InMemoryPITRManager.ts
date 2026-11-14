/**
 * InMemoryPITRManager — Simulates point-in-time recovery without actual WAL.
 *
 * @module @agentix-e/db-operations-backup/impl
 */

import type { IPITRManager } from '../interfaces/index.js';
import type { PITRTarget } from '@agentix-e/db-operations-core/types';

/**
 * In-memory implementation of IPITRManager.
 * Uses a simulated WAL LSN string for testing.
 */
export class InMemoryPITRManager implements IPITRManager {
  private walLsn: string;
  private enabled: boolean;

  constructor(walLsn = '0/0', enabled = true) {
    this.walLsn = walLsn;
    this.enabled = enabled;
  }

  /** @inheritdoc */
  async getCurrentLSN(): Promise<string> {
    return this.walLsn;
  }

  /** @inheritdoc */
  async getCurrentTimestamp(): Promise<string> {
    return new Date().toISOString();
  }

  /** @inheritdoc */
  async archiveCurrentWal(): Promise<void> {
    // Simulated — no-op in memory
  }

  /** @inheritdoc */
  async resolveTarget(_target: PITRTarget): Promise<{
    snapshotId: string;
    walEndLsn: string;
    approxTime: string;
  }> {
    return {
      snapshotId: 'pitr-snap-1',
      walEndLsn: this.walLsn,
      approxTime: new Date().toISOString(),
    };
  }

  /** @inheritdoc */
  isEnabled(): boolean {
    return this.enabled;
  }
}
