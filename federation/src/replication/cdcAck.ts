/**
 * cdcAck — the frame a receiving datacenter sends back, and the rules for
 * reading one.
 *
 * Why this exists
 * ---------------
 * `ITransport.send()` resolves `true` when the bytes reached a socket. A TCP
 * write into a connection whose peer has already gone is accepted by the local
 * kernel, so the sender learns "enqueued" and the receiver learns nothing. An
 * acceptance run measured the gap exactly: twenty changes reported delivered,
 * thirteen applied, no refusal and no dead letter — the outbox was perfectly
 * consistent about a delivery that had not happened.
 *
 * The only instrument that can close that gap is the peer. It is the only party
 * that knows whether the change was applied, and it is the party the sender was
 * making a claim about.
 *
 * What an ack means, and what it does not
 * ---------------------------------------
 * An ack says **this node applied this change** — not "I received it", not "I
 * queued it". That is why the pipeline does not send one from `processInbound`:
 * dedup and decoding happen there, application happens in the caller's code, and
 * an ack sent before the apply is the same lie one layer up. The caller calls
 * `acknowledge()` after its own durable write.
 *
 * A receiver that cannot apply the change answers with a refusal instead, which
 * is a `{ ok: false, error }` body. That is not a courtesy: an undecodable or
 * poison payload that can never apply should fail on the sender immediately
 * rather than after every timeout, and the operator should see the receiver's
 * reason in `lastError`.
 */

import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

/** The `TransportMessage.type` of a confirmation. */
export const CDC_ACK_TYPE = 'cdc_ack';

/** What the peer said about one frame. */
export interface CdcAckVerdict {
  /** True when the peer applied the change. */
  ok: boolean;
  /** Why it did not, when `ok` is false. */
  error?: string;
  /**
   * The wait was abandoned rather than answered — the pipeline stopped, or the
   * transport threw. The entry is still pending and the attempt is not charged:
   * nothing was learned about the peer.
   */
  aborted?: boolean;
}

/**
 * The confirmation for one inbound frame.
 *
 * `timestamp` is the acker's own HLC, passed in rather than invented here: a
 * frame carrying the timestamp of the frame it acknowledges would claim the two
 * events happened at the same instant on the same clock.
 */
export function buildAckFrame(
  acked: TransportMessage,
  fromNodeId: string,
  timestamp: IHLCTimestamp,
  refusal?: string,
): TransportMessage {
  const body = refusal === undefined ? { ok: true } : { ok: false, error: refusal };
  return {
    // The id of the frame being acknowledged, so the sender can match it. The ack
    // is not a new message in the log — it is an answer about an old one.
    messageId: acked.messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: acked.sourcePeerId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type: CDC_ACK_TYPE,
  };
}

/**
 * Read a confirmation body.
 *
 * An empty payload is a confirmation: a peer that answered at all, on the frame
 * it was asked about, has told the sender the only thing the sender needs. A
 * body has to be JSON, and only an explicit `ok: false` is a refusal — anything
 * else that parses is read as "applied", because the alternative is treating a
 * peer's chatty acknowledgement as a delivery failure and re-sending a change
 * that has already been applied.
 *
 * A body that does **not** parse is a refusal. It came from the peer, on this
 * message's id, and it says something the sender cannot read; calling that a
 * confirmation would be taking an unreadable answer as a yes.
 */
export function parseAck(payload: Uint8Array, messageId: string): CdcAckVerdict {
  if (payload.length === 0) return { ok: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, error: `the acknowledgement for ${messageId} is not JSON` };
  }

  const body = parsed as { ok?: unknown; error?: unknown } | null;
  if (body !== null && typeof body === 'object' && body.ok === false) {
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `the peer refused ${messageId}`,
    };
  }
  return { ok: true };
}
