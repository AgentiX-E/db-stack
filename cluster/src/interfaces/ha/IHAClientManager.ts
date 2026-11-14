export interface IHAClientManager {
  /** Notify all connected clients to reconnect to new leader */
  redirectClients(newLeaderId: string, shardId: string): Promise<void>;
  /** Get count of currently connected clients */
  getClientCount(): number;
  /** Register a client for failover notifications */
  registerClient(clientId: string, shardIds: string[]): void;
  /** Unregister a client */
  unregisterClient(clientId: string): void;
  /** Get all clients that need to be redirected */
  getAffectedClients(shardId: string): string[];
  /** Drain connections gracefully during shutdown */
  drainConnections(timeoutMs: number): Promise<void>;
}
