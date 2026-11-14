/**
 * observability interfaces — Distributed tracing and telemetry.
 *
 * @module @agentix-e/db-operations-observability/interfaces
 */

/** A single span in a distributed trace. */
export interface Span {
  /** Unique span identifier. */
  spanId: string;
  /** Parent span ID (undefined for root spans). */
  parentSpanId?: string;
  /** Trace identifier. */
  traceId: string;
  /** Span name (e.g., 'query.execute', 'raft.propose'). */
  name: string;
  /** Start timestamp (ns or ms). */
  startTime: number;
  /** End timestamp (ns or ms). */
  endTime?: number;
  /** Span attributes. */
  attributes: Record<string, string | number | boolean>;
  /** Span status. */
  status: 'ok' | 'error';
  /** Error message if status === 'error'. */
  errorMessage?: string;
}

/** Telemetry exporter output format. */
export type TelemetryExportFormat = 'otlp' | 'jaeger' | 'zipkin' | 'console' | 'json';

/**
 * Distributed tracer — creates and manages spans for distributed tracing.
 */
export interface IDistributedTracer {
  /**
   * Start a new span.
   * Returns a function to end the span with an optional status.
   */
  startSpan(name: string, options?: {
    parentSpanId?: string;
    traceId?: string;
    attributes?: Record<string, string | number | boolean>;
  }): { spanId: string; end: (status?: 'ok' | 'error', errorMessage?: string) => void };

  /**
   * Get the current span context (traceId + spanId).
   * Returns undefined if no span is active.
   */
  getCurrentSpan(): { traceId: string; spanId: string } | undefined;

  /**
   * Get all completed spans for exporting.
   */
  getCompletedSpans(): Span[];

  /**
   * Clear completed spans (after export).
   */
  clearCompletedSpans(): void;

  /**
   * Inject trace context into headers/carrier (for W3C Trace Context propagation).
   */
  inject(carrier: Record<string, string>): void;

  /**
   * Extract trace context from headers/carrier.
   */
  extract(carrier: Record<string, string>): { traceId: string; parentSpanId: string } | undefined;
}

/**
 * Telemetry exporter — exports spans to an external system.
 */
export interface ITelemetryExporter {
  /**
   * Export spans to the external system.
   */
  export(spans: Span[]): Promise<void>;

  /**
   * Check if the exporter is connected.
   */
  isConnected(): boolean;

  /**
   * Get the output format.
   */
  getFormat(): TelemetryExportFormat;

  /**
   * Shutdown the exporter.
   */
  shutdown(): Promise<void>;
}
