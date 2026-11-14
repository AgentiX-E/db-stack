import { RaftMessage, OperationResult } from '../types';

/**
 * Message receiver for cluster communication.
 * Uses ZMQ as the underlying transport.
 */
export interface ITransportReceiver {
  /**
   * Start listening for incoming messages on the given address.
   */
  listen(address: string): Promise<OperationResult>;

  /**
   * Stop listening and release resources.
   */
  close(): Promise<void>;

  /**
   * Send a Raft message to a specific node.
   */
  send(targetNodeId: string, message: RaftMessage): Promise<OperationResult>;

  /**
   * Broadcast a message to all nodes in the cluster.
   */
  broadcast(message: RaftMessage): Promise<OperationResult>;

  /**
   * Send a message to all members of a specific Raft group.
   */
  multicast(groupId: string, message: RaftMessage): Promise<OperationResult>;

  /**
   * Get the listen address of this receiver.
   */
  getAddress(): string;

  /**
   * Set the node ID for this receiver (used for message routing).
   */
  setNodeId(nodeId: string): void;

  /**
   * Get the configured node ID.
   */
  getNodeId(): string | null;

  /**
   * Event: fires when a Raft message is received.
   */
  onMessage(callback: (message: RaftMessage) => void): void;

  /**
   * Event: fires when the transport connection errors.
   */
  onError(callback: (error: Error) => void): void;

  /**
   * Register a node address mapping.
   */
  registerNode(nodeId: string, address: string): void;

  /**
   * Remove a node address mapping.
   */
  unregisterNode(nodeId: string): void;
}
