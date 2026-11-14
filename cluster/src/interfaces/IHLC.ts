/**
 * IHLC — Interface for Hybrid Logical Clocks.
 */
export interface IHLC {
  now(): HlcTimestamp;
  update(ts: HlcTimestamp): void;
  maxDriftUs(): number;
}

export interface HlcTimestamp {
  wall: number;
  logical: number;
}
