/**
 * ShardStateMachine — Adapter between @maboke123/raft-core ApplicationStateMachine
 * and the db-cluster apply handler used by ShardReplica.
 *
 * Delegates committed commands to the applyHandler callback, and
 * snapshot operations to optional snapshot/installSnapshot callbacks.
 *
 * @module consensus/core/ShardStateMachine
 */

import type { ApplicationStateMachine, Command } from '@maboke123/raft-core';
import type { SnapshotMetaData } from '../storage/snapshotTypes';
import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';

const logger = pino({ level: resolveLogLevel() });

export interface ShardStateMachineCallbacks {
  /**
   * Called for every committed entry with the payload and, when the caller can
   * supply it, the entry's position in the log.
   *
   * The position is not decoration: an engine that persists state needs it to make
   * replay idempotent after a restart, and point-in-time recovery needs it to
   * record where in the log each write happened. raft-core hands `apply()` only the
   * command payload, so the caller supplies the position through
   * {@link ShardStateMachineCallbacks.getEntryContext}.
   *
   * Returning a promise is supported and awaited, so an apply failure reaches the
   * consensus layer instead of being logged and forgotten.
   */
  applyHandler?: (data: string, index?: number, term?: number) => void | Promise<void>;

  /** Called to serialize current state for snapshot. Should return serialized state bytes. */
  takeSnapshotCallback?: () => Buffer | Promise<Buffer>;
  /** Called to restore state from snapshot bytes. */
  installSnapshotCallback?: (data: Buffer) => void | Promise<void>;
}

export class ShardStateMachine implements ApplicationStateMachine {
  private callbacks: ShardStateMachineCallbacks;

  constructor(callbacks: ShardStateMachineCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Apply a committed command to the application state machine.
   * The command payload is expected to be a string, which is passed
   * to the applyHandler callback along with the entry's index and term.
   *
   * Note: Command type is always "command" for client-submitted entries.
   */
  async apply(command: Command): Promise<any> {
    const payload = command.payload;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

    if (this.callbacks.applyHandler) {
      try {
        await this.callbacks.applyHandler(data);
      } catch (err: any) {
        logger.error({ err }, `[ShardStateMachine] applyHandler error: ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * Returns a view of the current application state.
   * For now returns a summary object.
   */
  getState(): any {
    return { status: 'running' };
  }

  /**
   * Serializes current application state into a Buffer for snapshot.
   * Delegates to takeSnapshotCallback if provided.
   */
  async takeSnapshot(): Promise<Buffer> {
    if (this.callbacks.takeSnapshotCallback) {
      const result = this.callbacks.takeSnapshotCallback();
      return result instanceof Promise ? result : Promise.resolve(result);
    }
    // Default: empty snapshot
    return Buffer.alloc(0);
  }

  /**
   * Restores application state from snapshot bytes.
   * Delegates to installSnapshotCallback if provided.
   */
  async installSnapshot(data: Buffer): Promise<void> {
    if (this.callbacks.installSnapshotCallback) {
      const result = this.callbacks.installSnapshotCallback(data);
      if (result instanceof Promise) {
        await result;
      }
    }
  }
}
