import type { OTSpan, OTMetric, OTLog } from './types.js';

export type { OTSpan, OTMetric, OTLog };

export interface IOTELBridge {
  startSpan(name: string, options?: {
    parentSpanId?: string;
    traceId?: string;
    attributes?: Record<string, string | number | boolean>;
  }): { spanId: string; end: (status?: 'ok' | 'error') => void };

  recordMetric(name: string, value: number, labels?: Record<string, string>): void;

  exportLog(log: Omit<OTLog, 'timestamp'>): void;

  shutdown(): Promise<void>;

  isShutdown(): boolean;

  getSpans(): OTSpan[];
  getMetrics(): OTMetric[];
  getLogs(): OTLog[];
}
