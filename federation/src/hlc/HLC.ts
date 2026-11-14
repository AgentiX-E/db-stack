/**
 * Hybrid Logical Clock (HLC) — Pure TypeScript, zero external dependencies.
 *
 * HLC = max(physical_time, last_observed_hlc)
 *
 * Provides causally-consistent monotonic timestamps without requiring
 * synchronized NTP across nodes. The logical counter advances only when
 * wall clock stalls or falls behind a peer's timestamp.
 *
 * Key properties:
 *   1. Monotonic: consecutive now() calls are strictly increasing
 *   2. Causal: if A happens-before B, then ts(A) < ts(B)
 *   3. Bounded: |hlc - pt| <= logical_counter_max in steady state
 *
 * Usage:
 *   const hlc = new HLC("node-1");
 *   const ts1 = hlc.now();
 *   // ... send ts1 to peer ...
 *   hlc.observe(ts1); // advance local clock past peer's timestamp
 *   const ts2 = hlc.now(); // ts2 > ts1 guaranteed
 */

import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';

/** Internal representation used for comparison mechanics */
interface HLCInternal {
  wallTime: bigint;
  logical: number;
  nodeId: string;
}

export class HLC implements IHLCTimestamp {
  /** Physical wall clock component (ms since epoch) */
  readonly wallTime: bigint;
  /** Logical counter to break ties when wallTime is identical */
  readonly logical: number;
  /** Node identifier that generated this timestamp */
  readonly nodeId: string;

  /** Last observed remote wallTime — used for comparison in now() */
  private lastWall: bigint = 0n;
  /** Last logical counter — incremented when wall is ≤ previous */
  private lastLogical: number = 0;

  /**
   * @param nodeId - Unique identifier for this node
   * @param initialWall - Optional starting wall time (defaults to Date.now())
   * @param initialLogical - Optional starting logical counter (defaults to 0)
   */
  constructor(nodeId: string, initialWall?: bigint, initialLogical?: number) {
    this.nodeId = nodeId;
    const pt = initialWall ?? BigInt(Date.now());
    this.lastWall = pt;
    this.lastLogical = initialLogical ?? 0;
    this.wallTime = this.lastWall;
    this.logical = this.lastLogical;
  }

  /**
   * Generate a new HLC timestamp that is strictly greater than any
   * timestamp previously returned by this instance or observed from peers.
   */
  now(): IHLCTimestamp {
    const pt = BigInt(Date.now());
    let wall: bigint;
    let logical: number;

    if (pt > this.lastWall) {
      wall = pt;
      logical = 0;
    } else if (pt === this.lastWall) {
      wall = this.lastWall;
      logical = this.lastLogical + 1;
    } else {
      // pt < lastWall (system clock moved backwards) — advance logical
      wall = this.lastWall;
      logical = this.lastLogical + 1;
    }

    this.lastWall = wall;
    this.lastLogical = logical;

    return new HLC(this.nodeId, wall, logical);
  }

  /**
   * Advance local HLC to be strictly greater than a remote timestamp.
   * Must be called upon receiving a timestamp from a peer to maintain
   * causal ordering across nodes.
   */
  observe(remote: IHLCTimestamp): void {
    const pt = BigInt(Date.now());
    const maxWall = max3(this.lastWall, remote.wallTime, pt);
    let logical: number;

    if (maxWall === this.lastWall && maxWall === remote.wallTime && maxWall === pt) {
      // All three equal: advance logical past both
      logical = Math.max(this.lastLogical, remote.logical) + 1;
    } else if (maxWall === this.lastWall && maxWall === remote.wallTime) {
      // Local wall and remote wall equal (pt is lower)
      logical = Math.max(this.lastLogical, remote.logical) + 1;
    } else if (maxWall === this.lastWall && maxWall === pt) {
      // Local wall and pt equal (remote wall is lower)
      logical = this.lastLogical + 1;
    } else if (maxWall === remote.wallTime && maxWall === pt) {
      // Remote wall and pt equal (local wall is lower)
      logical = remote.logical + 1;
    } else if (maxWall === this.lastWall) {
      // Only local wall is the max
      logical = this.lastLogical + 1;
    } else if (maxWall === pt) {
      // pt is the sole max
      logical = 0;
    } else {
      // remote.wallTime is the sole max
      logical = remote.logical + 1;
    }

    this.lastWall = maxWall;
    this.lastLogical = logical;
  }

  /**
   * Compare two HLC timestamps for causal ordering.
   * Returns negative if this < other, 0 if equal, positive if this > other.
   */
  compare(other: IHLCTimestamp): number {
    return compareHLC(this, other);
  }

  /**
   * Serialize to a colon-delimited hex string suitable for sorting.
   */
  serialize(): string {
    return hlcToKey(this);
  }

  /**
   * Deserialize from a colon-delimited hex string produced by serialize().
   */
  deserialize(data: string): IHLCTimestamp {
    return keyToHlc(data);
  }
}

/**
 * Pure function comparison (no instance required).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareHLC(a: IHLCTimestamp, b: IHLCTimestamp): number {
  if (a.wallTime < b.wallTime) return -1;
  if (a.wallTime > b.wallTime) return 1;
  if (a.logical < b.logical) return -1;
  if (a.logical > b.logical) return 1;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

/**
 * Check if timestamp `a` happened before `b` (causally prior).
 */
export function happenedBefore(a: IHLCTimestamp, b: IHLCTimestamp): boolean {
  return compareHLC(a, b) < 0;
}

/**
 * Serialize to a sortable colon-delimited hex string.
 * Lexicographic sort matches causal order.
 * Includes nodeId (hex-encoded) for round-trip stability.
 */
export function hlcToKey(ts: IHLCTimestamp): string {
  const wallHex = ts.wallTime.toString(16).padStart(16, '0');
  const logHex = ts.logical.toString(16).padStart(8, '0');
  const nodeHex = Buffer.from(ts.nodeId, 'utf-8').toString('hex');
  return `${wallHex}:${logHex}:${nodeHex}`;
}

/**
 * Parse a string from hlcToKey() back to IHLCTimestamp.
 * All three components (wallTime, logical, nodeId) are restored.
 */
export function keyToHlc(key: string): IHLCTimestamp {
  const parts = key.split(':');
  const wallTime = BigInt(`0x${parts[0]!}`);
  const logical = parseInt(parts[1]!, 16);
  // parts[2] is hex-encoded nodeId; parts[3..] handles any remaining colons
  const nodeHex = parts.slice(2).join(':');
  const nodeId = Buffer.from(nodeHex, 'hex').toString('utf-8');
  return new HLC(nodeId, wallTime, logical);
}

/** Max of three bigints */
function max3(a: bigint, b: bigint, c: bigint): bigint {
  if (a >= b && a >= c) return a;
  if (b >= a && b >= c) return b;
  return c;
}

/**
 * Factory for creating timestamps in tests.
 */
export function makeHLC(wallTime: bigint, logical: number, nodeId: string): IHLCTimestamp {
  return {
    wallTime,
    logical,
    nodeId,
    compare(other: IHLCTimestamp): number {
      return compareHLC(this, other);
    },
    serialize(): string {
      return hlcToKey(this);
    },
    deserialize(_data: string): IHLCTimestamp {
      return keyToHlc(_data);
    },
  };
}
