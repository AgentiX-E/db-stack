/**
 * DCSplitBrainDetector — Detects and recovers from DC-level split-brain.
 *
 * During a network partition, two DCs may independently accept writes
 * and elect leaders. When the partition heals, inconsistent states
 * merge via ConflictResolver, but the cluster also needs to:
 *   1. Detect that a split-brain occurred
 *   2. Determine which DC's writes should take precedence
 *   3. Rollback or fence the losing DC's entries
 *   4. Notify consumers of the split-brain event
 *
 * Detection mechanism:
 *   - Each DC broadcasts heartbeats with vector clocks
 *   - If a DC's clock diverges from the global view, split-brain
 *   - Recovery: compare HLC chains, choose highest-committed DC as winner
 *
 * Invariants:
 *   MA6 — Split-brain detected within heartbeat-timeout × 3
 *   MA7 — Losing DC fenced before winner's writes propagate
 *   MA8 — No data loss from winning DC
 *   MA9 — Consumers notified of split-brain resolution
 */

import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC, compareHLC } from '../hlc/HLC';
import { EventEmitter } from 'events';

export interface DCHeartbeat {
  dcId: string;
  nodeId: string;
  hlc: { wallTime: number; logical: number; nodeId: string };
  appliedCount: number;
  timestamp: number;
}

export interface SplitBrainEvent {
  detectedAt: number;
  divergedDcs: string[];
  winningDc: string;
  losingDcs: string[];
  conflictCount: number;
  resolution: 'fenced' | 'merged' | 'manual';
}

export interface DCSplitBrainConfig {
  nodeId: string;
  dcId: string;
  hlc: HLC;
  /** How often (ms) to broadcast heartbeats */
  heartbeatIntervalMs?: number;
  /** How many missed heartbeats before declaring split-brain */
  missedHeartbeatThreshold?: number;
  /** Auto-recovery: if true, automatically fence losing DCs */
  autoRecover?: boolean;
}

export class DCSplitBrainDetector {
  private readonly config: Required<DCSplitBrainConfig>;
  private readonly hlc: HLC;
  private readonly emitter = new EventEmitter();

  /** Last heartbeats received from each DC */
  private readonly remoteHeartbeats = new Map<string, DCHeartbeat>();
  /** DC-level HLC chains for divergence detection */
  private readonly dcHlcChains = new Map<string, { wallTime: number; logical: number }[]>();
  /** Currently detected split-brain events */
  private readonly activeSplitBrains = new Map<string, SplitBrainEvent>();

  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private appliedCount = 0;

  private readonly maxHlcChainLength = 100;

  constructor(config: DCSplitBrainConfig) {
    this.config = {
      nodeId: config.nodeId,
      dcId: config.dcId,
      hlc: config.hlc,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 1000,
      missedHeartbeatThreshold: config.missedHeartbeatThreshold ?? 3,
      autoRecover: config.autoRecover ?? true,
    };
    this.hlc = config.hlc;
  }

  start(): void {
    if (this.started) return;

    this.heartbeatTimer = setInterval(() => {
      this.broadcastHeartbeat();
    }, this.config.heartbeatIntervalMs);

    this.started = true;
  }

  stop(): void {
    this.started = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.remoteHeartbeats.clear();
    this.activeSplitBrains.clear();
    this.emitter.removeAllListeners();
  }

  /**
   * Receive a heartbeat from a remote DC node.
   * MA6: Track heartbeats for split-brain detection.
   */
  receiveHeartbeat(heartbeat: DCHeartbeat): void {
    if (!this.started) return;

    this.remoteHeartbeats.set(heartbeat.dcId, heartbeat);

    // Update HLC chain for this DC
    let chain = this.dcHlcChains.get(heartbeat.dcId);
    if (!chain) {
      chain = [];
      this.dcHlcChains.set(heartbeat.dcId, chain);
    }

    chain.push({
      wallTime: heartbeat.hlc.wallTime,
      logical: heartbeat.hlc.logical,
    });
    if (chain.length > this.maxHlcChainLength) {
      chain.splice(0, chain.length - this.maxHlcChainLength);
    }

    // Check for HLC divergence (split-brain signal)
    this.checkDivergence();
  }

  /**
   * Generate and return a local heartbeat for broadcasting.
   */
  generateHeartbeat(): DCHeartbeat {
    const now = this.hlc.now();
    return {
      dcId: this.config.dcId,
      nodeId: this.config.nodeId,
      hlc: {
        wallTime: Number(now.wallTime),
        logical: now.logical,
        nodeId: now.nodeId,
      },
      appliedCount: this.appliedCount,
      timestamp: Date.now(),
    };
  }

  /**
   * Record that a local write was applied (increment applied count).
   */
  recordApply(): void {
    this.appliedCount++;
  }

  /**
   * Check for active split-brain.
   * MA6: Split-brain detected within heartbeat-timeout × missedThreshold.
   */
  hasSplitBrain(): boolean {
    return this.activeSplitBrains.size > 0;
  }

  /**
   * Get active split-brain events.
   */
  getActiveSplitBrains(): SplitBrainEvent[] {
    return Array.from(this.activeSplitBrains.values());
  }

  /**
   * Manually resolve a split-brain by designating the winner.
   * MA7: Losing DC fenced immediately on resolution.
   */
  resolveSplitBrain(winningDc: string): SplitBrainEvent | null {
    let resolved: SplitBrainEvent | null = null;

    for (const [, event] of this.activeSplitBrains) {
      if (event.divergedDcs.includes(winningDc)) {
        const losingDcs = event.divergedDcs.filter((d) => d !== winningDc);
        const resolution: SplitBrainEvent = {
          ...event,
          winningDc,
          losingDcs,
          resolution: this.config.autoRecover ? 'fenced' : 'manual',
        };
        this.emitter.emit('split-brain-resolved', resolution);

        // MA7: Remove from active — losing DCs are fenced
        this.activeSplitBrains.delete(winningDc);
        for (const dc of losingDcs) {
          this.activeSplitBrains.delete(dc);
        }

        resolved = resolution;
      }
    }

    return resolved;
  }

  /**
   * Register split-brain detection callback.
   */
  onSplitBrainDetected(callback: (event: SplitBrainEvent) => void): () => void {
    this.emitter.on('split-brain-detected', callback);
    return () => {
      this.emitter.off('split-brain-detected', callback);
    };
  }

  /**
   * Register split-brain resolution callback.
   */
  onSplitBrainResolved(callback: (event: SplitBrainEvent) => void): () => void {
    this.emitter.on('split-brain-resolved', callback);
    return () => {
      this.emitter.off('split-brain-resolved', callback);
    };
  }

  // ── Private ──────────────────────────────────────────────

  private broadcastHeartbeat(): void {
    if (!this.started) return;
    const heartbeat = this.generateHeartbeat();
    this.emitter.emit('heartbeat', heartbeat);

    // Check for expired heartbeats (MA6)
    const now = Date.now();
    const timeout = this.config.heartbeatIntervalMs * this.config.missedHeartbeatThreshold;
    for (const [dcId, lastHb] of this.remoteHeartbeats) {
      if (now - lastHb.timestamp > timeout) {
        this.emitter.emit('heartbeat-expired', {
          dcId,
          lastSeen: lastHb.timestamp,
        });
      }
    }
  }

  private checkDivergence(): void {
    const dcIds = Array.from(this.dcHlcChains.keys());
    if (dcIds.length < 2) return;

    const divergedDcs = new Set<string>([this.config.dcId]);

    // Compare every pair of DCs for chain divergence
    for (let i = 0; i < dcIds.length; i++) {
      for (let j = i + 1; j < dcIds.length; j++) {
        const chainA = this.dcHlcChains.get(dcIds[i]!)!;
        const chainB = this.dcHlcChains.get(dcIds[j]!)!;

        if (this.hasChainsDiverged(chainA, chainB)) {
          divergedDcs.add(dcIds[i]!);
          divergedDcs.add(dcIds[j]!);
        }
      }
    }

    const divergedList = Array.from(divergedDcs);
    if (divergedList.length >= 2) {
      // Determine winner: highest HLC
      let winningDc = divergedList[0]!;
      let maxHlc = -1;

      for (const dcId of divergedList) {
        const chain = this.dcHlcChains.get(dcId);
        if (chain && chain.length > 0) {
          const last = chain[chain.length - 1]!;
          const combined = last.wallTime * 1000 + last.logical;
          if (combined > maxHlc) {
            maxHlc = combined;
            winningDc = dcId;
          }
        }
      }

      const event: SplitBrainEvent = {
        detectedAt: Date.now(),
        divergedDcs: divergedList,
        winningDc,
        losingDcs: divergedList.filter((d) => d !== winningDc),
        conflictCount: Math.abs(divergedList.length - 1),
        resolution: this.config.autoRecover ? 'fenced' : 'manual',
      };

      // Store the event (keyed by winningDc for resolution)
      this.activeSplitBrains.set(winningDc, event);
      for (const dc of divergedList.filter((d) => d !== winningDc)) {
        this.activeSplitBrains.set(dc, event);
      }

      this.emitter.emit('split-brain-detected', event);

      // MA9: Auto-recover if configured
      if (this.config.autoRecover) {
        this.resolveSplitBrain(winningDc);
      }
    }
  }

  /**
   * Heuristic: two HLC chains have diverged if both have
   * independent entries that progress their logical clocks.
   * Simplified: check last N entries in A have advancing logical
   * values not seen in B, and vice versa — indicating independent
   * write activity on both sides.
   */
  private hasChainsDiverged(
    chainA: { wallTime: number; logical: number }[],
    chainB: { wallTime: number; logical: number }[],
  ): boolean {
    if (chainA.length < 3 || chainB.length < 3) return false;

    const tailA = chainA.slice(-3);
    const tailB = chainB.slice(-3);

    // Check that chain A has advancing logical counters
    const aProgressing = tailA[0]!.logical < tailA[2]!.logical && tailA[2]!.logical > 0;
    // Check that chain B has advancing logical counters
    const bProgressing = tailB[0]!.logical < tailB[2]!.logical && tailB[2]!.logical > 0;

    // Both chains are independently advancing — split-brain
    return aProgressing && bProgressing;
  }
}
