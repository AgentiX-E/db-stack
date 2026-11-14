import type { IOTELBridge } from '../interfaces/index.js';
import type { OTSpan, OTMetric, OTLog } from '../interfaces/types.js';

let spanCounter = 0;

export class InMemoryOTELBridge implements IOTELBridge {
  private spans: OTSpan[] = [];
  private metrics: OTMetric[] = [];
  private logs: OTLog[] = [];
  private active: Map<string, OTSpan> = new Map();
  private _shutDown = false;

  startSpan(
    name: string,
    options?: {
      parentSpanId?: string;
      traceId?: string;
      attributes?: Record<string, string | number | boolean>;
    },
  ): { spanId: string; end: (status?: 'ok' | 'error') => void } {
    const spanId = `span-${++spanCounter}-${Date.now()}`;
    const traceId = options?.traceId ?? `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const span: OTSpan = {
      spanId,
      traceId,
      parentSpanId: options?.parentSpanId,
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      status: 'ok',
    };
    this.active.set(spanId, span);

    return {
      spanId,
      end: (status?: 'ok' | 'error') => {
        const s = this.active.get(spanId);
        if (!s) return;
        s.endTime = Date.now();
        s.status = status ?? 'ok';
        this.active.delete(spanId);
        this.spans.push(s);
      },
    };
  }

  recordMetric(name: string, value: number, labels?: Record<string, string>): void {
    this.metrics.push({ name, value, labels: labels ?? {}, timestamp: Date.now() });
  }

  exportLog(log: Omit<OTLog, 'timestamp'>): void {
    this.logs.push({ ...log, timestamp: Date.now() });
  }

  async shutdown(): Promise<void> {
    this._shutDown = true;
  }

  isShutdown(): boolean {
    return this._shutDown;
  }

  getSpans(): OTSpan[] {
    return [...this.spans];
  }

  getMetrics(): OTMetric[] {
    return [...this.metrics];
  }

  getLogs(): OTLog[] {
    return [...this.logs];
  }
}
