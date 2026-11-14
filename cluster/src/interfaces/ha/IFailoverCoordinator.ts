import { OperationResult, MembershipChange } from '../types';
import { FailoverDetectorConfig } from './IFailoverDetector';

/**
 * Coordinates failover actions when a node is detected as failed.
 * Determines the appropriate recovery action and orchestrates it.
 */
export interface IFailoverCoordinator {
  /**
   * Initialize the coordinator with cluster configuration.
   */
  initialize(config: FailoverCoordinatorConfig): Promise<OperationResult>;

  /**
   * Handle a node failure event (invoked by the failure detector).
   */
  handleFailure(failedNodeId: string, term: number): Promise<OperationResult<FailoverAction>>;

  /**
   * Handle a node recovery event.
   */
  handleRecovery(nodeId: string): Promise<OperationResult>;

  /**
   * Execute a planned failover action.
   */
  executeAction(action: FailoverAction): Promise<OperationResult>;

  /**
   * Roll back a failover action that failed.
   */
  rollback(action: FailoverAction): Promise<OperationResult>;

  /**
   * Get the current failover state.
   */
  getState(): Promise<OperationResult<FailoverState>>;

  /**
   * Shut down the coordinator gracefully.
   */
  shutdown(): Promise<void>;
}

/**
 * Describes what action to take during a failover.
 */
export interface FailoverAction {
  type: 'promote_replica' | 'remove_node' | 'reshard' | 'trigger_election' | 'manual_intervention';
  targetNodeId: string;
  replacementNodeId?: string;
  shardIds?: string[];
  raftGroupIds?: string[];
  reason: string;
  timestamp: number;
}

/**
 * Runtime state of the failover coordinator.
 */
export interface FailoverState {
  isActive: boolean;
  pendingActions: FailoverAction[];
  completedActions: FailoverAction[];
  failedNodes: Set<string>;
  recoveryNodes: Set<string>;
}

/**
 * Configuration for the failover coordinator.
 */
export interface FailoverCoordinatorConfig {
  clusterId: string;
  detectorConfig: FailoverDetectorConfig;
  autoFailover: boolean;
  replicaPromotion: boolean;
  autoReshard: boolean;
  maxFailoverAttempts: number;
  coordinatorNodeId: string;
}
