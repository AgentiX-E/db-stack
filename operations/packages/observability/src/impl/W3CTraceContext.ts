/**
 * W3C TraceContext — 全链路分布式追踪传播。
 *
 * 实现 W3C Trace Context Level 2 规范：
 * https://www.w3.org/TR/trace-context-2/
 *
 * traceparent 格式: 00-{traceId}-{parentSpanId}-{traceFlags}
 *   - version: 2 hex chars (固定 00)
 *   - traceId: 32 hex chars
 *   - parentSpanId: 16 hex chars
 *   - traceFlags: 2 hex chars (01 = sampled)
 *
 * 与 OTel TraceContext 兼容。
 *
 * @module observability/trace
 */

// ── 类型 ──────────────────────────────────────────────────────────

export interface ITraceContextProvider {
  /** 获取当前 traceparent header value */
  getTraceParent(): string;
  /** 获取 traceId */
  getTraceId(): string;
  /** 获取当前 spanId */
  getSpanId(): string;
  /** 创建子 span */
  createChildSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan;
  /** 从 traceparent 恢复上下文 */
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
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, string> }>;
}

// ── 工具函数 ──────────────────────────────────────────────────────

function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, '0');
}

function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => hex(b, 2)).join('');
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// ── 实现 ──────────────────────────────────────────────────────────

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

  createChildSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): ISpan {
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

    const self = this;
    let ended = false;

    return {
      getTraceParent(): string {
        return `00-${self._traceId}-${spanId}-01`;
      },

      getSpanId(): string {
        return spanId;
      },

      end(status?: 'ok' | 'error', errorMessage?: string): void {
        if (ended) return;
        ended = true;
        span.endTime = Date.now();
        // Only override status if explicitly provided
        if (status !== undefined) span.status = status;
        if (errorMessage !== undefined) span.errorMessage = errorMessage;
        self._currentSpanId = parentSpanId;
      },

      addEvent(name: string, attrs?: Record<string, string>): void {
        span.events.push({
          name,
          timestamp: Date.now(),
          attributes: attrs,
        });
      },

      setStatus(code: 'ok' | 'error', description?: string): void {
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

  /** 导出所有 span 数据（测试/诊断用） */
  flush(): SpanData[] {
    const result = [...this._spans];
    this._spans = [];
    return result;
  }

  /** 获取所有未结束的 span */
  getActiveSpans(): SpanData[] {
    return this._spans.filter(s => !s.endTime);
  }

  /** 获取 span 数量 */
  spanCount(): number {
    return this._spans.length;
  }
}
