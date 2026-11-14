/**
 * InProcessTransport — In-memory transport for testing federation layers.
 *
 * All messages are delivered within the same process via EventEmitter.
 * Supports:
 *   - Multiple independent "peers" identified by nodeId
 *   - Per-peer send, broadcast to all connected peers
 *   - Artificial latency simulation for realistic testing
 *   - Disconnection simulation (transport partition)
 *   - Message delivery guarantees (at-least-once with configurable drop rate)
 *
 * This is NOT for production use — only for integration/chaos testing.
 */

import type { ITransport } from "../interfaces/transport/ITransport";
import type { TransportMessage } from "../interfaces/transport/TransportMessage";
import type { InboundMessage } from "../interfaces/transport/InboundMessage";
import type { PeerInfo, TransportStats } from "../interfaces/types";
import { EventEmitter } from "events";

/**
 * Global registry of all InProcessTransport instances.
 * Messages sent via one transport are routed to others sharing the same key.
 */
const globalRegistry = new Map<string, Map<string, InProcessTransport>>();

export interface InProcessTransportConfig {
  /** Node identifier */
  nodeId: string;
  /** Registry key for message routing (all peers sharing this key can communicate) */
  registryKey?: string;
  /** Simulated outbound latency (ms) — default 0 */
  latencyMs?: number;
  /** Simulated message drop rate (0.0–1.0) — default 0 */
  dropRate?: number;
  /** Maximum jitter added to latency (ms) — default 0 */
  jitterMs?: number;
}

export class InProcessTransport implements ITransport {
  readonly nodeId: string;
  private readonly registryKey: string;
  private readonly latencyMs: number;
  private readonly dropRate: number;
  private readonly jitterMs: number;

  private readonly emitter = new EventEmitter();
  private _connectedAt: number = 0;
  private _stats = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesDropped: 0,
  };

  /** Cached list of peer infos — rebuilt lazily */
  private _peerCache: PeerInfo[] = [];

  constructor(config: InProcessTransportConfig) {
    this.nodeId = config.nodeId;
    this.registryKey = config.registryKey ?? "default";
    this.latencyMs = config.latencyMs ?? 0;
    this.dropRate = Math.max(0, Math.min(1, config.dropRate ?? 0));
    this.jitterMs = config.jitterMs ?? 0;

    // Register in global registry
    let registry = globalRegistry.get(this.registryKey);
    if (!registry) {
      registry = new Map();
      globalRegistry.set(this.registryKey, registry);
    }
    registry.set(this.nodeId, this);

    this._connectedAt = Date.now();
  }

  /**
   * Send a message to a specific peer.
   */
  async send(message: TransportMessage): Promise<boolean> {
    const registry = globalRegistry.get(this.registryKey);
    if (!registry) return false;

    const target = registry.get(message.targetPeerId);
    if (!target) return false;

    // Simulate drop
    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      this._stats.messagesDropped++;
      return true; // "sent" but dropped — caller doesn't know
    }

    const payloadSize = message.payload.byteLength;

    // Simulate latency
    if (this.latencyMs > 0 || this.jitterMs > 0) {
      const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
      const delay = this.latencyMs + jitter;

      setTimeout(() => {
        target._receive(message);
      }, delay);
    } else {
      // Synchronous delivery for zero-latency tests
      target._receive(message);
    }

    this._stats.messagesSent++;
    this._stats.bytesSent += payloadSize;
    return true;
  }

  /**
   * Broadcast a message to all connected peers (excluding self).
   */
  async broadcast(message: TransportMessage): Promise<number> {
    const registry = globalRegistry.get(this.registryKey);
    if (!registry) return 0;

    let sentCount = 0;
    for (const [peerId, transport] of registry) {
      if (peerId === this.nodeId) continue;

      // Simulate drop
      if (this.dropRate > 0 && Math.random() < this.dropRate) {
        this._stats.messagesDropped++;
        continue;
      }

      const payloadSize = message.payload.byteLength;

      if (this.latencyMs > 0 || this.jitterMs > 0) {
        const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
        const delay = this.latencyMs + jitter;
        setTimeout(() => {
          transport._receive(message);
        }, delay);
      } else {
        transport._receive(message);
      }

      this._stats.messagesSent++;
      this._stats.bytesSent += payloadSize;
      sentCount++;
    }

    return sentCount;
  }

  /**
   * Register a callback for incoming messages.
   */
  onMessage(callback: (message: InboundMessage) => void): () => void {
    this.emitter.on("message", callback);
    return () => {
      this.emitter.off("message", callback);
    };
  }

  /**
   * Get the list of currently connected peers.
   * Rebuilds the list from the registry on each call (always accurate).
   */
  getConnectedPeers(): PeerInfo[] {
    this._rebuildPeerCache();
    return [...this._peerCache];
  }

  /**
   * Get transport statistics.
   */
  getStats(): TransportStats {
    const now = Date.now();
    // Refresh peer count
    this._rebuildPeerCache();
    return {
      peersConnected: this._peerCache.length,
      messagesSent: this._stats.messagesSent,
      messagesReceived: this._stats.messagesReceived,
      bytesSent: this._stats.bytesSent,
      bytesReceived: this._stats.bytesReceived,
      uptimeMs: now - this._connectedAt,
    };
  }

  /**
   * Get additional test-only stats.
   */
  getDropStats(): { messagesDropped: number } {
    return { messagesDropped: this._stats.messagesDropped };
  }

  /**
   * Simulate a network partition: disconnect from peers.
   */
  partition(): void {
    const registry = globalRegistry.get(this.registryKey);
    if (!registry) return;
    registry.delete(this.nodeId);
    this._rebuildPeerCache();
  }

  /**
   * Simulate network heal: reconnect to peers.
   */
  heal(): void {
    const registry = globalRegistry.get(this.registryKey);
    if (!registry) return;
    registry.set(this.nodeId, this);
    this._rebuildPeerCache();
  }

  /** Destroy this transport and remove from registry */
  destroy(): void {
    const registry = globalRegistry.get(this.registryKey);
    if (registry) {
      registry.delete(this.nodeId);
      if (registry.size === 0) {
        globalRegistry.delete(this.registryKey);
      }
    }
    this.emitter.removeAllListeners();
    this._peerCache = [];
  }

  /**
   * Clear the global registry (for test cleanup).
   */
  static resetRegistry(key?: string): void {
    if (key) {
      globalRegistry.delete(key);
    } else {
      globalRegistry.clear();
    }
  }

  /** Internal: receive a message from another transport */
  _receive(message: TransportMessage): void {
    const inbound: InboundMessage = {
      ...message,
      receivedAt: Date.now(),
    };

    const payloadSize = inbound.payload.byteLength;
    this._stats.messagesReceived++;
    this._stats.bytesReceived += payloadSize;
    this.emitter.emit("message", inbound);
  }

  /** Rebuild the peer cache from the current registry */
  private _rebuildPeerCache(): void {
    const registry = globalRegistry.get(this.registryKey);
    if (!registry) {
      this._peerCache = [];
      return;
    }

    // If this node is not registered (e.g. after partition()), return empty
    if (!registry.has(this.nodeId)) {
      this._peerCache = [];
      return;
    }

    const peers: PeerInfo[] = [];
    for (const [peerId, transport] of registry) {
      if (peerId === this.nodeId) continue;
      const connectedAt = transport._connectedAt;
      peers.push({
        peerId,
        address: `inproc://${this.registryKey}/${peerId}`,
        connectedAt,
        latencyMs: this.latencyMs,
      });
    }
    this._peerCache = peers;
  }
}
