/**
 * observability/index — Barrel export for db-cluster observability module.
 */

export { LoggingAdapter, createLogger, traceContext } from './LoggingAdapter';
export { RaftMetricsCollector } from './RaftMetricsCollector';
export { HealthProbe, DEFAULT_PROBE_TIMEOUT_MS } from './HealthProbe';
export type { RaftMetricsSnapshot } from './RaftMetricsCollector';
export type { ProbeResult, HealthStatus, ProbeAnswer, ProbeTimer, HealthProbeOptions } from './HealthProbe';
export type { ILogger, LogEntry, LogLevel } from './interfaces';
