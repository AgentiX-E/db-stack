/**
 * ConflictResolver — Pluggable conflict resolution strategies.
 *
 * Strategies:
 *   - LWW (Last Writer Wins): Higher HLC wins; tiebreak by nodeId
 *   - CRDT Counter: PN-Counter merge (increment-only)
 *   - CRDT Set: Observed-Remove Set (OR-Set) merge
 *   - CRDT Map: Map of CRDT counters/sets
 *   - Custom: User-registered resolver per table/key
 *
 * AC 44.1 — LWW selects larger HLC timestamp
 * AC 44.2 — LWW tiebreak: equal HLC → larger nodeId wins
 * AC 44.3 — CRDT merge for counter/set/map
 * AC 44.4 — Custom resolver registration and dispatch
 */

import type { IHLCTimestamp } from "../interfaces/hlc/IHLCTimestamp";
import { compareHLC } from "../hlc/HLC";

export type ConflictStrategy = "lww" | "crdt-counter" | "crdt-set" | "crdt-map" | "custom";

export interface ConflictValue {
  key: string;
  value: string;
  hlc: IHLCTimestamp;
  nodeId: string;
}

export interface ConflictResult {
  resolvedValue: string;
  strategyUsed: ConflictStrategy;
  loserNodeIds: string[];
  merged: boolean;
}

export type ConflictPredicate = {
  tableName?: string;
  keyPrefix?: string;
};

/**
 * Custom resolver function signature.
 */
export type CustomResolver = (
  key: string,
  local: ConflictValue,
  remote: ConflictValue,
) => Promise<ConflictResult>;

// ── CRDT Types ──

export interface CRDTCounterState {
  /** Per-node increments: nodeId → count */
  p: Record<string, number>;
  /** Per-node decrements (unused in PN-Counter, but reserved) */
  n: Record<string, number>;
}

export interface CRDTSetState {
  /** Element → unique tag for OR-Set semantics */
  elements: Record<string, string[]>;
  /** Tombstoned (element, tag) pairs */
  tombstones: Record<string, string[]>;
}

export interface CRDTMapState {
  counters: Map<string, CRDTCounterState>;
  sets: Map<string, CRDTSetState>;
}

export class ConflictResolver {
  private readonly localNodeId: string;
  private readonly customResolvers = new Map<
    string, // table name or key prefix
    { resolver: CustomResolver; predicate: ConflictPredicate }
  >();

  constructor(localNodeId: string) {
    this.localNodeId = localNodeId;
  }

  /**
   * Register a custom resolver for a specific table or key prefix.
   * AC 44.4
   */
  registerCustomResolver(
    predicate: ConflictPredicate,
    resolver: CustomResolver,
  ): void {
    const key = predicate.tableName ?? predicate.keyPrefix ?? "__fallback__";
    this.customResolvers.set(key, { resolver, predicate });
  }

  /**
   * Unregister a custom resolver.
   */
  unregisterCustomResolver(predicate: ConflictPredicate): void {
    const key = predicate.tableName ?? predicate.keyPrefix ?? "__fallback__";
    this.customResolvers.delete(key);
  }

  /**
   * Resolve a conflict between local and remote values.
   *
   * AC 44.1 — LWW selects larger HLC timestamp
   * AC 44.2 — LWW tiebreak: equal HLC → larger nodeId wins
   * AC 44.4 — Custom resolver takes priority when registered
   */
  async resolve(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
    defaultStrategy: ConflictStrategy = "lww",
  ): Promise<ConflictResult> {
    // Check for custom resolver first (AC 44.4)
    const custom = this.findCustomResolver(key);
    if (custom) {
      const result = await custom(key, local, remote);
      return result;
    }

    switch (defaultStrategy) {
      case "lww":
        return this.resolveLWW(key, local, remote);
      case "crdt-counter":
        return this.resolveCRDTCounter(key, local, remote);
      case "crdt-set":
        return this.resolveCRDTSet(key, local, remote);
      case "crdt-map":
        return this.resolveCRDTMap(key, local, remote);
      default:
        return this.resolveLWW(key, local, remote);
    }
  }

  /**
   * LWW strategy: higher HLC wins. Tiebreak by nodeId.
   * AC 44.1, AC 44.2
   */
  private resolveLWW(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
  ): ConflictResult {
    const cmp = compareHLC(local.hlc, remote.hlc);

    if (cmp > 0) {
      // Local wins
      return {
        resolvedValue: local.value,
        strategyUsed: "lww",
        loserNodeIds: [remote.nodeId],
        merged: false,
      };
    }

    if (cmp < 0) {
      // Remote wins
      return {
        resolvedValue: remote.value,
        strategyUsed: "lww",
        loserNodeIds: [local.nodeId],
        merged: false,
      };
    }

    // Equal HLC → tiebreak by nodeId string comparison (AC 44.2)
    if (local.nodeId > remote.nodeId) {
      return {
        resolvedValue: local.value,
        strategyUsed: "lww",
        loserNodeIds: [remote.nodeId],
        merged: false,
      };
    }

    return {
      resolvedValue: remote.value,
      strategyUsed: "lww",
      loserNodeIds: [local.nodeId],
      merged: false,
    };
  }

  /**
   * CRDT Counter merge (PN-Counter semantics).
   * AC 44.3 — Concurrent increments → final counter = sum of all increments.
   *
   * For counter merge, we assume the value is a JSON-encoded CRDTCounterState.
   */
  private resolveCRDTCounter(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
  ): ConflictResult {
    let localState: CRDTCounterState;
    let remoteState: CRDTCounterState;

    try {
      localState = JSON.parse(local.value);
      remoteState = JSON.parse(remote.value);
    } catch {
      // Fallback to LWW if not valid CRDT state
      return this.resolveLWW(key, local, remote);
    }

    // Merge: max per-node P and N
    const mergedP = { ...localState.p };
    const mergedN = { ...localState.n };

    for (const [nodeId, count] of Object.entries(remoteState.p)) {
      mergedP[nodeId] = Math.max(mergedP[nodeId] ?? 0, count);
    }
    for (const [nodeId, count] of Object.entries(remoteState.n)) {
      mergedN[nodeId] = Math.max(mergedN[nodeId] ?? 0, count);
    }

    const resolvedValue = JSON.stringify({ p: mergedP, n: mergedN });

    const loserNodeIds: string[] = [];
    if (local.nodeId !== remote.nodeId) {
      loserNodeIds.push(local.nodeId, remote.nodeId);
    }

    return {
      resolvedValue,
      strategyUsed: "crdt-counter",
      loserNodeIds,
      merged: true,
    };
  }

  /**
   * CRDT Set merge (OR-Set semantics).
   * AC 44.3
   */
  private resolveCRDTSet(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
  ): ConflictResult {
    let localState: { elements: Record<string, string[]>; tombstones: Record<string, string[]> };
    let remoteState: { elements: Record<string, string[]>; tombstones: Record<string, string[]> };

    try {
      localState = JSON.parse(local.value);
      remoteState = JSON.parse(remote.value);
    } catch {
      return this.resolveLWW(key, local, remote);
    }

    // Merge elements and tombstones
    const mergedElements: Record<string, string[]> = { ...localState.elements };
    const mergedTombstones: Record<string, string[]> = { ...localState.tombstones };

    for (const [elem, tags] of Object.entries(remoteState.elements)) {
      const existing = mergedElements[elem] ?? [];
      mergedElements[elem] = [...new Set([...existing, ...tags])];
    }
    for (const [elem, tags] of Object.entries(remoteState.tombstones)) {
      const existing = mergedTombstones[elem] ?? [];
      mergedTombstones[elem] = [...new Set([...existing, ...tags])];
    }

    // Remove elements whose all tags are tombstoned
    for (const [elem, tags] of Object.entries(mergedTombstones)) {
      const activeTags = (mergedElements[elem] ?? []).filter(
        (t) => !tags.includes(t),
      );
      if (activeTags.length === 0) {
        delete mergedElements[elem];
      } else {
        mergedElements[elem] = activeTags;
      }
    }

    const resolvedValue = JSON.stringify({
      elements: mergedElements,
      tombstones: mergedTombstones,
    });

    return {
      resolvedValue,
      strategyUsed: "crdt-set",
      loserNodeIds: [local.nodeId, remote.nodeId],
      merged: true,
    };
  }

  /**
   * CRDT Map merge — merges sub-CRDTs (counters and sets) recursively.
   * AC 44.3
   */
  private resolveCRDTMap(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
  ): ConflictResult {
    let localState: { counters: Record<string, CRDTCounterState>; sets: Record<string, CRDTSetState> };
    let remoteState: { counters: Record<string, CRDTCounterState>; sets: Record<string, CRDTSetState> };

    try {
      localState = JSON.parse(local.value);
      remoteState = JSON.parse(remote.value);
    } catch {
      return this.resolveLWW(key, local, remote);
    }

    // Merge counters
    const mergedCounters: Record<string, CRDTCounterState> = { ...localState.counters };

    for (const [mapKey, remoteC] of Object.entries(remoteState.counters)) {
      const localC = mergedCounters[mapKey];
      if (!localC) {
        mergedCounters[mapKey] = remoteC;
        continue;
      }
      // Merge per-node P and N
      const mergedP = { ...localC.p };
      const mergedN = { ...localC.n };
      for (const [nodeId, count] of Object.entries(remoteC.p)) {
        mergedP[nodeId] = Math.max(mergedP[nodeId] ?? 0, count);
      }
      for (const [nodeId, count] of Object.entries(remoteC.n)) {
        mergedN[nodeId] = Math.max(mergedN[nodeId] ?? 0, count);
      }
      mergedCounters[mapKey] = { p: mergedP, n: mergedN };
    }

    // Merge sets
    const mergedSets: Record<string, CRDTSetState> = { ...localState.sets };
    for (const [mapKey, remoteS] of Object.entries(remoteState.sets)) {
      const localS = mergedSets[mapKey];
      if (!localS) {
        mergedSets[mapKey] = remoteS;
        continue;
      }
      // OR-Set merge within each sub-key (use Record<string, string[]> for JSON serialization)
      const mergedElements: Record<string, string[]> = { ...localS.elements };
      const mergedTombstones: Record<string, string[]> = { ...localS.tombstones };

      for (const [elem, tags] of Object.entries(remoteS.elements)) {
        const existing = mergedElements[elem] ?? [];
        mergedElements[elem] = [...new Set([...existing, ...tags])];
      }
      for (const [elem, tags] of Object.entries(remoteS.tombstones)) {
        const existing = mergedTombstones[elem] ?? [];
        mergedTombstones[elem] = [...new Set([...existing, ...tags])];
      }

      // Apply tombstone removal
      for (const [elem, tombTags] of Object.entries(mergedTombstones)) {
        const activeTags = (mergedElements[elem] ?? []).filter(
          (t) => !tombTags.includes(t),
        );
        if (activeTags.length === 0) {
          delete mergedElements[elem];
        } else {
          mergedElements[elem] = activeTags;
        }
      }

      mergedSets[mapKey] = {
        elements: mergedElements,
        tombstones: mergedTombstones,
      } as any;
    }

    const resolvedValue = JSON.stringify({
      counters: mergedCounters,
      sets: mergedSets,
    });

    return {
      resolvedValue,
      strategyUsed: "crdt-map",
      loserNodeIds: [local.nodeId, remote.nodeId],
      merged: true,
    };
  }

  /**
   * Find a custom resolver for the given key.
   *
   * A resolver registered with a bare predicate (no tableName nor keyPrefix)
   * is a fallback that matches any key. Otherwise the first resolver whose
   * tableName or keyPrefix is a prefix of `key` wins.
   */
  private findCustomResolver(key: string): CustomResolver | null {
    for (const [, entry] of this.customResolvers) {
      const { tableName, keyPrefix } = entry.predicate;
      // Bare predicate → unconditional fallback resolver (registered under
      // the synthesized "__fallback__" key).
      if (!tableName && !keyPrefix) {
        return entry.resolver;
      }
      if (tableName && key.startsWith(tableName)) {
        return entry.resolver;
      }
      if (keyPrefix && key.startsWith(keyPrefix)) {
        return entry.resolver;
      }
    }
    return null;
  }
}
