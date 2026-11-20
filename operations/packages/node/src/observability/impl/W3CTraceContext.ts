/**
 * W3C TraceContext — end-to-end distributed trace propagation.
 *
 * Implements the W3C Trace Context Level 2 specification:
 * https://www.w3.org/TR/trace-context-2/
 *
 * traceparent format: 00-{traceId}-{parentSpanId}-{traceFlags}
 *   - version: 2 hex chars (always 00)
 *   - traceId: 32 hex chars
 *   - parentSpanId: 16 hex chars
 *   - traceFlags: 2 hex chars (01 = sampled)
 *
 * Compatible with the OTel TraceContext.
 *
 * @module observability/trace
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ITraceContextProvider {
  /** Current traceparent header value */
  getTraceParent(): string;
  /** traceId */
  getTraceId(): string;
  /** Current spanId */
  getSpanId(): string;
  /** Create a child span */
  createChildSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan;
  /** Restore context from a traceparent value */
  extract(traceParent: string): void;
}

export interface ISpan {
  getTraceParent(): string;
  getSpanId(): string;
  end(status?: 'ok' | 'error', errorMessage?: string): void;
  addEvent(name: string, attrs?: Record<string, string>): void;
  setStatus(code: 'ok' | 'error', description?: string): void;
}

export interface SpanData {
  spanId: string;
  traceId: string;
  parentSpanId: string | undefined;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error';
  errorMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, string>;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────

function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, '0');
}

function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => hex(b, 2)).join('');
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// ── Implementation ─────────────────────────────────────────────────

export class W3CTraceContextProvider implements ITraceContextProvider {
  private _traceId: string;
  private _currentSpanId: string;
  private _spans: SpanData[] = [];

  constructor(traceId?: string) {
    this._traceId = traceId ?? randomHex(32);
    this._currentSpanId = randomHex(16);
  }

  getTraceParent(): string {
    return `00-${this._traceId}-${this._currentSpanId}-01`;
  }

  getTraceId(): string {
    return this._traceId;
  }

  getSpanId(): string {
    return this._currentSpanId;
  }

  createChildSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
    const parentSpanId = this._currentSpanId;
    const spanId = randomHex(16);

    const span: SpanData = {
      spanId,
      traceId: this._traceId,
      parentSpanId,
      name,
      startTime: Date.now(),
      status: 'ok',
      attributes: attributes ?? {},
      events: [],
    };

    this._spans.push(span);
    this._currentSpanId = spanId;

    // Methods are arrows so the span closes over this context instead of
    // aliasing `this` to a local variable.
    const traceId = this._traceId;
    let ended = false;

    return {
      getTraceParent: (): string => `00-${traceId}-${spanId}-01`,

      getSpanId: (): string => spanId,

      end: (status?: 'ok' | 'error', errorMessage?: string): void => {
        if (ended) return;
        ended = true;
        span.endTime = Date.now();
        // Only override status if explicitly provided
        if (status !== undefined) span.status = status;
        if (errorMessage !== undefined) span.errorMessage = errorMessage;
        this._currentSpanId = parentSpanId;
      },

      addEvent: (name: string, attrs?: Record<string, string>): void => {
        span.events.push({
          name,
          timestamp: Date.now(),
          attributes: attrs,
        });
      },

      setStatus: (code: 'ok' | 'error', description?: string): void => {
        span.status = code;
        if (description) span.errorMessage = description;
      },
    };
  }

  extract(traceParent: string): void {
    const match = TRACEPARENT_REGEX.exec(traceParent);
    if (!match) {
      throw new Error(`Invalid traceparent format: '${traceParent}'. Expected: 00-{traceId}-{spanId}-{flags}`);
    }
    this._traceId = match[1]!;
    this._currentSpanId = match[2]!;
  }

  /** Export every span (for tests and diagnostics) */
  flush(): SpanData[] {
    const result = [...this._spans];
    this._spans = [];
    return result;
  }

  /** Every span that has not ended yet */
  getActiveSpans(): SpanData[] {
    return this._spans.filter((s) => !s.endTime);
  }

  /** Number of spans */
  spanCount(): number {
    return this._spans.length;
  }
}
