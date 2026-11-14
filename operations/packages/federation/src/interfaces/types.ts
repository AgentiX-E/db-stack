/**
 * C5 Query Router — federated query routing, fan-out/fan-in execution,
 * partial merge, failover routing, and cost-based policies.
 *
 * @module @agentix-e/db-operations-federation/interfaces
 */

// ── Node Identity ───────────────────────────────────────────

/** A database node in the federation. */
export interface FederatedNode {
  /** Unique node identifier. */
  id: string;
  /** Host address. */
  host: string;
  /** Port. */
  port: number;
  /** Node role within the federation. */
  role: NodeRole;
  /** Health status. */
  health: NodeHealth;
  /** Shard assignments (which shards this node owns). */
  shardIds: string[];
  /** Weight for weighted routing (0-1). */
  weight: number;
  /** Node capabilities. */
  capabilities: NodeCapability[];
  /** Datacenter / region tag. */
  region: string;
  /** Current load metrics. */
  load?: NodeLoad;
}

/** Role a node plays in the federation. */
export type NodeRole = "primary" | "replica" | "coordinator" | "candidate";

/** Health state of a federated node. */
export type NodeHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

/** Capabilities a node can advertise. */
export type NodeCapability =
  | "read"
  | "write"
  | "analytics"
  | "fulltext"
  | "vector"
  | "graph";

/** Load snapshot for cost-based routing. */
export interface NodeLoad {
  /** CPU utilization 0-100. */
  cpuPercent: number;
  /** Memory utilization 0-100. */
  memoryPercent: number;
  /** Active connections. */
  activeConnections: number;
  /** Pending queries. */
  pendingQueries: number;
  /** Average query latency in ms (last 60s EMA). */
  avgLatencyMs: number;
}

// ── Query ───────────────────────────────────────────────────

/** Intent of a federated query. */
export type QueryIntent = "read" | "write" | "analytics";

/** Consistency level for cross-node reads. */
export type ConsistencyLevel = "eventual" | "strong" | "read_your_writes";

/** A federated query with routing metadata. */
export interface FederatedQuery {
  /** Unique query ID. */
  id: string;
  /** The query text (SQL, etc.). */
  sql: string;
  /** Query intent. */
  intent: QueryIntent;
  /** Requested consistency level. */
  consistency: ConsistencyLevel;
  /** Target shard IDs (empty = all). */
  targetShards: string[];
  /** Parameters for parameterized queries. */
  params?: Record<string, unknown>;
  /** Timeout in milliseconds. */
  timeoutMs: number;
}

// ── Routing ─────────────────────────────────────────────────

/** A single node assignment for a query. */
export interface NodeAssignment {
  /** Target node ID. */
  nodeId: string;
  /** Shard IDs assigned to this node. */
  shardIds: string[];
  /** Priority (lower = preferred). */
  priority: number;
  /** Reason for this assignment. */
  reason: string;
}

/** A complete query plan with node assignments. */
export interface QueryPlan {
  /** Original query. */
  query: FederatedQuery;
  /** Assigned nodes for shard execution. */
  assignments: NodeAssignment[];
  /** Routing strategy used. */
  strategy: RoutingStrategy;
  /** Total estimated cost. */
  estimatedCost: number;
  /** Plan creation timestamp. */
  createdAt: number;
}

/** Routing strategy identifiers. */
export type RoutingStrategy =
  | "round_robin"
  | "least_connections"
  | "weighted"
  | "geo_affinity"
  | "cost_based"
  | "leader_only";

// ── Routing Policy ──────────────────────────────────────────

/** Policy that governs routing decisions. */
export interface RoutingPolicy {
  /** Strategy to use. */
  strategy: RoutingStrategy;
  /** Fallback strategy if primary fails. */
  fallbackStrategy?: RoutingStrategy;
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Retry backoff base in ms. */
  retryBackoffMs: number;
  /** If true, exclude unhealthy nodes. */
  skipUnhealthy: boolean;
  /** If true, prefer nodes in the same region. */
  geoAffinity: boolean;
  /** Region tag for geo-affinity. */
  preferredRegion?: string;
  /** Cost thresholds for cost_based strategy. */
  costThreshold?: CostThreshold;
}

/** Cost-based routing thresholds. */
export interface CostThreshold {
  /** Max acceptable CPU percent. */
  maxCpuPercent: number;
  /** Max acceptable memory percent. */
  maxMemoryPercent: number;
  /** Max acceptable pending queries. */
  maxPendingQueries: number;
  /** Max acceptable avg latency in ms. */
  maxAvgLatencyMs: number;
}

// ── Execution Result ────────────────────────────────────────

/** Result from a single node. */
export interface NodeResult {
  /** Node ID. */
  nodeId: string;
  /** Shard IDs queried. */
  shardIds: string[];
  /** Result rows. */
  rows: Record<string, unknown>[];
  /** Row count. */
  rowCount: number;
  /** Execution duration in ms. */
  durationMs: number;
  /** Whether the query succeeded on this node. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

/** Merged result from a federated query. */
export interface FederatedResult {
  /** Original query ID. */
  queryId: string;
  /** Whether the overall query succeeded (all nodes or quorum). */
  success: boolean;
  /** Merged rows from all successful nodes. */
  rows: Record<string, unknown>[];
  /** Total merged row count. */
  totalRowCount: number;
  /** Per-node results. */
  nodeResults: NodeResult[];
  /** Total execution time in ms. */
  totalDurationMs: number;
  /** Number of nodes that succeeded. */
  successCount: number;
  /** Number of nodes that failed. */
  failCount: number;
  /** Global error if fully failed. */
  error?: string;
}

// ── Failover ────────────────────────────────────────────────

/** Failover event for a single node. */
export interface FailoverEvent {
  /** Failed node ID. */
  failedNodeId: string;
  /** Error that caused the failure. */
  error: string;
  /** Timestamp of failure. */
  timestamp: number;
  /** Replacement node ID (if reassigned). */
  failoverNodeId?: string;
  /** Whether failover succeeded. */
  success: boolean;
  /** Retry attempt number. */
  retryAttempt: number;
}

// ── Router Interface ────────────────────────────────────────

export interface IFederatedQueryRouter {
  /** Register a node in the federation. */
  registerNode(node: FederatedNode): void;

  /** Remove a node from the federation. */
  deregisterNode(nodeId: string): void;

  /** Update node load metrics for cost-based routing. */
  updateNodeLoad(nodeId: string, load: NodeLoad): void;

  /** Update node health status. */
  updateNodeHealth(nodeId: string, health: NodeHealth): void;

  /** Set the routing policy. */
  setRoutingPolicy(policy: RoutingPolicy): void;

  /** Build a query plan for the given query. */
  planQuery(query: FederatedQuery): QueryPlan;

  /** Execute a federated query with fan-out/fan-in. */
  executeQuery(query: FederatedQuery, executor: NodeExecutor): Promise<FederatedResult>;

  /** Execute a query plan directly (pre-built). */
  executePlan(plan: QueryPlan, executor: NodeExecutor): Promise<FederatedResult>;

  /** Merge partial results from multiple nodes. */
  mergeResults(results: NodeResult[]): FederatedResult;

  /** Get registered nodes. */
  getNodes(): FederatedNode[];

  /** Get active query plans. */
  getActivePlans(): QueryPlan[];

  /** Get failover history. */
  getFailoverHistory(): FailoverEvent[];

  /** Get router statistics. */
  getStats(): RouterStats;
}

/** Node-level query executor (injected — connects to actual DB). */
export type NodeExecutor = (
  node: FederatedNode,
  query: FederatedQuery,
  shardIds: string[],
) => Promise<NodeResult>;

/** Router statistics. */
export interface RouterStats {
  totalNodes: number;
  healthyNodes: number;
  degradedNodes: number;
  unhealthyNodes: number;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  totalFailovers: number;
  avgPlanTimeMs: number;
  avgExecutionTimeMs: number;
  lastQueryTimestamp: number | null;
}
