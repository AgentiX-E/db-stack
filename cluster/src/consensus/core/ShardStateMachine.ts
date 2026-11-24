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

  /**
   * Where the entry about to be applied sits in the log, when the caller knows.
   *
   * raft-core hands `apply()` a payload and nothing else, so the position has to
   * come from the caller. It used to be documented as this callback and there was
   * no such callback: `applyHandler` declared `index?` and `term?` parameters that
   * no caller ever filled, so an engine that persists state — and PITR, which
   * records where each write happened — could not have known where it was in the
   * log. Reported rather than guessed: a caller that does not know returns
   * `undefined` and the handler is called with the payload alone.
   */
  getEntryContext?: () => { index: number; term: number } | undefined;

  /** Called to serialize current state for snapshot. Should return serialized state bytes. */
  takeSnapshotCallback?: () => Buffer | Promise<Buffer>;
  /** Called to restore state from snapshot bytes. */
  installSnapshotCallback?: (data: Buffer) => void | Promise<void>;
}

/** What the adapter has actually done, as opposed to what it was constructed to do. */
export interface ShardStateMachineSnapshot {
  /** `degraded` while the most recent apply is the one that failed. */
  status: 'running' | 'degraded';
  /** Commands that reached the handler and returned. */
  appliedCommands: number;
  /** Log position of the most recent attempt, or null before the first one. */
  appliedIndex: number | null;
  appliedTerm: number | null;
  /** Wall clock of the most recent successful apply, or null before the first one. */
  lastAppliedAt: number | null;
  /** Reason the most recent apply failed, or null. Cleared by a success. */
  lastError: string | null;
}

export class ShardStateMachine implements ApplicationStateMachine {
  private callbacks: ShardStateMachineCallbacks;
  private appliedCommands = 0;
  private appliedIndex: number | null = null;
  private appliedTerm: number | null = null;
  private lastAppliedAt: number | null = null;
  private lastError: string | null = null;

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

    // Read once per entry: a context that changes between the read and the call
    // would report one position and apply another.
    const context = this.callbacks.getEntryContext?.();
    if (context) {
      this.appliedIndex = context.index;
      this.appliedTerm = context.term;
    }

    if (this.callbacks.applyHandler) {
      try {
        if (context) {
          await this.callbacks.applyHandler(data, context.index, context.term);
        } else {
          await this.callbacks.applyHandler(data);
        }
        this.appliedCommands += 1;
        this.lastAppliedAt = Date.now();
        this.lastError = null;
      } catch (err: any) {
        // The failure is state, not just a log line: the next `getState()` is how
        // a caller finds out that this replica is not applying.
        this.lastError = err?.message ?? String(err);
        logger.error({ err }, `[ShardStateMachine] applyHandler error: ${this.lastError}`);
        throw err;
      }
    } else {
      this.appliedCommands += 1;
      this.lastAppliedAt = Date.now();
    }
  }

  /**
   * What this state machine has applied.
   *
   * It used to return `{ status: 'running' }` on every call. The answer a leader
   * asks for — is this replica caught up, and if not, why — was the same for a
   * shard that had applied nothing and one that had applied everything, and the
   * same after a failure as before it.
   */
  getState(): ShardStateMachineSnapshot {
    return {
      status: this.lastError === null ? 'running' : 'degraded',
      appliedCommands: this.appliedCommands,
      appliedIndex: this.appliedIndex,
      appliedTerm: this.appliedTerm,
      lastAppliedAt: this.lastAppliedAt,
      lastError: this.lastError,
    };
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
