/**
 * BatchedRaftTransport — Adapter for @maboke123/raft-core Transport interface
 *
 * Wraps RaftTcpTransport (message routing by msg.to) into request-response mode.
 *
 * Adds requestId at wire level to match requests to responses. Serializes as JSON Buffer,
 * Uses RaftTcpTransport.sendToPeer() to send directly to target peer.
 */

import { RaftTcpTransport, RaftTcpTransportConfig } from './RaftTcpTransport';
import type { Transport, MessageHandler, RPCMessage } from '@maboke123/raft-core';

let _reqIdCounter = 0;
function nextRequestId(): string {
  return `${process.pid}-${++_reqIdCounter}`;
}

interface PendingEntry {
  resolve: (msg: RPCMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HEADER_SIZE = 5; // 4-bit length + 1-bit format

/**
 * Builds MessageCodec-compatible wire frame (JSON format).
 * [4-byte length][1-byte format=0x00][JSON payload]
 */
function encodeWireBuffer(payload: Record<string, unknown>): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(body.length + 1, 0); // +1 for format byte
  header[4] = 0x00; // FORMAT_JSON
  return Buffer.concat([header, body]);
}

export class BatchedRaftTransport implements Transport {
  private transport: RaftTcpTransport;
  private handler: MessageHandler | null = null;
  private pendingMap = new Map<string, PendingEntry>();
  private started = false;
  readonly requestTimeoutMs: number;

  constructor(config: RaftTcpTransportConfig, requestTimeoutMs = 15000) {
    this.transport = new RaftTcpTransport(config);
    this.requestTimeoutMs = requestTimeoutMs;
  }

  get underlying(): RaftTcpTransport {
    return this.transport;
  }

  async addPeer?(_peerId: string, _address: string): Promise<void> {}
  removePeer?(_peerId: string): void {}

  async start(): Promise<void> {
    if (this.started) return;
    this.transport.on('message', (msg: any, fromPeerId: string) => {
      this.onIncoming(msg, fromPeerId);
    });
    await this.transport.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const [, entry] of this.pendingMap) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Transport stopped'));
    }
    this.pendingMap.clear();
    await this.transport.stop();
  }

  isStarted(): boolean {
    return this.started;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Send RPC request and wait for response. */
  async send(peerId: string, message: RPCMessage): Promise<RPCMessage> {
    const requestId = nextRequestId();
    const peerNumId = parseInt(peerId, 10);
    if (isNaN(peerNumId)) throw new Error(`Invalid peer id: ${peerId}`);

    return new Promise<RPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMap.delete(requestId);
        reject(new Error(`Raft transport request timeout: ${message.type} to ${peerId}`));
      }, this.requestTimeoutMs);

      this.pendingMap.set(requestId, { resolve, reject, timer });

      // Build wire frame: { requestId, msg }
      const frame = encodeWireBuffer({ requestId, msg: message as any });
      this.transport.sendToPeer(peerNumId, frame);
    });
  }

  async waitForConnections(): Promise<void> {
    await this.transport.waitForConnections();
  }

  /** Handle inbound messages */
  private onIncoming(wireMsg: any, fromPeerId: string): void {
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

    // Request direction: forward to handler
    if (!this.handler) return;

    this.handler(fromPeerId, inner)
      .then((response: RPCMessage) => {
        if (!response || !this.started) return;

        const respRequestId = requestId || nextRequestId();
        const respPeerNumId = parseInt(fromPeerId, 10);
        if (isNaN(respPeerNumId)) return;

        const frame = encodeWireBuffer({ requestId: respRequestId, msg: response as any });
        this.transport.sendToPeer(respPeerNumId, frame);
      })
      .catch((err: unknown) => {
        console.warn('[BatchedRaftTransport] Handler error:', err);
      });
  }
}
