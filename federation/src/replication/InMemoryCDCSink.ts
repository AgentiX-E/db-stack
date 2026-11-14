/**
 * InMemoryCDCSink — In-memory CDC sink for testing and development.
 *
 * Stores events in an array for later inspection. Useful for:
 *   - Integration tests that need to verify emitted events
 *   - Development where no external sink is available
 *   - Benchmarking CDC throughput without I/O
 */

import type { ICDCSink, CDCEvent } from "../interfaces/replication/ICDCSink";

export class InMemoryCDCSink implements ICDCSink {
  readonly name: string;

  private readonly _events: CDCEvent[] = [];
  private _connected = false;

  constructor(name?: string) {
    this.name = name ?? "in-memory-cdc-sink";
  }

  /** Check if the sink is connected */
  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async emit(events: CDCEvent[]): Promise<void> {
    if (!this._connected) {
      throw new Error("InMemoryCDCSink: cannot emit when disconnected");
    }
    this._events.push(...events);
  }

  /** Get all events emitted so far (in order) */
  getEvents(): CDCEvent[] {
    return [...this._events];
  }

  /** Clear all stored events */
  clear(): void {
    this._events.length = 0;
  }
}
