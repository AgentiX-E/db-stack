import type { IDistributedTracer, Span } from '../interfaces/index.js';

function nanoId(): string {
  return crypto.randomUUID();
}

/**
 * In-memory distributed tracer for testing.
 *
 * - startSpan creates a span with unique ID and optional parent/trace context
 * - end finalizes the span with status and optional error message
 * - Supports W3C Trace Context propagation (inject/extract)
 */
export class InMemoryDistributedTracer implements IDistributedTracer {
  private spans: Span[] = [];
  private active = new Map<string, Span>();
  private currentSpanId: string | undefined;

  startSpan(
    name: string,
    options?: {
      parentSpanId?: string;
      traceId?: string;
      attributes?: Record<string, string | number | boolean>;
    },
  ): { spanId: string; end: (status?: 'ok' | 'error', errorMessage?: string) => void } {
    const spanId = nanoId();
    const current = this.currentSpanId ? this.active.get(this.currentSpanId) : undefined;
    const traceId = options?.traceId ?? current?.traceId ?? nanoId();
    const parentSpanId = options?.parentSpanId ?? this.currentSpanId;
    const span: Span = {
      spanId,
      traceId,
      parentSpanId,
      name,
      startTime: Date.now(),
      attributes: options?.attributes ?? {},
      status: 'ok',
    };

    this.active.set(spanId, span);
    this.currentSpanId = spanId;

    return {
      spanId,
      end: (status?: 'ok' | 'error', errorMessage?: string) => {
        const s = this.active.get(spanId);
        if (!s) return;
        s.endTime = Date.now();
        s.status = status ?? 'ok';
        s.errorMessage = errorMessage;
        this.active.delete(spanId);
        this.spans.push(s);
        this.currentSpanId = this.determineReturnParent(spanId);
      },
    };
  }

  getCurrentSpan(): { traceId: string; spanId: string } | undefined {
    if (!this.currentSpanId) return undefined;
    const span = this.active.get(this.currentSpanId);
    if (!span) return undefined;
    return { traceId: span.traceId, spanId: span.spanId };
  }

  getCompletedSpans(): Span[] {
    return [...this.spans];
  }

  clearCompletedSpans(): void {
    this.spans = [];
  }

  inject(carrier: Record<string, string>): void {
    const current = this.getCurrentSpan();
    if (current) {
      carrier['traceparent'] = `00-${current.traceId}-${current.spanId}-01`;
    }
  }

  extract(carrier: Record<string, string>): { traceId: string; parentSpanId: string } | undefined {
    const header = carrier['traceparent'];
    if (!header) return undefined;

    // Format: 00-{traceId}-{spanId}-01
    const parts = header.split('-');
    // Always extract traceId and spanId from parts[1] and parts[2]
    // regardless of part count; undefined parts default to ''
    return { traceId: parts[1] ?? '', parentSpanId: parts[2] ?? '' };
  }

  private determineReturnParent(spanId: string): string | undefined {
    const span = this.spans.find((s) => s.spanId === spanId);
    return span?.parentSpanId;
  }
}
