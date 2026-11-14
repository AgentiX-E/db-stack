export interface PeerInfo {
  peerId: string;
  address: string;
  connectedAt: number;
  latencyMs: number;
}

export interface TransportStats {
  peersConnected: number;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  uptimeMs: number;
}

export interface OutboxStats {
  totalEntries: number;
  pendingCount: number;
  deliveredCount: number;
  oldestPendingTimestamp: number | null;
}

export interface HLCStatus {
  wallClockTime: bigint;
  logicalCounter: number;
  nodeId: string;
}
