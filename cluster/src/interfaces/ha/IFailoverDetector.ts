import { NodeHealth, OperationResult } from '../types';

/**
 * Detects node failures in the cluster based on heartbeats and configurable thresholds.
 */
export interface IFailoverDetector {
  /**
   * Start monitoring nodes for failures.
   */
  start(): Promise<void>;

  /**
   * Stop the failure detection loop.
   */
  stop(): Promise<void>;

  /**
   * Report a heartbeat from a node.
   */
  heartbeat(nodeId: string): Promise<void>;

  /**
   * Get the current health status of a specific node.
   */
  getNodeHealth(nodeId: string): Promise<OperationResult<NodeHealth>>;

  /**
   * Get health status of all monitored nodes.
   */
  getAllHealth(): Promise<OperationResult<NodeHealth[]>>;

  /**
   * Configure failure detection parameters.
   */
  configure(config: FailoverDetectorConfig): Promise<void>;

  /**
   * Mark a node as suspected failed (used by external observers).
   */
  suspect(nodeId: string, reason: string): Promise<void>;

  /**
   * Mark a node as recovered.
   */
  recover(nodeId: string): Promise<void>;

  /**
   * Event: fires when a node is suspected of being down.
   */
  onNodeSuspected(callback: (nodeId: string, term: number) => void): void;

  /**
   * Event: fires when a node is confirmed as failed.
   */
  onNodeFailed(callback: (nodeId: string, term: number) => void): void;

  /**
   * Event: fires when a node recovers.
   */
  onNodeRecovered(callback: (nodeId: string) => void): void;
}

/**
 * Configuration for the failure detector.
 */
export interface FailoverDetectorConfig {
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;

  /** How long without a heartbeat before considering a node suspected (ms) */
  suspicionTimeoutMs: number;

  /** How long a node must remain suspected before confirming failure (ms) */
  failureTimeoutMs: number;

  /** Quorum size for confirming failure */
  quorumSize: number;

  /** Node IDs to monitor */
  monitoredNodes: string[];
}
