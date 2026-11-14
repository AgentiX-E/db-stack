/**
 * CRDT Types — Strongly-typed CRDT data structures.
 *
 * Each CRDT is a separate class with merge() for commutative convergence.
 * All CRDTs are serializable to/from JSON for network transport.
 *
 * CRDT Types:
 *   - GCounter: Grow-only counter (increment by node)
 *   - PNCounter: Positive-Negative counter (increment + decrement)
 *   - LWWRegister: Last-Writer-Wins register with HLC timestamps
 *   - MVRegister: Multi-Value register (keeps all concurrent values)
 *   - ORSet: Observed-Remove Set with unique element tags
 */

import type { IHLCTimestamp } from "../interfaces/hlc/IHLCTimestamp";

// ── GCounter ────────────────────────────────────────────────

/**
 * Grow-Only Counter (state-based).
 * Each node maintains its own count; merge = element-wise max.
 *
 * Idempotent, commutative, associative.
 */
export interface GCounterState {
  /** nodeId → count */
  readonly counts: Record<string, number>;
}

export class GCounter {
  readonly counts: Record<string, number>;

  constructor(initial: GCounterState = { counts: {} }) {
    this.counts = { ...initial.counts };
  }

  /** Increment count for this node. */
  increment(nodeId: string, delta = 1): void {
    this.counts[nodeId] = (this.counts[nodeId] ?? 0) + delta;
  }

  /** Get the total value (sum of all node counts). */
  value(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  /** Merge with another GCounter (element-wise max). */
  merge(other: GCounterState): void {
    for (const [nodeId, count] of Object.entries(other.counts)) {
      this.counts[nodeId] = Math.max(this.counts[nodeId] ?? 0, count);
    }
  }

  /** Serialize to JSON-transportable state. */
  toState(): GCounterState {
    return { counts: { ...this.counts } };
  }

  /** Deserialize from state. */
  static fromState(state: GCounterState): GCounter {
    return new GCounter({ counts: { ...state.counts } });
  }
}

// ── PNCounter ───────────────────────────────────────────────

/**
 * Positive-Negative Counter (state-based).
 * Uses two GCounters: P (increments) and N (decrements).
 * Value = sum(P) - sum(N).
 */
export interface PNCounterState {
  p: Record<string, number>;
  n: Record<string, number>;
}

export class PNCounter {
  private inc: GCounter;
  private dec: GCounter;

  constructor(initial: PNCounterState = { p: {}, n: {} }) {
    this.inc = new GCounter({ counts: initial.p });
    this.dec = new GCounter({ counts: initial.n });
  }

  increment(nodeId: string, delta = 1): void {
    this.inc.increment(nodeId, delta);
  }

  decrement(nodeId: string, delta = 1): void {
    this.dec.increment(nodeId, delta);
  }

  value(): number {
    return this.inc.value() - this.dec.value();
  }

  merge(other: PNCounterState): void {
    this.inc.merge({ counts: other.p });
    this.dec.merge({ counts: other.n });
  }

  toState(): PNCounterState {
    return { p: this.inc.toState().counts, n: this.dec.toState().counts };
  }

  static fromState(state: PNCounterState): PNCounter {
    return new PNCounter({ p: { ...state.p }, n: { ...state.n } });
  }
}

// ── LWWRegister ─────────────────────────────────────────────

/**
 * Last-Writer-Wins Register.
 * Stores a value + HLC timestamp. Merge picks the one with the higher HLC.
 */
export interface LWWRegisterState {
  value: string;
  hlcWallTime: number;
  hlcLogical: number;
  nodeId: string;
}

export class LWWRegister {
  value: string;
  hlcWallTime: number;
  hlcLogical: number;
  nodeId: string;

  constructor(initial: LWWRegisterState) {
    this.value = initial.value;
    this.hlcWallTime = initial.hlcWallTime;
    this.hlcLogical = initial.hlcLogical;
    this.nodeId = initial.nodeId;
  }

  /** Assign a new value if the HLC is greater (or equal and nodeId is larger). */
  assign(value: string, hlc: IHLCTimestamp): void {
    const cmp = this.compareTo(hlc);
    if (cmp < 0) {
      this.value = value;
      this.hlcWallTime = Number(hlc.wallTime);
      this.hlcLogical = hlc.logical;
      this.nodeId = hlc.nodeId ?? this.nodeId;
    } else if (cmp === 0 && (hlc.nodeId ?? "") > this.nodeId) {
      // tiebreak by nodeId
      this.value = value;
      this.nodeId = hlc.nodeId ?? this.nodeId;
    }
  }

  /** Merge: keep the value with the higher HLC. */
  merge(other: LWWRegisterState): void {
    const cmp = this.compareToRaw(
      other.hlcWallTime,
      other.hlcLogical,
      other.nodeId,
    );
    if (cmp < 0) {
      this.value = other.value;
      this.hlcWallTime = other.hlcWallTime;
      this.hlcLogical = other.hlcLogical;
      this.nodeId = other.nodeId;
    } else if (cmp === 0 && other.nodeId > this.nodeId) {
      this.value = other.value;
      this.nodeId = other.nodeId;
    }
  }

  toState(): LWWRegisterState {
    return {
      value: this.value,
      hlcWallTime: this.hlcWallTime,
      hlcLogical: this.hlcLogical,
      nodeId: this.nodeId,
    };
  }

  static fromState(state: LWWRegisterState): LWWRegister {
    return new LWWRegister({ ...state });
  }

  private compareTo(hlc: IHLCTimestamp): number {
    const wallTime = Number(hlc.wallTime);
    if (this.hlcWallTime !== wallTime) {
      return this.hlcWallTime > wallTime ? 1 : -1;
    }
    if (this.hlcLogical !== hlc.logical) {
      return this.hlcLogical > hlc.logical ? 1 : -1;
    }
    return 0;
  }

  private compareToRaw(wallTime: number, logical: number, nodeId: string): number {
    if (this.hlcWallTime !== wallTime) {
      return this.hlcWallTime > wallTime ? 1 : -1;
    }
    if (this.hlcLogical !== logical) {
      return this.hlcLogical > logical ? 1 : -1;
    }
    return 0;
  }
}

// ── MVRegister ──────────────────────────────────────────────

/**
 * Multi-Value Register.
 * Keeps all concurrent (incomparable) values. Merge = set union of
 * values that are not superseded by any other.
 *
 * For deterministic read, applications can specify a resolver
 * (e.g. LWW, union, or app-specific merge).
 */
export interface MVRegisterState {
  /** Vector of (value, HLC wallTime, HLC logical, nodeId) tuples. */
  entries: Array<{
    value: string;
    wallTime: number;
    logical: number;
    nodeId: string;
  }>;
}

export class MVRegister {
  entries: Array<{
    value: string;
    wallTime: number;
    logical: number;
    nodeId: string;
  }>;

  constructor(initial: MVRegisterState = { entries: [] }) {
    this.entries = initial.entries.map((e) => ({ ...e }));
  }

  /** Assign a new value (replaces all concurrent values). */
  assign(value: string, hlc: IHLCTimestamp): void {
    this.entries = [
      {
        value,
        wallTime: Number(hlc.wallTime),
        logical: hlc.logical,
        nodeId: hlc.nodeId ?? "",
      },
    ];
  }

  /** Add a value to the set of concurrent values. */
  add(value: string, hlc: IHLCTimestamp): void {
    this.entries.push({
      value,
      wallTime: Number(hlc.wallTime),
      logical: hlc.logical,
      nodeId: hlc.nodeId ?? "",
    });
  }

  /** Get all concurrent values (after pruning obsolete entries). */
  values(): string[] {
    const pruned = this.pruneSuperseded();
    return pruned.map((e) => e.value);
  }

  /** Merge with another MVRegister. Keeps all non-superseded entries. */
  merge(other: MVRegisterState): void {
    for (const entry of other.entries) {
      // Only add if not already present
      const exists = this.entries.some(
        (e) =>
          e.value === entry.value &&
          e.wallTime === entry.wallTime &&
          e.logical === entry.logical &&
          e.nodeId === entry.nodeId,
      );
      if (!exists) {
        this.entries.push({ ...entry });
      }
    }
    this.entries = this.pruneSuperseded();
  }

  toState(): MVRegisterState {
    return { entries: this.entries.map((e) => ({ ...e })) };
  }

  static fromState(state: MVRegisterState): MVRegister {
    return new MVRegister({ entries: state.entries.map((e) => ({ ...e })) });
  }

  /**
   * Prune entries that are causally superseded by another entry.
   * An entry A supersedes B if A.wallTime > B.wallTime, or if equal
   * and A.logical > B.logical.
   */
  private pruneSuperseded(): Array<{
    value: string;
    wallTime: number;
    logical: number;
    nodeId: string;
  }> {
    const result: typeof this.entries = [];
    for (const entry of this.entries) {
      const superseded = this.entries.some(
        (other) =>
          other !== entry &&
          (other.wallTime > entry.wallTime ||
            (other.wallTime === entry.wallTime &&
              other.logical > entry.logical)),
      );
      if (!superseded) {
        // Also check uniqueness among result entries
        const duplicate = result.some(
          (e) =>
            e.value === entry.value &&
            e.wallTime === entry.wallTime &&
            e.logical === entry.logical &&
            e.nodeId === entry.nodeId,
        );
        if (!duplicate) {
          result.push(entry);
        }
      }
    }
    return result;
  }
}

// ── ORSet ───────────────────────────────────────────────────

/**
 * Observed-Remove Set.
 * Each element is tagged with a unique identifier per addition.
 * Remove = add all known tags to tombstone set.
 * Merge = union of elements and tombstones; prune tombstoned elements.
 */
export interface ORSetState {
  elements: Record<string, string[]>;
  tombstones: Record<string, string[]>;
}

export class ORSet {
  elements: Record<string, string[]>;
  tombstones: Record<string, string[]>;

  constructor(initial: ORSetState = { elements: {}, tombstones: {} }) {
    this.elements = { ...initial.elements };
    this.tombstones = { ...initial.tombstones };
  }

  /** Add an element with a unique tag. */
  add(element: string, tag: string): void {
    const existing = this.elements[element] ?? [];
    if (!existing.includes(tag)) {
      this.elements[element] = [...existing, tag];
    }
  }

  /** Remove an element: move all its tags to tombstones. */
  remove(element: string): void {
    const tags = this.elements[element];
    if (tags && tags.length > 0) {
      const tombTags = this.tombstones[element] ?? [];
      this.tombstones[element] = [...new Set([...tombTags, ...tags])];
      delete this.elements[element];
    }
  }

  /** Check if an element is in the set. */
  contains(element: string): boolean {
    const activeTags = this.elements[element] ?? [];
    const tombTags = this.tombstones[element] ?? [];
    return activeTags.some((t) => !tombTags.includes(t));
  }

  /** Get all elements currently in the set. */
  members(): string[] {
    return Object.entries(this.elements)
      .filter(([elem, tags]) => {
        const tombTags = this.tombstones[elem] ?? [];
        return tags.some((t) => !tombTags.includes(t));
      })
      .map(([elem]) => elem);
  }

  /** Merge with another ORSet. */
  merge(other: ORSetState): void {
    // Merge elements
    for (const [elem, tags] of Object.entries(other.elements)) {
      const existing = this.elements[elem] ?? [];
      this.elements[elem] = [...new Set([...existing, ...tags])];
    }
    // Merge tombstones
    for (const [elem, tags] of Object.entries(other.tombstones)) {
      const existing = this.tombstones[elem] ?? [];
      this.tombstones[elem] = [...new Set([...existing, ...tags])];
    }
    // Prune tombstoned elements
    this.pruneTombstoned();
  }

  toState(): ORSetState {
    return {
      elements: { ...this.elements },
      tombstones: { ...this.tombstones },
    };
  }

  static fromState(state: ORSetState): ORSet {
    return new ORSet({
      elements: { ...state.elements },
      tombstones: { ...state.tombstones },
    });
  }

  private pruneTombstoned(): void {
    for (const [elem, tags] of Object.entries(this.elements)) {
      const tombTags = this.tombstones[elem] ?? [];
      const active = tags.filter((t) => !tombTags.includes(t));
      if (active.length === 0) {
        delete this.elements[elem];
      } else {
        this.elements[elem] = active;
      }
    }
  }
}
