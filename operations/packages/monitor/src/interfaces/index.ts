// ── Existing Interfaces ──

export interface IMetricsRegistry {
  /** Increment a counter metric */
  incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
  /** Observe a histogram value */
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
  /** Set a gauge value */
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Get snapshot of all registered metrics */
  snapshot(): Promise<Record<string, unknown>>;
  /** Reset all metrics */
  reset(): void;
}

export interface ISlowQueryRecorder {
  /** Record a slow query event */
  record(query: SlowQueryRecord): Promise<void>;
  /** Get slow queries exceeding a threshold duration */
  getSlowQueries(thresholdMs: number): Promise<SlowQueryRecord[]>;
  /** Analyze query patterns to detect anomalies */
  analyzePatterns(): Promise<QueryPattern[]>;
}

export interface SlowQueryRecord {
  query: string;
  durationMs: number;
  timestamp: Date;
  database: string;
  user?: string;
  rowsExamined?: number;
  rowsSent?: number;
}

export interface QueryPattern {
  pattern: string;
  averageDurationMs: number;
  count: number;
  lastSeen: Date;
}

export interface IAlertRuleManager {
  /** Create a new alert rule */
  createRule(rule: AlertRule): Promise<string>;
  /** Update an existing alert rule */
  updateRule(id: string, rule: Partial<AlertRule>): Promise<void>;
  /** Delete an alert rule */
  deleteRule(id: string): Promise<void>;
  /** Evaluate all rules and return triggered alerts */
  evaluate(): Promise<TriggeredAlert[]>;
  /** Silence a rule for a specified duration */
  silenceRule(id: string, durationMs: number): Promise<void>;
}

export interface AlertRule {
  id?: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  durationMs: number;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}

export interface TriggeredAlert {
  ruleId: string;
  ruleName: string;
  severity: string;
  value: number;
  threshold: number;
  triggeredAt: Date;
  message: string;
}

export interface IHealthCheck {
  /** Perform a health check and return the result */
  check(): Promise<HealthCheckResult>;
  /** Get health check history */
  getHistory(limit?: number): Promise<HealthCheckResult[]>;
  /** Register a new health check component */
  registerComponent(name: string, checkFn: () => Promise<ComponentStatus>): void;
}

export interface ComponentStatus {
  name: string;
  healthy: boolean;
  message?: string;
  lastChecked: Date;
  latencyMs: number;
}

export interface HealthCheckResult {
  overall: boolean;
  components: ComponentStatus[];
  timestamp: Date;
}

// ── Sprint 1.2 New Interfaces ──

export interface IDeadlockInfo {
  /** Cycle of transactions involved in the deadlock */
  cycle: string[];
  /** The transaction chosen as the victim to resolve the deadlock */
  victimTransaction: string;
  /** Timestamp when the deadlock was detected */
  detectedAt: Date;
}

export interface IDeadlockDetector {
  /** Start monitoring for deadlocks */
  start(): Promise<void>;
  /** Stop monitoring for deadlocks */
  stop(): Promise<void>;
  /** Callback invoked when a deadlock is detected */
  onDeadlock(callback: (info: IDeadlockInfo) => void): void;
  /** Get the history of detected deadlocks */
  getDeadlockHistory(): Promise<IDeadlockInfo[]>;
}

export interface IConnectionInfo {
  /** Connection identifier */
  id: string;
  /** Database user name */
  user: string;
  /** Database name the connection is attached to */
  database: string;
  /** Current connection state (active, idle, idle in transaction, etc.) */
  state: string;
  /** Currently executing query, if any */
  query?: string;
  /** Timestamp when the connection was established */
  connectedAt: Date;
  /** Whether the connection is idle in a transaction */
  idleInTransaction: boolean;
}

export interface IConnectionMonitor {
  /** Start monitoring connections */
  start(): Promise<void>;
  /** Stop monitoring connections */
  stop(): Promise<void>;
  /** Get information about all current connections */
  getConnections(): Promise<IConnectionInfo[]>;
  /** Get current pool utilization statistics */
  getPoolUtilization(): Promise<{ total: number; active: number; idle: number; waiting: number }>;
  /** Callback invoked when the connection pool is exhausted */
  onExhaustion(callback: (stats: { total: number; active: number; waiting: number }) => void): void;
}

export interface IResourceQuota {
  /** Maximum CPU usage (percentage or cores) */
  cpuLimit: number;
  /** Maximum memory usage in MB */
  memoryLimitMB: number;
  /** Maximum number of concurrent connections */
  connectionLimit: number;
  /** Maximum query rate (queries per second/minute) */
  queryRateLimit: number;
}

export interface IResourceQuotaManager {
  /** Set the resource quota for a given role */
  setQuota(roleId: string, quota: IResourceQuota): Promise<void>;
  /** Get the resource quota for a given role */
  getQuota(roleId: string): Promise<IResourceQuota | null>;
  /** Check whether a role is allowed to consume the requested resources */
  checkQuota(roleId: string): Promise<{ allowed: boolean; reason?: string }>;
  /** Get current resource usage for a given role */
  getUsage(roleId: string): Promise<{ cpu: number; memoryMB: number; connections: number; queryRate: number }>;
}
export interface ResourceUsageSnapshot {
  /** Memory usage in bytes. */
  memoryBytes: number;
  /** Memory limit in bytes (0 = unlimited). */
  memoryLimitBytes: number;
  /** Memory utilization ratio. */
  memoryUtilization: number;
  /** Current queries per second rate. */
  queriesPerSec: number;
  /** Maximum allowed queries per second. */
  maxQueriesPerSec: number;
  /** CPU usage percentage (0-100). */
  cpuPercent: number;
  /** Connection pool state. */
  connectionPool: {
    total: number;
    active: number;
    idle: number;
    waiting: number;
    maxSize: number;
    utilization: number;
  };
  /** Disk used in bytes. */
  diskUsedBytes: number;
  /** Disk free in bytes. */
  diskFreeBytes: number;
  /** Snapshot timestamp in ms. */
  timestamp?: number;
}
