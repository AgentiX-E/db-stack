/**
 * MultiLeaderReplication — Cross-DC write replication with Outbox pattern.
 *
 * This is the core federation engine. It:
 *   1. Accepts replicate() calls from the database engine
 *   2. Writes to the OutboxStore (crash-safe, WAL-anchored)
 *   3. Asynchronously forwards entries to replication targets
 *   4. Retries with topology-aware backoff on failure
 *   5. Tracks per-target pending counts, lag, and health
 *
 * The per-target worker loop (OutboxWorker) operates on a configurable tickMs:
 *   - Each tick: fetch oldest pending entries for this target, send via transport
 *   - On success: markDelivered
 *   - On failure: markFailed (handles retry/DDL)
 *
 * Backoff strategy (matches graphvec-db topology):
 *   - intra-DC: 3s between retries
 *   - cross-DC: 60s between retries
 *   - edge: 300s between retries
 */

import type {
  IMultiLeaderReplication,
  ReplicationConfig,
  ReplicationStatus,
} from '../interfaces/replication/IMultiLeaderReplication';
import type { TopologyType } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { OutboxStats } from '../interfaces/types';
import type { RetentionWindows } from '../storage/retention';
import { HLC } from '../hlc/HLC';
import { AckTracker } from './AckTracker';
import type { CdcAckVerdict } from './cdcAck';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export interface MultiLeaderReplicationOptions {
  transport: ITransport;
  outbox: IOutboxStore;
  config: ReplicationConfig;
  /** Test seam: inject custom HLC for deterministic testing */
  hlc?: HLC;
}

/** Per-target worker state */
interface TargetWorker {
  nodeId: string;
  backoffMs: number;
  tickMs: number;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  running: boolean;
  stopRequested: boolean;
  tickTimer: ReturnType<typeof setTimeout> | null;
}

export class MultiLeaderReplication implements IMultiLeaderReplication {
  private readonly transport: ITransport;
  private readonly outbox: IOutboxStore;
  private readonly config: ReplicationConfig;
  private readonly hlc: HLC;
  private readonly emitter = new EventEmitter();

  private started = false;
  private readonly workers = new Map<string, TargetWorker>();

  /**
   * The wait for each frame's confirmation.
   *
   * The same class `ExactlyOnceCDCPipeline` uses, because "wait, but not for ever,
   * and answer `aborted` when *we* stopped" is one behaviour with one
   * implementation. What differs is only what a verdict does here: retire the
   * entry, or charge it an attempt.
   */
  private readonly acks: AckTracker;

  /** True when an entry is retired on the peer's confirmation. */
  private readonly acked: boolean;

  /** The transport subscription that carries confirmations back. */
  private detachAcks: (() => void) | null = null;

  constructor(options: MultiLeaderReplicationOptions) {
    this.transport = options.transport;
    this.outbox = options.outbox;
    this.config = options.config;
    this.hlc = options.hlc ?? new HLC(options.config.nodeId);
    this.acked = (options.config.acknowledgement ?? 'peer') === 'peer';
    this.acks = new AckTracker({ timeoutMs: options.config.ackTimeoutMs ?? 5_000 });
  }

  /**
   * What the waiting side has seen: `received`, `timeouts`, `pending` and
   * `unsolicited`.
   *
   * Reported for the same reason the retention windows are: a sender that is
   * waiting for answers needs to distinguish a slow peer from a peer that never
   * answers, and a counter is the only thing that can.
   */
  getAckStats(): { received: number; timeouts: number; pending: number; unsolicited: number } {
    return {
      received: this.acks.received,
      timeouts: this.acks.timeouts,
      pending: this.acks.pending,
      unsolicited: this.acks.unsolicited,
    };
  }

  /**
   * The windows of the outbox this replication sends from.
   *
   * Delegated rather than duplicated: the budget is a property of the store, and
   * a second statement of it here is a number that can disagree with the one
   * `markFailed` obeys.
   */
  getRetention(): RetentionWindows {
    return this.outbox.getRetention();
  }

  async start(_config?: ReplicationConfig): Promise<void> {
    if (this.started) return;
    const cfg = _config ?? this.config;

    // Subscribed before the first frame leaves: an in-process transport delivers
    // the peer's answer inside the same tick, and an ack that arrives before
    // there is anything to match it against is a lost ack — the entry would then
    // wait out the full budget and be charged an attempt after the peer applied it.
    if (this.acked) {
      this.detachAcks = this.transport.onMessage((message) => {
        this.acks.handle(message);
      });
    }

    // Start one worker per target
    for (const target of cfg.targets) {
      this.startWorker(target.nodeId, target.topology, target.maxBackoffSeconds * 1000);
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;

    // Signal all workers to stop
    for (const worker of this.workers.values()) {
      worker.stopRequested = true;
      if (worker.tickTimer) {
        clearTimeout(worker.tickTimer);
        worker.tickTimer = null;
      }
    }

    this.workers.clear();
    // Waiting is not failing: a worker blocked on an answer is released `aborted`,
    // so a shutdown does not spend a retry on a decision the peer never made.
    this.acks.release('replication stopped before the peer acknowledged');
    this.detachAcks?.();
    this.detachAcks = null;
    this.emitter.removeAllListeners('target-connected');
    this.emitter.removeAllListeners('target-disconnected');
    this.emitter.removeAllListeners('target-recovered');
    this.emitter.removeAllListeners('high-lag');
  }

  /**
   * Replicate data to all targets.
   * Writes to OutboxStore (crash-safe) and returns immediately.
   * The outbox workers handle async delivery in the background.
   */
  async replicate(shardId: number, data: string, type?: string): Promise<{ msgId: string }> {
    const msgId = `repl:${shardId}:${randomUUID()}`;
    const timestamp = this.hlc.now();

    // Persist to outbox (crash-safe, AC 40.1)
    await this.outbox.add({
      targetPeerIds: this.config.targets.map((t) => t.nodeId),
      payload: new TextEncoder().encode(data),
      timestamp: {
        wallTime: timestamp.wallTime,
        logical: timestamp.logical,
        nodeId: timestamp.nodeId,
        compare: timestamp.compare.bind(timestamp),
        serialize: timestamp.serialize.bind(timestamp),
        deserialize: timestamp.deserialize.bind(timestamp),
      },
      type: type ?? 'replicate',
    });

    return { msgId };
  }

  /**
   * Get replication status for all targets.
   */
  async getStatus(): Promise<ReplicationStatus> {
    // Lag is read from the queue, not from the clock. `now - lastSuccessAt`
    // grows on a channel that has nothing to send, so a target that delivered
    // one write and then sat idle reported itself critical; and when every
    // entry had been dead-lettered the queue was empty while the clock kept
    // counting. The age of the oldest owed entry answers the operator's actual
    // question — "how far behind is this target?" — and is 0 when it is not.
    const backlog = this.outbox.getPendingStats();
    const now = Date.now();

    const targets = Array.from(this.workers.entries()).map(([targetNodeId, worker]) => {
      const owed = backlog[targetNodeId];
      const oldest = owed?.oldestCreatedAt ?? null;

      return {
        targetNodeId,
        connected: worker.running,
        lagMs: oldest === null ? 0 : Math.max(0, now - oldest),
        pendingCount: owed?.count ?? 0,
        lastSuccessAt: worker.lastSuccessAt,
        lastErrorAt: worker.lastErrorAt,
        lastErrorMessage: worker.lastErrorMessage,
      };
    });

    return {
      nodeId: this.config.nodeId,
      dc: this.config.dc,
      targets,
    };
  }

  /**
   * Revive the dead letters owed to a target and try them again.
   *
   * Returns how many entries came back. It used to return `0` for every input
   * while resetting a counter and scheduling a tick — a function whose name
   * promised the dead letter queue and whose body touched a failure counter.
   * The queue was reachable only through `OutboxStore.retryDeadLetter(id)`,
   * which nothing in the package called.
   */
  async retryFailed(targetNodeId: string): Promise<number> {
    const target = this.config.targets.find((t) => t.nodeId === targetNodeId);
    if (!target) return 0;

    const revived = this.outbox.retryDeadLetters(targetNodeId);

    const worker = this.workers.get(targetNodeId);
    if (worker) {
      // The failure counter is deliberately *not* reset here. It is the
      // evidence that this target had been failing, and a revive that erased it
      // would make the next successful delivery indistinguishable from an
      // ordinary one — so the recovery would go unannounced.
      if (worker.tickTimer) clearTimeout(worker.tickTimer);
      this.scheduleTick(worker, 0);
    }

    return revived;
  }

  /**
   * Get pending count per target by scanning the outbox.
   */
  async getPendingCounts(): Promise<Record<string, number>> {
    const backlog = this.outbox.getPendingStats();
    const counts: Record<string, number> = {};

    for (const target of this.config.targets) {
      counts[target.nodeId] = 0;
    }

    for (const [peerId, stats] of Object.entries(backlog)) {
      counts[peerId] = stats.count;
    }

    return counts;
  }

  /**
   * Whether the transport currently holds a link to a target.
   *
   * This is the only recovery evidence available once every entry owed to a
   * target has been dead-lettered: the queue is empty, so nothing is attempted,
   * so no attempt can succeed, so the success branch that used to be the only
   * source of a recovery signal never runs. A connected socket is a fact about
   * the link rather than about the queue, and it is what "the peer is back"
   * means.
   */
  isPeerReachable(targetNodeId: string): boolean {
    return this.transport.getConnectedPeers().some((peer) => peer.peerId === targetNodeId);
  }

  /**
   * Event: fires when a target connects.
   */
  onTargetConnected(callback: (targetNodeId: string) => void): () => void {
    this.emitter.on('target-connected', callback);
    return () => {
      this.emitter.off('target-connected', callback);
    };
  }

  /**
   * Event: fires when a target disconnects.
   */
  onTargetDisconnected(callback: (targetNodeId: string) => void): () => void {
    this.emitter.on('target-disconnected', callback);
    return () => {
      this.emitter.off('target-disconnected', callback);
    };
  }

  /**
   * Event: fires when replication lag exceeds threshold.
   */
  /**
   * Register a callback for when a target that had been failing delivers again.
   */
  onTargetRecovered(callback: (targetNodeId: string) => void): () => void {
    this.emitter.on('target-recovered', callback);
    return () => {
      this.emitter.off('target-recovered', callback);
    };
  }

  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void {
    this.emitter.on('high-lag', callback);
    return () => {
      this.emitter.off('high-lag', callback);
    };
  }

  // ── OutboxWorker (per-target background loop) ──

  private startWorker(nodeId: string, topology: TopologyType, backoffMs: number): void {
    const tickMs = this.config.tickMs ?? 100; // default 100ms batch window
    const worker: TargetWorker = {
      nodeId,
      backoffMs,
      tickMs,
      lastAttemptAt: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      running: true,
      stopRequested: false,
      tickTimer: null,
    };

    this.workers.set(nodeId, worker);
    this.emitter.emit('target-connected', nodeId);

    // Start the tick loop
    this.scheduleTick(worker, 0);
  }

  private scheduleTick(worker: TargetWorker, delayMs: number = worker.tickMs): void {
    if (worker.stopRequested) return;

    // Cap delay between ticks
    const cappedDelay = Math.min(delayMs, 5000); // never more than 5s

    worker.tickTimer = setTimeout(() => {
      if (worker.stopRequested) return;
      this.doTick(worker);
    }, cappedDelay);
  }

  private async doTick(worker: TargetWorker): Promise<void> {
    if (worker.stopRequested) return;

    try {
      // Fetch oldest pending for this target
      const batchSize = this.config.batchSize ?? 1000;
      const pending = await this.outbox.fetchOldestPending(batchSize);

      // Filter to entries targeting this worker's node
      const forTarget = pending.filter((e) => e.targetPeerIds.includes(worker.nodeId) && e.status === 'pending');

      if (forTarget.length === 0) {
        // Nothing is owed. This is also the only place the dead-letter corner
        // can be observed: if every entry was written off, the success branch
        // below never runs, so recovery must be read from the link instead.
        if (worker.consecutiveFailures > 0 && this.isPeerReachable(worker.nodeId)) {
          worker.consecutiveFailures = 0;
          worker.lastErrorMessage = null;
          this.emitter.emit('target-recovered', worker.nodeId);
        }
        this.scheduleTick(worker, worker.tickMs);
        return;
      }

      let allSucceeded = true;
      let deliveredCount = 0;

      // Phase one: put the frames on the wire, registering each wait *before* the
      // send. Phase two reads the answers. The two are separate because a batch is
      // in flight at once: awaiting each answer inside the send loop would make a
      // batch of a hundred cost a hundred round-trips end to end.
      const inFlight: Array<{ entryId: string; verdict: Promise<CdcAckVerdict> }> = [];

      for (const entry of forTarget) {
        if (worker.stopRequested) return;

        const msg: TransportMessage = {
          messageId: entry.id,
          sourcePeerId: this.config.nodeId,
          targetPeerId: worker.nodeId,
          payload: entry.payload,
          timestamp: entry.timestamp,
          createdAt: entry.createdAt,
          type: entry.type,
        };

        const verdict = this.acked ? this.acks.expect(msg.messageId) : null;

        try {
          const sent = await this.transport.send(msg);
          if (!sent) throw new Error(`Transport rejected message to ${worker.nodeId}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (verdict !== null) {
            this.acks.abandon(msg.messageId, errMsg);
            // The head of the queue could not leave, so nothing behind it may be
            // retired: the outbox is an ordered log, and a hole in it is a change
            // no peer will ever be offered again.
            this.outbox.markFailed(entry.id, errMsg);
            allSucceeded = false;
            break;
          }
          this.outbox.markFailed(entry.id, errMsg);
          allSucceeded = false;
          continue;
        }

        if (verdict === null) {
          await this.outbox.markDelivered(entry.id);
          deliveredCount++;
        } else {
          inFlight.push({ entryId: entry.id, verdict });
        }
      }

      if (inFlight.length > 0) {
        const answered = await Promise.all(
          inFlight.map(async (item) => ({ entryId: item.entryId, verdict: await item.verdict })),
        );

        for (const [index, { entryId, verdict }] of answered.entries()) {
          if (verdict.ok) {
            await this.outbox.markDelivered(entryId);
            deliveredCount++;
            continue;
          }

          // Our own shutdown, not the peer's decision: leave everything pending.
          if (verdict.aborted) return;

          this.outbox.markFailed(entryId, verdict.error ?? 'the peer did not confirm the change');
          allSucceeded = false;

          // Everything behind a refused entry was already sent, and those changes
          // were very likely applied — the receiver deduplicates the repeat and
          // answers it — but retiring them here would let the queue move past an
          // entry that is still owed. A duplicate is recoverable; a gap is not.
          for (const rest of answered.slice(index + 1)) {
            this.acks.abandon(rest.entryId, `an earlier entry in the batch was refused (${entryId})`);
          }
          break;
        }
      }

      if (allSucceeded && deliveredCount > 0) {
        const wasFailing = worker.consecutiveFailures > 0;
        worker.lastSuccessAt = Date.now();
        worker.consecutiveFailures = 0;
        worker.lastErrorMessage = null;
        if (wasFailing) this.emitter.emit('target-recovered', worker.nodeId);
        this.scheduleTick(worker, worker.tickMs);
      } else {
        // Some failures — apply backoff
        worker.lastErrorAt = Date.now();
        worker.lastErrorMessage = `Delivery failed at ${new Date().toISOString()}`;
        worker.consecutiveFailures++;

        // Apply exponential backoff from topology config
        const backoff = Math.min(
          worker.backoffMs * Math.pow(2, Math.min(worker.consecutiveFailures - 1, 5)),
          300_000, // max 5min
        );

        this.scheduleTick(worker, backoff);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      worker.lastErrorAt = Date.now();
      worker.lastErrorMessage = `Worker error: ${errMsg}`;
      worker.consecutiveFailures++;

      const backoff = Math.min(worker.backoffMs * Math.pow(2, Math.min(worker.consecutiveFailures - 1, 5)), 300_000);
      this.scheduleTick(worker, backoff);
    }
  }
}
