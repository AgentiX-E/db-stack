import type { ITelemetryExporter, Span, TelemetryExportFormat } from '../interfaces/index.js';

/**
 * In-memory telemetry exporter for testing.
 *
 * Captures exported spans in memory for assertion.
 */
export class InMemoryTelemetryExporter implements ITelemetryExporter {
  private exported: Span[][] = [];
  private connected = true;

  async export(spans: Span[]): Promise<void> {
    this.exported.push([...spans]);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getFormat(): TelemetryExportFormat {
    return 'json';
  }

  async shutdown(): Promise<void> {
    this.connected = false;
  }

  /** Test helper: get all exported span batches. */
  getExported(): Span[][] {
    return this.exported;
  }
}
