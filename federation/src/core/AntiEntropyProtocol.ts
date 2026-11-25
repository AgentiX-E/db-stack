/**
 * AntiEntropyProtocol — the reconciliation sweep, executed over the federation
 * transport.
 *
 * What the split buys
 * -------------------
 * `AntiEntropy` decides what two digests mean; this class decides how one node
 * asks another. Keeping the two apart is what makes the algorithm testable
 * without a socket and the socket testable without a dataset: a suite can hand
 * `AntiEntropy` an in-memory peer and check the diff, or start two of these over
 * real TLS and check that the roots converge.
 *
 * The three things that used to be missing
 * ----------------------------------------
 *   1. **A peer's root, actually fetched.** `syncWith(peerNodeId)` never sent
 *      anything, so a caller had no way to learn a peer disagreed short of
 *      reading the peer's disk. `exchange()` is a real round trip with a real
 *      timeout, and `getStatus().peers` reports the root each peer claimed.
 *   2. **A sweep that runs.** `AntiEntropy` was constructed in `start()` and its
 *      timer was never started, so the reconciliation that the whole component is
 *      named after happened only in tests. `start()` here owns the timer.
 *   3. **A wrong answer that is visible.** A digest that cannot be decoded is
 *      counted and named in `lastError` instead of being treated as agreement.
 *
 * Why pushes are not acknowledged
 * -------------------------------
 * A push is idempotent and a sweep repeats it. An acknowledgement would buy one
 * fewer frame per sweep and cost a second state machine — a pending map with its
 * own timeout, its own abort path and its own way of reporting a peer that is
 * slow rather than down. The divergence is its own receipt: if the push did not
 * land, the same bucket is still different on the next sweep.
 */

import { randomUUID } from 'crypto';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { DatasetDigest } from '../interfaces/replication/IAntiEntropy';
import type { HLC } from '../hlc/HLC';
import type { AntiEntropy, DataEntry, DigestExchange, MerklePeer } from '../replication/AntiEntropy';
import type { PushBody, SummaryBody } from '../replication/antientropyFrames';
import {
  AE_PUSH_TYPE,
  AE_SUMMARY_TYPE,
  buildPushFrame,
  buildSummaryReply,
  buildSummaryRequest,
  decodePush,
  decodeSummary,
} from '../replication/antientropyFrames';

// ── Config ──

export interface AntiEntropyProtocolConfig {
  /** This node's identifier on the transport. */
  nodeId: string;
  /** Peers to sweep. A peer absent from this list is never asked. */
  targets: string[];
  /** Shard name reported in every digest. Default `'default'`. */
  shardId?: string;
  /**
   * How often to sweep every target. Default 15 000 ms. `0` leaves the timer off
   * and the protocol manual-only — which is what a suite wants when it is about to
   * call `sweep()` itself and does not want a timer racing the assertion.
   */
  intervalMs?: number;
  /** How long one digest round trip is waited for. Default 5 000 ms. */
  exchangeTimeoutMs?: number;
  /** Entries per `ae_push` frame. Default 500. */
  maxEntriesPerFrame?: number;
}

/** What one peer last claimed about its dataset. */
export interface PeerRootReport {
  root: string;
  total: number;
  depth: number;
  /** When this claim was heard, in wall-clock ms. */
  at: number;
}

/** The protocol's observable state. */
export interface AntiEntropyProtocolStatus {
  sweeps: number;
  requestsSent: number;
  repliesSent: number;
  repliesReceived: number;
  pushesSent: number;
  pushesReceived: number;
  entriesApplied: number;
  entriesSkipped: number;
  conflicts: number;
  /** Digest round trips that expired without an answer. */
  timeouts: number;
  /** Frames that were this protocol's type but could not be read. */
  malformed: number;
  /** Answers that arrived after their wait had expired. */
  unsolicited: number;
  /** This node's own root at the last digest it built, or null before the first. */
  selfRoot: string | null;
  /** The most recent root each peer claimed. */
  peers: Record<string, PeerRootReport>;
  lastError: string | null;
}

interface PendingExchange {
  resolve: (answer: DigestExchange | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Protocol ──

export class AntiEntropyProtocol {
  private readonly config: Required<AntiEntropyProtocolConfig>;
  private readonly pending = new Map<string, PendingExchange>();
  private readonly peerRoots = new Map<string, PeerRootReport>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unbind: Array<() => void> = [];
  private started = false;
  private sweeping = false;

  private sweeps = 0;
  private requestsSent = 0;
  private repliesSent = 0;
  private repliesReceived = 0;
  private pushesSent = 0;
  private pushesReceived = 0;
  private entriesApplied = 0;
  private entriesSkipped = 0;
  private conflicts = 0;
  private timeouts = 0;
  private malformed = 0;
  private unsolicited = 0;
  private selfRoot: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly transport: ITransport,
    private readonly hlc: HLC,
    private readonly antiEntropy: AntiEntropy,
    config: AntiEntropyProtocolConfig,
  ) {
    this.config = {
      nodeId: config.nodeId,
      targets: [...config.targets],
      shardId: config.shardId ?? 'default',
      intervalMs: config.intervalMs ?? 15_000,
      exchangeTimeoutMs: config.exchangeTimeoutMs ?? 5_000,
      maxEntriesPerFrame: config.maxEntriesPerFrame ?? 500,
    };
  }

  /**
   * Bind every target and start the sweep timer.
   *
   * No sweep is run here. A `start()` that also sweeps makes the first frame
   * arrive at a moment the caller cannot predict, and a suite that then triggers a
   * sweep of its own is racing a timer it did not start — the same defect that
   * made an unrelated timer decide whether a listener saw a frame.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const target of this.config.targets) {
      this.unbind.push(this.antiEntropy.bindPeer(target, this.makePeer(target)));
    }

    if (this.config.intervalMs > 0) {
      // `sweep()` records its own failure and does not reject; a second `catch`
      // here would be a branch no input can reach, and a branch that cannot be
      // reached is a branch that cannot be tested.
      this.timer = setInterval(() => {
        void this.sweep();
      }, this.config.intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unbind of this.unbind) unbind();
    this.unbind = [];
    // Every outstanding round trip is abandoned rather than left to expire: a
    // stopped protocol has no `handle()` to answer it, and a promise resolved
    // five seconds after `stop()` resolved is a leak with a delay.
    for (const messageId of [...this.pending.keys()]) this.settle(messageId, null);
  }

  /** Run one sweep across every bound target. */
  async sweep(): Promise<void> {
    // One sweep at a time. Two overlapping sweeps would push the same buckets
    // twice and count the second as a divergence that does not exist.
    if (this.sweeping) return;
    this.sweeping = true;
    this.sweeps += 1;
    try {
      await this.antiEntropy.syncAll(this.config.shardId);
      const local = await this.antiEntropy.buildDigest(this.config.shardId);
      this.selfRoot = local.root;
    } catch (err: unknown) {
      this.lastError = describe(err);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Consume a frame, if it belongs to this protocol.
   *
   * Returns `false` for a frame of another family so the caller's routing stays a
   * list of owners rather than a chain of `if`s that each have to know about the
   * others.
   */
  async handle(msg: InboundMessage): Promise<boolean> {
    if (msg.type === AE_SUMMARY_TYPE) {
      const body = decodeSummary(msg.payload);
      if (!body) {
        this.malformed += 1;
        this.lastError = `frame ${msg.messageId} is not a decodable anti-entropy summary`;
        return true;
      }
      if (body.kind === 'request') await this.answerSummary(body, msg);
      else this.acceptReply(body, msg);
      return true;
    }

    if (msg.type === AE_PUSH_TYPE) {
      const body = decodePush(msg.payload);
      if (!body) {
        this.malformed += 1;
        this.lastError = `frame ${msg.messageId} is not a decodable anti-entropy push`;
        return true;
      }
      await this.acceptPush(body);
      return true;
    }

    return false;
  }

  getStatus(): AntiEntropyProtocolStatus {
    return {
      sweeps: this.sweeps,
      requestsSent: this.requestsSent,
      repliesSent: this.repliesSent,
      repliesReceived: this.repliesReceived,
      pushesSent: this.pushesSent,
      pushesReceived: this.pushesReceived,
      entriesApplied: this.entriesApplied,
      entriesSkipped: this.entriesSkipped,
      conflicts: this.conflicts,
      timeouts: this.timeouts,
      malformed: this.malformed,
      unsolicited: this.unsolicited,
      selfRoot: this.selfRoot,
      peers: Object.fromEntries([...this.peerRoots].map(([peerId, report]) => [peerId, { ...report }])),
      lastError: this.lastError,
    };
  }

  // ── Outbound ──

  /**
   * Reach one peer, as `AntiEntropy` needs it.
   *
   * `exchange` is a request and a bounded wait; `push` is a send. The split is the
   * protocol's own asymmetry, not an implementation detail: a digest that is never
   * answered leaves this node unable to decide anything, while a push that is
   * never acknowledged leaves it with a difference it will see again.
   */
  private makePeer(peerId: string): MerklePeer {
    return {
      exchange: (shardId, mine) => this.exchange(peerId, shardId, mine),
      push: (shardId, prefix, entries) => this.sendPush(peerId, shardId, prefix, entries),
    };
  }

  private exchange(peerId: string, shardId: string, mine: DatasetDigest): Promise<DigestExchange | null> {
    const messageId = randomUUID();

    return new Promise<DigestExchange | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        this.timeouts += 1;
        this.lastError = `no digest answer from ${peerId} within ${this.config.exchangeTimeoutMs}ms`;
        resolve(null);
      }, this.config.exchangeTimeoutMs);
      timer.unref?.();

      this.pending.set(messageId, { resolve, timer });

      const frame = buildSummaryRequest(
        messageId,
        this.config.nodeId,
        peerId,
        { kind: 'request', shardId, digest: mine },
        this.hlc.now(),
      );

      void this.transport
        .send(frame)
        .then((sent) => {
          if (sent) {
            this.requestsSent += 1;
            return;
          }
          // The transport refused the frame, so nothing will ever answer it.
          // Waiting out the timeout would report a slow peer where there is an
          // unreachable one.
          this.lastError = `the transport refused a digest request for ${peerId}`;
          this.settle(messageId, null);
        })
        .catch((err: unknown) => {
          this.lastError = describe(err);
          this.settle(messageId, null);
        });
    });
  }

  /** Hand one bucket to a peer, split across frames if it is large. */
  private async sendPush(peerId: string, shardId: string, prefix: string, entries: DataEntry[]): Promise<boolean> {
    const size = Math.max(1, this.config.maxEntriesPerFrame);

    for (let offset = 0; offset < entries.length; offset += size) {
      const slice = entries.slice(offset, offset + size);
      const frame = buildPushFrame(
        randomUUID(),
        this.config.nodeId,
        peerId,
        { shardId, prefix, entries: slice, more: offset + size < entries.length },
        this.hlc.now(),
      );
      const sent = await this.transport.send(frame);
      if (!sent) {
        this.lastError = `the transport refused a push of bucket ${prefix} for ${peerId}`;
        return false;
      }
      this.pushesSent += 1;
    }

    return true;
  }

  // ── Inbound ──

  /**
   * Answer a digest request: this node's digest, then the buckets the requester
   * cannot fill for itself.
   *
   * The order matters. The reply is sent first so the requester's wait ends before
   * this node starts pushing: a push that arrives while the requester is still
   * blocked on `exchange()` would be applied to a dataset whose digest was built
   * before it, and the requester would then push back buckets this node had
   * already given it.
   */
  private async answerSummary(body: Extract<SummaryBody, { kind: 'request' }>, msg: InboundMessage): Promise<void> {
    try {
      const mine = await this.antiEntropy.buildDigest(body.shardId);
      this.selfRoot = mine.root;
      this.recordPeer(msg.sourcePeerId, body.digest);

      const { push, want } = this.antiEntropy.diff(mine, body.digest);
      const reply = buildSummaryReply(
        msg,
        this.config.nodeId,
        { kind: 'reply', shardId: body.shardId, digest: mine, want },
        this.hlc.now(),
      );
      const sent = await this.transport.send(reply);
      if (sent) this.repliesSent += 1;
      else this.lastError = `the transport refused a digest reply for ${msg.sourcePeerId}`;

      for (const prefix of push) {
        // Sequential on purpose: a peer that cannot keep up gets backpressure
        // instead of an unbounded queue of frames it will apply one at a time.
        await this.sendPushTo(msg.sourcePeerId, body.shardId, prefix);
      }
    } catch (err: unknown) {
      this.lastError = describe(err);
    }
  }

  private acceptReply(body: Extract<SummaryBody, { kind: 'reply' }>, msg: InboundMessage): void {
    this.recordPeer(msg.sourcePeerId, body.digest);
    const waiter = this.pending.get(msg.messageId);
    if (!waiter) {
      // The answer to a request whose wait already expired, or an answer to a
      // request this node never sent. Counted rather than dropped: a rising count
      // against a stable outstanding count is a peer answering slower than the
      // budget, which an operator wants to see before it starts resending.
      this.unsolicited += 1;
      return;
    }
    this.repliesReceived += 1;
    this.settle(msg.messageId, { digest: body.digest, want: body.want });
  }

  private async acceptPush(body: PushBody): Promise<void> {
    try {
      const outcome = await this.antiEntropy.applyRemote(body.entries);
      this.pushesReceived += 1;
      this.entriesApplied += outcome.applied;
      this.entriesSkipped += outcome.skipped;
      this.conflicts += outcome.conflicts;
    } catch (err: unknown) {
      this.lastError = describe(err);
    }
  }

  private async sendPushTo(peerId: string, shardId: string, prefix: string): Promise<void> {
    const entries = await this.antiEntropy.entriesInBucket(prefix);
    if (entries.length === 0) {
      // The bucket changed between the digest and this read. Not an error: the
      // next sweep compares again, and an empty push would tell the peer nothing.
      return;
    }
    await this.sendPush(peerId, shardId, prefix, entries);
  }

  // ── Bookkeeping ──

  private recordPeer(peerId: string, digest: DatasetDigest): void {
    this.peerRoots.set(peerId, { root: digest.root, total: digest.total, depth: digest.depth, at: Date.now() });
  }

  private settle(messageId: string, answer: DigestExchange | null): void {
    const waiter = this.pending.get(messageId);
    if (!waiter) return;
    this.pending.delete(messageId);
    clearTimeout(waiter.timer);
    waiter.resolve(answer);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
