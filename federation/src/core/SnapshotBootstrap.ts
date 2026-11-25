/**
 * SnapshotBootstrap — the two-sided state machine that brings a lagging
 * datacenter up to a peer's state.
 *
 * Both roles live in one class because both datacenters need both. A DC does not
 * choose to be the source or the receiver: whichever one restarts, or whichever
 * one is newly added, is the receiver for that transfer, and the other is the
 * source — possibly at the same time, for its own peer.
 *
 * What makes it resumable
 * -----------------------
 * The receiver persists `{ transferId, nextChunk }` after every chunk it accepts,
 * and its next `bootstrap_request` carries that index. A process that died in the
 * middle of a ten-thousand-chunk snapshot therefore resumes at chunk 4 113 rather
 * than at zero — and, more importantly, a *sender* that died can be resumed
 * against, because the request names the point, not the receiver's memory.
 *
 * What makes it idempotent
 * ------------------------
 * Applying a chunk twice writes the same values, and the receiver tracks which
 * indices it has applied so the second application is skipped rather than
 * repeated. The handoff is guarded by the high-water mark instead: a change at or
 * below it is one the snapshot already contains, so replaying it would be
 * re-applying history rather than catching up.
 */

import { randomUUID } from 'crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { HLC } from '../hlc/HLC';
import type { AntiEntropy, DataEntry } from '../replication/AntiEntropy';
import {
  BOOTSTRAP_CHUNK_TYPE,
  BOOTSTRAP_DONE_TYPE,
  BOOTSTRAP_REQUEST_TYPE,
  HANDOFF_END_TYPE,
  HANDOFF_TYPE,
  buildBootstrapChunk,
  buildBootstrapDone,
  buildBootstrapRequest,
  buildHandoffEnd,
  buildHandoffEntry,
  decodeBootstrapFrame,
  isBootstrapFrame,
} from '../replication/bootstrapFrames';
import type {
  BootstrapChunkBody,
  BootstrapDoneBody,
  BootstrapRequestBody,
  HandoffEndBody,
  HandoffEntryBody,
} from '../replication/bootstrapFrames';

// ── The log a bootstrap hands off from ──

/**
 * The ordered changes a bootstrapping peer still needs.
 *
 * Injected rather than implemented here, because the answer belongs to whatever
 * owns durability: a Raft log in `db-cluster`, an outbox, or a database's own WAL.
 * This package's job is the protocol, and a protocol that assumed one storage
 * shape would stop being usable by the other two.
 */
export interface BootstrapSource {
  /** The highest position this side has applied. */
  currentLsn(): Promise<number>;
  /** Changes strictly after `lsn`, in log order, at most `limit` of them. */
  entriesAfter(lsn: number, limit: number): Promise<Array<{ lsn: number; entry: DataEntry }>>;
}

// ── Config ──

export interface SnapshotBootstrapConfig {
  nodeId: string;
  /** Shard name carried in every frame. Default `'default'`. */
  shardId?: string;
  /** Entries per snapshot chunk. Default 200. */
  chunkSize?: number;
  /** Changes per handoff read. Default 200. */
  handoffBatchSize?: number;
  /**
   * Where to remember an unfinished inbound transfer.
   *
   * Absent means a restart begins again at chunk zero — correct, just slower, and
   * the idempotent chunk application makes it safe either way.
   */
  resumeStatePath?: string;
}

// ── State ──

interface InboundTransfer {
  transferId: string;
  peerId: string;
  shardId: string;
  expected: number;
  totalChunks: number | null;
  snapshotLsn: number;
  highWaterMark: number;
  applied: Set<number>;
  entriesApplied: number;
  phase: 'snapshot' | 'handoff' | 'done';
  startedAt: number;
  updatedAt: number;
}

interface OutboundTransfer {
  transferId: string;
  peerId: string;
  shardId: string;
  chunksSent: number;
  entriesSent: number;
  snapshotLsn: number | null;
  handoffEntries: number;
  startedAt: number;
}

/** What one finished transfer did, kept so a test or a status page can see it. */
export interface TransferReport {
  transferId: string;
  peerId: string;
  shardId: string;
  role: 'receiver';
  chunks: number;
  entriesApplied: number;
  handoffApplied: number;
  highWaterMark: number;
  startedAt: number;
  completedAt: number;
}

export interface SnapshotBootstrapStatus {
  transfers: {
    inbound: Array<Omit<InboundTransfer, 'applied'> & { applied: number }>;
    outbound: OutboundTransfer[];
  };
  chunksSent: number;
  chunksReceived: number;
  duplicateChunks: number;
  /** Requests sent because a chunk arrived out of order. */
  gapRequests: number;
  malformed: number;
  /** Frames for a transfer this node has no record of. */
  unknownTransfers: number;
  entriesApplied: number;
  entriesSkipped: number;
  handoffApplied: number;
  handoffSkipped: number;
  requestsSent: number;
  completed: TransferReport[];
  lastError: string | null;
}

// ── Bootstrap ──

export class SnapshotBootstrap {
  private readonly config: Required<Omit<SnapshotBootstrapConfig, 'resumeStatePath'>> & {
    resumeStatePath: string | null;
  };
  private readonly inbound = new Map<string, InboundTransfer>();
  private readonly outbound = new Map<string, OutboundTransfer>();
  private readonly completed: TransferReport[] = [];

  /**
   * One promise chain per transfer.
   *
   * Frames for a transfer arrive as fast as the sender can write them, and every
   * handler below awaits a store, so two chunks of the same transfer would
   * otherwise interleave: both read the same `expected`, the second finds itself
   * out of order and asks for a re-send, and the re-send arrives while the first is
   * still applying. The measured shape was five gaps and twelve chunk frames for a
   * three-chunk transfer — a protocol that converges by accident and reports
   * success while doing four times the work.
   *
   * Serialising per transfer, rather than globally, keeps the property without
   * making two unrelated datacenters wait for each other.
   */
  private readonly serial = new Map<string, Promise<void>>();

  private chunksSent = 0;
  private chunksReceived = 0;
  private duplicateChunks = 0;
  private gapRequests = 0;
  private malformed = 0;
  private unknownTransfers = 0;
  private entriesApplied = 0;
  private entriesSkipped = 0;
  private handoffApplied = 0;
  private handoffSkipped = 0;
  private requestsSent = 0;
  private lastError: string | null = null;

  constructor(
    private readonly transport: ITransport,
    private readonly hlc: HLC,
    private readonly antiEntropy: AntiEntropy,
    private readonly source: BootstrapSource,
    config: SnapshotBootstrapConfig,
  ) {
    this.config = {
      nodeId: config.nodeId,
      shardId: config.shardId ?? 'default',
      chunkSize: config.chunkSize ?? 200,
      handoffBatchSize: config.handoffBatchSize ?? 200,
      resumeStatePath: config.resumeStatePath ?? null,
    };
  }

  /**
   * Ask a peer to bring this datacenter up to date.
   *
   * Returns the transfer id. When a previous transfer to the same peer was
   * interrupted, the same id is reused and the request names the chunk it stopped
   * at, so the sender continues rather than restarts.
   */
  async begin(peerId: string): Promise<string> {
    const resumed = this.readResume(peerId);
    const transferId = resumed?.transferId ?? randomUUID();
    const nextChunk = resumed?.nextChunk ?? 0;
    const shardId = this.config.shardId;
    const fromLsn = await this.source.currentLsn();
    const now = Date.now();

    this.inbound.set(transferId, {
      transferId,
      peerId,
      shardId,
      expected: nextChunk,
      totalChunks: null,
      snapshotLsn: fromLsn,
      highWaterMark: fromLsn,
      // The chunks before the resume point are, by definition of the persisted
      // cursor, already applied. Re-applying them would be harmless and wasteful;
      // marking them applied is what makes a duplicate delivery of one of them a
      // duplicate rather than a gap.
      applied: new Set(Array.from({ length: nextChunk }, (_, index) => index)),
      entriesApplied: 0,
      phase: 'snapshot',
      startedAt: now,
      updatedAt: now,
    });

    await this.sendRequest(peerId, transferId, nextChunk, fromLsn);
    return transferId;
  }

  /** Consume a bootstrap frame. Returns false for a frame of another family. */
  async handle(msg: InboundMessage): Promise<boolean> {
    if (!isBootstrapFrame(msg.type)) return false;

    const decoded = decodeBootstrapFrame(msg.type ?? '', msg.payload);
    if (!decoded) {
      this.malformed += 1;
      this.lastError = `frame ${msg.messageId} is not a decodable ${String(msg.type)} frame`;
      return true;
    }

    // Queued, not awaited: every task records its own failure, so a `try` here
    // could only catch an exception from `enqueue` itself — a branch no input
    // reaches, and one that would look like error handling without being any.
    switch (decoded.type) {
      case BOOTSTRAP_REQUEST_TYPE:
        this.enqueue(decoded.body.transferId, () => this.serveSnapshot(decoded.body, msg));
        break;
      case BOOTSTRAP_CHUNK_TYPE:
        this.enqueue(decoded.body.transferId, () => this.acceptChunk(decoded.body, msg));
        break;
      case BOOTSTRAP_DONE_TYPE:
        this.enqueue(decoded.body.transferId, () => this.serveHandoff(decoded.body, msg));
        break;
      case HANDOFF_TYPE:
        this.enqueue(decoded.body.transferId, async () => this.acceptHandoff(decoded.body));
        break;
      case HANDOFF_END_TYPE:
        this.enqueue(decoded.body.transferId, async () => this.finishHandoff(decoded.body));
        break;
    }

    return true;
  }

  getStatus(): SnapshotBootstrapStatus {
    return {
      transfers: {
        inbound: [...this.inbound.values()].map((transfer) => ({
          transferId: transfer.transferId,
          peerId: transfer.peerId,
          shardId: transfer.shardId,
          expected: transfer.expected,
          totalChunks: transfer.totalChunks,
          snapshotLsn: transfer.snapshotLsn,
          highWaterMark: transfer.highWaterMark,
          applied: transfer.applied.size,
          entriesApplied: transfer.entriesApplied,
          phase: transfer.phase,
          startedAt: transfer.startedAt,
          updatedAt: transfer.updatedAt,
        })),
        outbound: [...this.outbound.values()].map((transfer) => ({ ...transfer })),
      },
      chunksSent: this.chunksSent,
      chunksReceived: this.chunksReceived,
      duplicateChunks: this.duplicateChunks,
      gapRequests: this.gapRequests,
      malformed: this.malformed,
      unknownTransfers: this.unknownTransfers,
      entriesApplied: this.entriesApplied,
      entriesSkipped: this.entriesSkipped,
      handoffApplied: this.handoffApplied,
      handoffSkipped: this.handoffSkipped,
      requestsSent: this.requestsSent,
      completed: this.completed.map((report) => ({ ...report })),
      lastError: this.lastError,
    };
  }

  /** The receiver in an unfinished transfer, if there is one. */
  getInboundTransfer(transferId: string): { expected: number; phase: string; highWaterMark: number } | null {
    const transfer = this.inbound.get(transferId);
    if (!transfer) return null;
    return { expected: transfer.expected, phase: transfer.phase, highWaterMark: transfer.highWaterMark };
  }

  // ── Source role ──

  /**
   * Answer a request with the snapshot, from the chunk it asked for.
   *
   * The position is read before the state, so a write that lands during the read
   * is in the snapshot *and* in the handoff. The other order leaves it in
   * neither — see the module comment.
   */
  private async serveSnapshot(body: BootstrapRequestBody, msg: InboundMessage): Promise<void> {
    const snapshotLsn = await this.source.currentLsn();
    const entries = await this.antiEntropy.snapshotEntries();
    const chunkSize = Math.max(1, this.config.chunkSize);
    // An empty dataset still has one chunk, and it is empty. Skipping the transfer
    // would leave the receiver waiting for a `bootstrap_done` that never comes.
    const totalChunks = Math.max(1, Math.ceil(entries.length / chunkSize));

    const outbound: OutboundTransfer = {
      transferId: body.transferId,
      peerId: msg.sourcePeerId,
      shardId: body.shardId,
      chunksSent: 0,
      entriesSent: 0,
      snapshotLsn,
      handoffEntries: 0,
      startedAt: Date.now(),
    };
    this.outbound.set(body.transferId, outbound);

    if (body.nextChunk >= totalChunks) {
      // The receiver already holds every chunk: it stopped after the last one and
      // before it could acknowledge. There is no chunk to send, and waiting for a
      // `bootstrap_done` that only a chunk would have provoked is how a resumed
      // transfer deadlocks at 100 %. Go straight to the handoff.
      await this.serveHandoff({ transferId: body.transferId, shardId: body.shardId, highWaterMark: snapshotLsn }, msg);
      return;
    }

    for (let index = body.nextChunk; index < totalChunks; index += 1) {
      const slice = entries.slice(index * chunkSize, (index + 1) * chunkSize);
      const frame = buildBootstrapChunk(
        randomUUID(),
        this.config.nodeId,
        msg.sourcePeerId,
        {
          transferId: body.transferId,
          shardId: body.shardId,
          chunkIndex: index,
          totalChunks,
          snapshotLsn,
          entries: slice,
        },
        this.hlc.now(),
      );

      if (!(await this.transport.send(frame))) {
        // The transfer stops here rather than continuing into frames that will be
        // rejected too. The receiver's next request names the chunk it has, so
        // stopping is recoverable; pushing into a broken link is not.
        this.lastError = `the transport refused chunk ${index} of ${body.transferId} for ${msg.sourcePeerId}`;
        return;
      }

      this.chunksSent += 1;
      outbound.chunksSent += 1;
      outbound.entriesSent += slice.length;
    }
  }

  /**
   * Answer "I have every chunk" with the changes the snapshot could not contain.
   *
   * Everything at or below `highWaterMark` is skipped by the receiver, so this
   * side may re-send the boundary entry without harm; it may not skip one above
   * it, which is why the loop reads until the source is exhausted rather than
   * until a batch size is reached.
   */
  private async serveHandoff(body: BootstrapDoneBody, msg: InboundMessage): Promise<void> {
    const outbound = this.outbound.get(body.transferId);
    const batchSize = Math.max(1, this.config.handoffBatchSize);
    let cursor = body.highWaterMark;
    let complete = true;

    for (;;) {
      let batch: Array<{ lsn: number; entry: DataEntry }>;
      try {
        batch = await this.source.entriesAfter(cursor, batchSize);
      } catch (err: unknown) {
        // The log no longer reaches the requested floor — it was compacted while
        // the receiver was catching up. Reported rather than worked around: the
        // only correct recovery is another snapshot, and the receiver is the only
        // party that can start one.
        complete = false;
        this.lastError = `handoff from ${body.highWaterMark} failed: ${describe(err)}`;
        break;
      }

      for (const { lsn, entry } of batch) {
        const frame = buildHandoffEntry(
          randomUUID(),
          this.config.nodeId,
          msg.sourcePeerId,
          { transferId: body.transferId, shardId: body.shardId, lsn, entry },
          this.hlc.now(),
        );
        if (!(await this.transport.send(frame))) {
          this.lastError = `the transport refused handoff entry ${lsn} of ${body.transferId} for ${msg.sourcePeerId}`;
          return;
        }
        cursor = lsn;
        if (outbound) outbound.handoffEntries += 1;
      }

      if (batch.length < batchSize) break;
    }

    const end = buildHandoffEnd(
      randomUUID(),
      this.config.nodeId,
      msg.sourcePeerId,
      { transferId: body.transferId, shardId: body.shardId, lastLsn: cursor, complete },
      this.hlc.now(),
    );
    if (!(await this.transport.send(end))) {
      this.lastError = `the transport refused the handoff end of ${body.transferId} for ${msg.sourcePeerId}`;
    }
  }

  // ── Receiver role ──

  private async acceptChunk(body: BootstrapChunkBody, msg: InboundMessage): Promise<void> {
    const transfer = this.inbound.get(body.transferId);
    if (!transfer) {
      // A chunk for a transfer this node has no record of: a resume after a
      // restart that lost the persisted cursor, or a sender still working on a
      // transfer this node already finished. Counted, because the first case is a
      // misconfiguration an operator has to see.
      this.unknownTransfers += 1;
      this.lastError = `chunk ${body.chunkIndex} of ${body.transferId} arrived for an unknown transfer`;
      return;
    }

    if (transfer.applied.has(body.chunkIndex)) {
      this.duplicateChunks += 1;
      return;
    }

    if (body.chunkIndex !== transfer.expected) {
      // A gap. Asking for the chunk this side is missing is the whole of the
      // recovery: the sender serves from the named index, and no state on either
      // side has to be unwound.
      this.gapRequests += 1;
      await this.sendRequest(transfer.peerId, transfer.transferId, transfer.expected, transfer.highWaterMark);
      return;
    }

    const outcome = await this.antiEntropy.applyRemote(body.entries);
    this.chunksReceived += 1;
    this.entriesApplied += outcome.applied;
    this.entriesSkipped += outcome.skipped + outcome.conflicts;
    transfer.entriesApplied += body.entries.length;
    transfer.applied.add(body.chunkIndex);
    transfer.expected += 1;
    transfer.totalChunks = body.totalChunks;
    transfer.snapshotLsn = body.snapshotLsn;
    // The snapshot claims state as of `snapshotLsn`, so the floor moves to it —
    // but never backwards. A receiver that was already ahead of the sender's
    // snapshot would otherwise lower its own floor and re-apply changes it had
    // applied before the transfer began.
    transfer.highWaterMark = Math.max(transfer.highWaterMark, body.snapshotLsn);
    transfer.updatedAt = Date.now();
    this.persistResume(transfer);

    if (transfer.expected >= body.totalChunks) {
      transfer.phase = 'handoff';
      const done = buildBootstrapDone(
        randomUUID(),
        this.config.nodeId,
        msg.sourcePeerId,
        { transferId: transfer.transferId, shardId: transfer.shardId, highWaterMark: transfer.highWaterMark },
        this.hlc.now(),
      );
      if (!(await this.transport.send(done))) {
        this.lastError = `the transport refused the bootstrap completion of ${transfer.transferId}`;
      }
    }
  }

  private async acceptHandoff(body: HandoffEntryBody): Promise<void> {
    const transfer = this.inbound.get(body.transferId);
    if (!transfer) {
      this.unknownTransfers += 1;
      this.lastError = `handoff entry ${body.lsn} arrived for an unknown transfer ${body.transferId}`;
      return;
    }

    if (body.lsn <= transfer.highWaterMark) {
      // The floor. This change is already reflected in the snapshot this side
      // applied, so applying it again would be replaying history — and, because
      // the entry carries its own clock, harmless in isolation but misleading in
      // a counter that is supposed to measure how far behind the peer was.
      this.handoffSkipped += 1;
      return;
    }

    await this.antiEntropy.applyRemote([body.entry]);
    transfer.phase = 'handoff';
    transfer.highWaterMark = body.lsn;
    transfer.updatedAt = Date.now();
    this.handoffApplied += 1;
  }

  private finishHandoff(body: HandoffEndBody): void {
    const transfer = this.inbound.get(body.transferId);
    if (!transfer) {
      this.unknownTransfers += 1;
      return;
    }

    transfer.updatedAt = Date.now();

    if (!body.complete) {
      // The sender could not reach back to this side's floor, so the state this
      // transfer produced has a hole that nothing will fill. Dropping the resume
      // cursor is the point: it forces the next `begin()` to ask from chunk zero
      // against a fresh snapshot, instead of resuming into the same gap.
      this.lastError =
        `handoff of ${body.transferId} was incomplete at ${body.lastLsn}: ` +
        'the peer could not reach the requested position (another snapshot is required)';
      this.inbound.delete(body.transferId);
      this.clearResume(transfer.peerId);
      return;
    }

    transfer.phase = 'done';
    transfer.highWaterMark = Math.max(transfer.highWaterMark, body.lastLsn);

    this.completed.push({
      transferId: transfer.transferId,
      peerId: transfer.peerId,
      shardId: transfer.shardId,
      role: 'receiver',
      chunks: transfer.applied.size,
      entriesApplied: transfer.entriesApplied,
      handoffApplied: this.handoffApplied,
      highWaterMark: transfer.highWaterMark,
      startedAt: transfer.startedAt,
      completedAt: Date.now(),
    });

    this.inbound.delete(body.transferId);
    this.clearResume(transfer.peerId);
  }

  // ── Resume state ──

  /**
   * Append a task to one transfer's chain.
   *
   * Not awaited by `handle()`: the frame has been claimed and its work is queued,
   * and a caller that awaited would be waiting for a store write to finish before
   * the next frame could even be read.
   */
  private enqueue(transferId: string, task: () => Promise<void>): void {
    const previous = this.serial.get(transferId) ?? Promise.resolve();
    const chained = previous.then(task).catch((err: unknown) => {
      this.lastError = describe(err);
    });
    this.serial.set(transferId, chained);
    void chained.finally(() => {
      if (this.serial.get(transferId) === chained) this.serial.delete(transferId);
    });
  }

  private async sendRequest(peerId: string, transferId: string, nextChunk: number, fromLsn: number): Promise<void> {
    const frame = buildBootstrapRequest(
      randomUUID(),
      this.config.nodeId,
      peerId,
      { transferId, shardId: this.config.shardId, nextChunk, fromLsn },
      this.hlc.now(),
    );
    const sent = await this.transport.send(frame);
    if (sent) this.requestsSent += 1;
    else this.lastError = `the transport refused a bootstrap request for ${peerId}`;
  }

  /** Read the persisted cursor for a peer, if it is still usable. */
  private readResume(peerId: string): { transferId: string; nextChunk: number } | null {
    const path = this.config.resumeStatePath;
    if (!path) return null;

    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return null;
      const entry = (parsed as Record<string, unknown>)[peerId];
      if (entry === null || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.transferId !== 'string') return null;
      if (typeof record.nextChunk !== 'number' || !Number.isInteger(record.nextChunk)) return null;
      if (record.nextChunk < 0) return null;
      return { transferId: record.transferId, nextChunk: record.nextChunk };
    } catch {
      // No file yet, or one this build cannot read. Starting from zero is correct
      // in both cases; it is only slower.
      return null;
    }
  }

  private persistResume(transfer: InboundTransfer): void {
    const path = this.config.resumeStatePath;
    if (!path) return;

    const current = this.readAllResume(path);
    current[transfer.peerId] = { transferId: transfer.transferId, nextChunk: transfer.expected };
    this.writeResume(path, current);
  }

  private clearResume(peerId: string): void {
    const path = this.config.resumeStatePath;
    if (!path) return;
    const current = this.readAllResume(path);
    if (!(peerId in current)) return;
    delete current[peerId];
    this.writeResume(path, current);
  }

  /**
   * Every cursor this file holds, or nothing when it holds something unreadable.
   *
   * The path is a parameter rather than read from the config: both callers have
   * already established that a path exists, and a second `if (!path)` here would
   * be a branch no call site can reach.
   */
  private readAllResume(path: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      // An array is an object, and spreading one here would produce `{'0': …}`
      // that the next read silently treats as a peer named `0`.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeResume(path: string, state: Record<string, unknown>): void {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path);
    } catch (err: unknown) {
      // A cursor that cannot be written costs a slower resume, not a failed
      // transfer: the chunks are idempotent and the sender serves from whatever
      // index the next request names.
      this.lastError = `could not persist the bootstrap cursor: ${describe(err)}`;
    }
  }
}

/** A reason, from whatever was thrown: a store may reject with a plain string. */
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
