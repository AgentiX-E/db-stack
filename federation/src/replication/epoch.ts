/**
 * epoch — which incarnation of a node produced a frame.
 *
 * Why this exists
 * ---------------
 * A datacenter that has been rebuilt, rolled back or re-keyed is a *different*
 * incumbent of the same node id, and nothing on the wire said so. A frame from
 * the previous incarnation — a change the rebuild has since undone — was applied
 * as if it had happened after the rebuild, and the key it deleted came back. The
 * same question applies to a confirmation: an answer matched by message id from
 * an incarnation that no longer exists is an answer about a change this node may
 * have already forgotten.
 *
 * The instrument is a number the sender stamps on every frame it builds: its
 * incarnation. The receiver remembers the highest it has seen from each peer and
 * refuses anything older, by name, on the wire — a sender that is still alive
 * has to learn why its frames are not landing, and the one party that can retry
 * is the one that has to be told.
 *
 * What an epoch is not
 * --------------------
 * It is not a clock comparison, and it is not consensus. Two nodes' epochs are
 * never compared with each other — only a peer's own frames are ordered against
 * that peer's own watermark. A node that comes back with a *higher* number is the
 * peer rebuilt, and it is accepted: refusing it would take a datacenter out of
 * service for having been restored. A node that comes back with a *lower* number
 * is a frame from an incarnation this node has already moved past, and that is
 * the case the resurrection comes from.
 *
 * How a sender gets a number
 * --------------------------
 * `Date.now()` at construction by default, and `epoch` in the transport's
 * configuration when the operator wants the guarantee rather than the guess. A
 * rebuild on a clock that is behind the previous incarnation would take a number
 * that reads as stale, so the escape hatch is configuration: the number is a
 * promise the deployment can keep, and the default is the best one available
 * without asking.
 */

/** What an inbound frame's epoch says about the incarnation that produced it. */
export type EpochVerdict =
  /** The incarnation this node already knows, or the first one it has seen. */
  | 'current'
  /** A higher epoch than the watermark: the peer was rebuilt, and this is it. */
  | 'newer'
  /** A lower epoch than the watermark: a frame from an incarnation already passed. */
  | 'stale'
  /** No epoch at all: a frame from a build that predates the promise. */
  | 'unnamed';

/** What the ledger has seen, in a shape a status page can print. */
export interface EpochStatus {
  /** The highest epoch seen per peer id. */
  peers: Record<string, number>;
  /** Frames refused because their epoch was older than the watermark. */
  refused: number;
  /** Times a peer announced a higher epoch than the one already known. */
  advanced: number;
  /** Frames with no epoch: a peer that cannot name its incarnation. */
  epochless: number;
}

/**
 * The receiver's memory of incarnations.
 *
 * Deliberately not a store: the watermark is the highest epoch seen, and the only
 * thing that matters about it is that it never goes backwards. Persisting it
 * would be a second source of truth with its own recovery problem, and the cost
 * of forgetting it is bounded — the first frame after a restart is `current` or
 * `newer` for that peer, which is the same answer a fresh node gives.
 */
export class IncarnationLedger {
  private readonly seen = new Map<string, number>();
  private _refused = 0;
  private _advanced = 0;
  private _epochless = 0;

  /**
   * Classify one frame against what this node knows about its sender.
   *
   * Mutating on purpose: `newer` raises the watermark, and a caller that had to
   * remember to raise it separately would be a caller that can forget.
   */
  assess(peerId: string, epoch: number | null | undefined): EpochVerdict {
    // One test for "is this a number at all", and `Number.isFinite` is it: it
    // rejects `NaN` and `Infinity` as well, and either of those would answer
    // "current" through an arithmetic comparison (`NaN < 10` and `NaN > 10` are
    // both false) and let the frame through for ever. A peer that cannot name its
    // incarnation is a peer on an older build — refusing it would make the upgrade
    // itself the outage — so it is counted rather than refused, because "how much
    // of the fleet has not been rolled out" is a question an operator asks.
    const named = Number.isFinite(epoch) ? (epoch as number) : null;
    if (named === null) {
      this._epochless += 1;
      return 'unnamed';
    }

    const known = this.seen.get(peerId);
    if (known === undefined) {
      // First sight of this peer, and the watermark is recorded here rather than
      // after the comparisons: a peer whose first frame did not record it would be
      // a peer whose second frame is a first sight again, and every stale frame
      // would then be accepted. That is also the honest limit of the mechanism — a
      // stale frame that arrives before the rebuild's first frame has nothing to
      // be compared against, and no wire format can invent that answer.
      this.seen.set(peerId, named);
      return 'current';
    }
    if (named < known) {
      // Refused without touching the watermark: a stale frame that moved it would
      // make every later frame stale too, and the refusal would be the outage.
      this._refused += 1;
      return 'stale';
    }
    if (named > known) {
      // The peer was rebuilt. Recorded and counted together, because a watermark
      // raised without counting it, or a `newer` returned without raising it, is a
      // status page that disagrees with the decision it is reporting.
      this.seen.set(peerId, named);
      this._advanced += 1;
      return 'newer';
    }
    // The same incarnation again. Nothing to record, nothing to count: a steady
    // state is not an event.
    return 'current';
  }

  /** The highest epoch this node has seen from `peerId`, or `null`. */
  watermarkOf(peerId: string): number | null {
    return this.seen.get(peerId) ?? null;
  }

  /**
   * Why a frame was refused, as one sentence naming the peer and both epochs.
   *
   * The direction is stated rather than implied by the order of the numbers: an
   * operator reading `lastError` on the sender has to know which side is behind.
   */
  refusalFor(peerId: string, epoch: number): string {
    const known = this.seen.get(peerId);
    return (
      `frame from ${peerId} is stamped with epoch ${epoch}, which is older than ` +
      `epoch ${String(known)} this node has already seen from that peer: ` +
      'an incarnation this node has moved past cannot write changes back into it'
    );
  }

  /** A copy: a status page must not be able to lower the watermark it reports. */
  getStatus(): EpochStatus {
    return {
      peers: Object.fromEntries(this.seen),
      refused: this._refused,
      advanced: this._advanced,
      epochless: this._epochless,
    };
  }
}
