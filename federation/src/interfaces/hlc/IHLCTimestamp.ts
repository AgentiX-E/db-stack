/**
 * Hybrid Logical Clock (HLC) timestamp.
 * Combines wall clock time with a logical counter for causal ordering
 * across distributed nodes.
 */
export interface IHLCTimestamp {
  /** Physical wall clock component (ms since epoch) */
  wallTime: bigint;

  /** Logical counter to break ties when wallTime is identical */
  logical: number;

  /** Node identifier that generated this timestamp */
  nodeId: string;

  /**
   * Compare two HLC timestamps for causal ordering.
   * Returns:
   *  - negative if this < other
   *  - 0 if equal
   *  - positive if this > other
   */
  compare(other: IHLCTimestamp): number;

  /**
   * Serialize the timestamp to a string for storage or transmission.
   */
  serialize(): string;

  /**
   * Deserialize a string back into an HLC timestamp.
   */
  deserialize(data: string): IHLCTimestamp;
}
