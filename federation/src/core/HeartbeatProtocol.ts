/**
 * HeartbeatProtocol — the datacenter heartbeat as a frame on the wire.
 *
 * What changed, and why it matters
 * -------------------------------
 * The heartbeat used to be an `EventEmitter` emission. Subscribers inside the
 * process saw it, and no peer ever did — so the detector's expiry timer measured
 * a map that only a test ever filled, and a datacenter that stopped speaking was
 * indistinguishable from one that had never been configured.
 *
 * A heartbeat frame is subject to the three things a local emission is not: it
 * can be lost, delivered twice, or delivered late. Each is handled explicitly
 * here rather than left to the detector, because the detector's job is to measure
 * divergence and it can only do that on frames this class has already accepted as
 * *new*:
 *
 *   - **lost** → nothing arrives, the detector's expiry scan reports it once;
 *   - **duplicate** → `seq` is not greater than the last accepted one, counted
 *     and dropped, so three copies of one interval cannot look like three
 *     intervals;
 *   - **late** → same test, and the reason to drop it is stronger: the detector
 *     appends each heartbeat's HLC to a per-datacenter chain and decides
 *     divergence by whether both chains advance, so a late frame would insert a
 *     past clock into the present and manufacture exactly the pattern a split
 *     brain produces.
 *
 * The one thing this class does not own is the policy: `DCSplitBrainDetector`
 * decides what a silence means. This class only decides what a frame is.
 */

import { randomUUID } from 'crypto';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { HLC } from '../hlc/HLC';
import type { DCSplitBrainDetector } from './DCSplitBrainDetector';
import { HEARTBEAT_TYPE, buildHeartbeatFrame, decodeHeartbeat, toDetectorHeartbeat } from './heartbeatFrame';
import type { HeartbeatBody } from './heartbeatFrame';

// ── Config ──

export interface HeartbeatProtocolConfig {
  nodeId: string;
  dcId: string;
  /** Peers to send to. A peer absent from this list is never told this node is alive. */
  targets: string[];
  /**
   * Beat interval. Default 1 000 ms.
   *
   * Must match the detector's `heartbeatIntervalMs`: the detector multiplies its
   * own interval by the missed-heartbeat threshold to decide when a peer has gone
   * quiet, so two different numbers would make the expiry deadline describe a
   * schedule nobody is running.
   */
  intervalMs?: number;
}

/** What one peer last said, and when this node heard it. */
export interface HeartbeatPeerReport {
  seq: number;
  sentAt: number;
  appliedCount: number;
  /** When this node accepted the frame, in wall-clock ms. */
  at: number;
}

export interface HeartbeatProtocolStatus {
  sent: number;
  received: number;
  /** Frames at or below the last accepted sequence, or older by `sentAt`. */
  outOfOrder: number;
  /** Frames of this family that could not be read. */
  malformed: number;
  /** Silences reported by the detector since start. */
  expired: number;
  selfSeq: number;
  lastSentAt: number | null;
  lastReceivedAt: number | null;
  /** Per sending node, not per datacenter: two nodes of one DC share a DC id. */
  peers: Record<string, HeartbeatPeerReport>;
  lastError: string | null;
}

// ── Protocol ──

export class HeartbeatProtocol {
  private readonly config: Required<HeartbeatProtocolConfig>;
  private readonly peerState = new Map<string, HeartbeatPeerReport>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeExpired: (() => void) | null = null;
  private started = false;

  private seq = 0;
  private sent = 0;
  private received = 0;
  private outOfOrder = 0;
  private malformed = 0;
  private expired = 0;
  private lastSentAt: number | null = null;
  private lastReceivedAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly transport: ITransport,
    private readonly hlc: HLC,
    private readonly detector: DCSplitBrainDetector,
    config: HeartbeatProtocolConfig,
  ) {
    this.config = {
      nodeId: config.nodeId,
      dcId: config.dcId,
      targets: [...config.targets],
      intervalMs: config.intervalMs ?? 1_000,
    };
  }

  /**
   * Start beating.
   *
   * No beat is sent here: the first frame must not arrive at a moment the caller
   * cannot predict, and a suite that triggers a beat itself must not find a timer
   * already in flight. `beat()` is public for exactly that reason.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribeExpired = this.detector.onHeartbeatExpired(() => {
      this.expired += 1;
    });

    if (this.config.intervalMs > 0) {
      // `beat()` records its own failure and does not reject — including a
      // detector that cannot produce a heartbeat — so a `catch` here would be
      // unreachable.
      this.timer = setInterval(() => {
        void this.beat();
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
    this.unsubscribeExpired?.();
    this.unsubscribeExpired = null;
    this.peerState.clear();
  }

  /**
   * Send one heartbeat to every target.
   *
   * The sequence advances once per beat, not once per frame: the same interval
   * told to three peers is one observation, and three peers each receiving
   * sequence `n` is the only way "did I miss anything?" has one answer.
   */
  async beat(): Promise<number> {
    let delivered = 0;
    // Assigned inside the `try`, and the `catch` returns, so the only path that
    // reaches the `if` below is one where this has a value. Initialising it to `0`
    // would be a value no statement can read.
    let sentAt: number;

    try {
      const heartbeat = this.detector.generateHeartbeat();
      this.seq += 1;
      sentAt = Date.now();

      const body: HeartbeatBody = {
        dcId: heartbeat.dcId,
        nodeId: heartbeat.nodeId,
        seq: this.seq,
        sentAt,
        hlc: heartbeat.hlc,
        appliedCount: heartbeat.appliedCount,
      };

      // The sequence advances before the send, not after: a beat that fails on
      // every socket is still an interval this node lived through, and reusing
      // its number for the next one would make two intervals look like one.
      for (const target of this.config.targets) {
        const frame = buildHeartbeatFrame(randomUUID(), this.config.nodeId, target, body, this.hlc.now());
        try {
          if (await this.transport.send(frame)) delivered += 1;
          else this.lastError = `the transport refused a heartbeat for ${target}`;
        } catch (err: unknown) {
          this.lastError = describe(err);
        }
      }
    } catch (err: unknown) {
      // The detector could not produce a heartbeat. Recorded rather than thrown:
      // this runs on a timer, and a rejection here has no caller to receive it.
      this.lastError = describe(err);
      return delivered;
    }

    if (delivered > 0) {
      this.sent += delivered;
      this.lastSentAt = sentAt;
    }
    return delivered;
  }

  /** Consume a heartbeat frame. Returns false for a frame of another family. */
  handle(msg: InboundMessage): boolean {
    if (msg.type !== HEARTBEAT_TYPE) return false;

    const body = decodeHeartbeat(msg.payload);
    if (!body) {
      this.malformed += 1;
      this.lastError = `frame ${msg.messageId} is not a decodable heartbeat`;
      return true;
    }

    const previous = this.peerState.get(body.nodeId);

    if (previous && body.seq <= previous.seq) {
      // Duplicate or reordered, and the two are the same rejection for the same
      // reason: this frame describes an instant the detector has already seen.
      this.outOfOrder += 1;
      return true;
    }

    if (previous && body.sentAt < previous.sentAt) {
      // A higher sequence with an older timestamp. The sender's clock went
      // backwards between two beats — a stepped clock, or a restored backup.
      // Accepted, because refusing it would freeze the peer's liveness on the
      // last good beat, but recorded, because it is why the detector's HLC chain
      // is about to look strange.
      this.lastError = `heartbeat from ${body.nodeId} arrived out of order by sentAt (${body.sentAt} < ${previous.sentAt})`;
    }

    this.peerState.set(body.nodeId, {
      seq: body.seq,
      sentAt: body.sentAt,
      appliedCount: body.appliedCount,
      at: Date.now(),
    });
    this.received += 1;
    this.lastReceivedAt = Date.now();
    this.detector.receiveHeartbeat(toDetectorHeartbeat(body));
    return true;
  }

  getStatus(): HeartbeatProtocolStatus {
    return {
      sent: this.sent,
      received: this.received,
      outOfOrder: this.outOfOrder,
      malformed: this.malformed,
      expired: this.expired,
      selfSeq: this.seq,
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      peers: Object.fromEntries([...this.peerState].map(([nodeId, report]) => [nodeId, { ...report }])),
      lastError: this.lastError,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
