/**
 * SharedBatchedTransport — Request-response Transport bridge for SharedTransport.
 *
 * Wraps a SharedTransport (e.g. NodeTransport) to implement the
 * @maboke123/raft-core Transport interface (request-response via requestId).
 *
 * Architectural Role:
 *   In single-process multi-RaftGroup scenarios, all groups share one
 *   NodeTransport instance.  This class provides a per-RaftGroup view
 *   that handles request/response matching through the shared transport's
 *   message dispatch, without requiring direct access to the underlying
 *   TCP socket events.
 *
 * How it works:
 *   1. send(peerId, msg) encodes the message with a requestId, sends via
 *      sharedTransport.send() with per-shard routing (_shardId field),
 *      and returns a Promise that resolves when the matching response arrives.
 *   2. Inbound messages are received through sharedTransport.onMessage().
 *      The handler is registered during start(), filtered by shardId,
 *      and processes both request and response directions via requestId matching.
 *   3. Request direction: delegates to RaftNode's registered MessageHandler.
 *      Response direction: matches against pending requests.
 *   4. Outbound responses are sent back through the same sharedTransport path
 *      with direction='response' and the matching requestId.
 *
 * Wire format is identical to BatchedRaftTransport:
 *   { requestId: string, msg: RPCMessage }
 *
 * The _shardId field is embedded at the wireMsg level (not inside msg)
 * for correct routing by NodeTransport._handleIncoming.
 */

import type { Transport, MessageHandler, RPCMessage } from '@maboke123/raft-core';
import type { SharedTransport } from '../../interfaces/types';

let _reqIdCounter = 0;
function nextRequestId(): string {
  return `${process.pid}-${++_reqIdCounter}`;
}

interface PendingEntry {
  resolve: (msg: RPCMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SharedBatchedTransport implements Transport {
  private handler: MessageHandler | null = null;
  private pendingMap = new Map<string, PendingEntry>();
  private started = false;
  private shardId: number;
  private shared: SharedTransport;
  private selfNodeId: string;
  readonly requestTimeoutMs: number;
  /** Unregister function returned by SharedTransport.onMessage() — called on stop() */
  private unregisterHandler: (() => void) | null = null;

  /**
   * @param shared      SharedTransport instance (typically NodeTransport singleton)
   * @param shardId     RaftGroup shard ID for per-shard message routing
   * @param selfNodeId  Local node string ID
   * @param requestTimeoutMs  RPC timeout in ms (default 15000)
   */
  constructor(shared: SharedTransport, shardId: number, selfNodeId: string, requestTimeoutMs = 15000) {
    this.shared = shared;
    this.shardId = shardId;
    this.selfNodeId = selfNodeId;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.started) return;

    // Register per-shard message handler on the shared transport.
    // NodeTransport.onMessage dispatches (shardId, msg) for all shards.
    // We filter by our shardId and process via requestId matching.
    if (typeof (this.shared as any).onMessage === 'function') {
      const handler = (shardId: number, msg: any) => {
        if (shardId !== this.shardId) return;
        this.onIncoming(msg);
      };
      (this.shared as any).onMessage(handler);
      // Store unregister function if available (NodeTransport.offMessage)
      if (typeof (this.shared as any).offMessage === 'function') {
        this.unregisterHandler = () => (this.shared as any).offMessage(handler);
      }
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;

    // Unregister from shared transport
    if (this.unregisterHandler) {
      this.unregisterHandler();
      this.unregisterHandler = null;
    }

    // Reject all pending requests
    for (const [, entry] of this.pendingMap) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Transport stopped'));
    }
    this.pendingMap.clear();
  }

  isStarted(): boolean {
    return this.started;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Send an RPC request and wait for response via requestId matching.
   */
  async send(peerId: string, message: RPCMessage): Promise<RPCMessage> {
    const requestId = nextRequestId();

    return new Promise<RPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMap.delete(requestId);
        reject(new Error(`SharedTransport request timeout: ${message.type} to ${peerId}`));
      }, this.requestTimeoutMs);

      this.pendingMap.set(requestId, { resolve, reject, timer });

      // Build wire frame: { requestId, msg } with to and _shardId for routing
      const wireMsg: any = { requestId, msg: message as any, to: peerId };
      wireMsg._shardId = this.shardId;

      // Send through the shared transport directly (not via forShard).
      // We embed _shardId ourselves for correct per-shard routing.
      this.doSend(wireMsg).catch((err) => {
        const pending = this.pendingMap.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingMap.delete(requestId);
          pending.reject(err);
        }
      });
    });
  }

  /**
   * Actually dispatch the wire message through SharedTransport.
   * Sends directly to the underlying transport (bypassing forShard),
   * since we already embedded _shardId in the wireMsg.
   */
  private async doSend(wireMsg: any): Promise<void> {
    await this.shared.send(this.selfNodeId, [wireMsg]);
  }

  /**
   * Process an incoming message from SharedTransport dispatch.
   * Matches requestId for responses, delegates to handler for requests.
   *
   * The msg received from NodeTransport._dispatch is the raw wire message
   * (with requestId and msg fields). _shardId has already been extracted
   * and used for routing by NodeTransport.
   */
  private onIncoming(wireMsg: any): void {
    if (!this.started) return;

    const requestId = wireMsg?.requestId;
    const inner = requestId ? wireMsg.msg : wireMsg;

    // Response direction: match pending request
    if (requestId && inner?.direction === 'response') {
      const pending = this.pendingMap.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMap.delete(requestId);
        pending.resolve(inner);
      }
      return;
    }

    // Request direction: delegate to RaftNode handler
    if (!this.handler) return;

    // Extract sender info — the 'from' field is set by RaftTcpTransport
    // during message decode (msg.from = String(peerId)).
    const from = wireMsg.from ?? '';
    const innerMsg = inner as any;

    this.handler(from, innerMsg)
      .then((response: RPCMessage) => {
        if (!response || !this.started) return;

        // Send response back through SharedTransport with matching requestId
        const respRequestId = requestId || nextRequestId();
        const respWireMsg: any = {
          requestId: respRequestId,
          to: from, // Route response back to the sender
          msg: { ...response, direction: 'response' as const },
        };
        respWireMsg._shardId = this.shardId;

        this.doSend(respWireMsg).catch((err: unknown) => {
          console.warn('[SharedBatchedTransport] Response send failed:', err);
        });
      })
      .catch((err: unknown) => {
        console.warn('[SharedBatchedTransport] Handler error:', err);
      });
  }
}
