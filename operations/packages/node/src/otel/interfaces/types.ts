export interface OTSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
}

export interface OTMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface OTLog {
  timestamp: number;
  severity: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attributes: Record<string, string | number | boolean>;
  traceId?: string;
  spanId?: string;
}
