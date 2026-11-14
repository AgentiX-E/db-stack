# Examples

## Query Execution with Tracing

```typescript
import { InMemoryDistributedTracer } from '@agentix-e/db-operations-observability';

class QueryEngine {
  constructor(private tracer: InMemoryDistributedTracer) {}

  async execute(sql: string, db: string) {
    // Start root span for this query
    const querySpan = this.tracer.startSpan('db.query', {
      attributes: { 'db.name': db, 'db.statement': sql },
    });

    try {
      // Plan analysis
      const planSpan = this.tracer.startSpan('db.query.plan', {
        attributes: { 'db.name': db },
      });
      const plan = await this.analyze(sql);
      planSpan.end('ok');

      // Storage lookup
      const lookupSpan = this.tracer.startSpan('storage.read', {
        attributes: { table: plan.table },
      });
      const rows = await this.readFromStorage(plan);
      lookupSpan.end('ok');

      // Deserialize
      const deserSpan = this.tracer.startSpan('deserialize.rows', {
        attributes: { rowCount: rows.length },
      });
      const result = this.deserialize(rows);
      deserSpan.end('ok');

      querySpan.end('ok');
      return result;
    } catch (err) {
      querySpan.end('error', err.message);
      throw err;
    }
  }

  private async analyze(sql: string) { /* ... */ }
  private async readFromStorage(plan: any) { /* ... */ }
  private deserialize(rows: any) { /* ... */ }
}
```

## Test Assertions on Traces

```typescript
import { InMemoryDistributedTracer, InMemoryTelemetryExporter } from '@agentix-e/db-operations-observability';

describe('QueryEngine', () => {
  let tracer: InMemoryDistributedTracer;
  let engine: QueryEngine;

  beforeEach(() => {
    tracer = new InMemoryDistributedTracer();
    engine = new QueryEngine(tracer);
    tracer.clearCompletedSpans();
  });

  it('creates spans for each operation', async () => {
    await engine.execute('SELECT 1', 'test');

    const spans = tracer.getCompletedSpans();

    // Verify structure
    expect(spans.length).toBeGreaterThanOrEqual(3);
    
    const rootSpan = spans.find(s => s.name === 'db.query');
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.status).toBe('ok');
    expect(rootSpan!.attributes['db.name']).toBe('test');

    const childSpans = spans.filter(s => s.parentSpanId === rootSpan!.spanId);
    expect(childSpans.length).toBeGreaterThanOrEqual(2);
  });

  it('marks span as error on failure', async () => {
    await expect(engine.execute('INVALID SQL', 'test')).rejects.toThrow();

    const spans = tracer.getCompletedSpans();
    const rootSpan = spans.find(s => s.name === 'db.query');
    
    expect(rootSpan!.status).toBe('error');
    expect(rootSpan!.errorMessage).toBeDefined();
  });
});

describe('InMemoryTelemetryExporter', () => {
  it('captures exported spans', async () => {
    const tracer = new InMemoryDistributedTracer();
    const exporter = new InMemoryTelemetryExporter();

    const span = tracer.startSpan('test');
    span.end('ok');

    await exporter.export(tracer.getCompletedSpans());
    expect(exporter.getExported()).toHaveLength(1);
    expect(exporter.getExported()[0]).toHaveLength(1);
    
    await exporter.shutdown();
    expect(exporter.isConnected()).toBe(false);
  });
});
```

## Distributed Trace Across Services

```typescript
// Service A: API Gateway
const tracerA = new InMemoryDistributedTracer();

function handleRequest(req: Request) {
  const incomingCtx = tracerA.extract(req.headers);
  const span = tracerA.startSpan('gateway.handle', {
    traceId: incomingCtx?.traceId,
    parentSpanId: incomingCtx?.parentSpanId,
    attributes: { 'http.method': req.method, 'http.path': req.path },
  });

  // Forward trace context to downstream service
  const downstreamHeaders: Record<string, string> = {};
  tracerA.inject(downstreamHeaders);
  // ... pass downstreamHeaders to Service B ...

  span.end('ok');
}

// Service B: Query Engine (receives downstreamHeaders)
function processQuery(query: string, headers: Record<string, string>) {
  const tracerB = new InMemoryDistributedTracer();
  const ctx = tracerB.extract(headers);
  // ctx contains same traceId as Service A — full end-to-end trace!
  
  const span = tracerB.startSpan('engine.execute', {
    traceId: ctx?.traceId,
    parentSpanId: ctx?.parentSpanId,
    attributes: { 'db.statement': query },
  });
  // ... execute ...
  span.end('ok');
}
```

## Custom Exporter: OpenTelemetry Collector

```typescript
import type { ITelemetryExporter, Span, TelemetryExportFormat } from '@agentix-e/db-operations-observability';

class OTLPExporter implements ITelemetryExporter {
  private connected = false;
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async export(spans: Span[]): Promise<void> {
    const payload = spans.map(s => ({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      startTimeUnixNano: BigInt(s.startTime * 1_000_000).toString(),
      endTimeUnixNano: BigInt((s.endTime ?? 0) * 1_000_000).toString(),
      attributes: Object.entries(s.attributes).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
      status: s.status === 'error' ? { code: 2, message: s.errorMessage } : { code: 1 },
    }));

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: payload }] }] }),
    });
    this.connected = response.ok;
  }

  isConnected(): boolean { return this.connected; }
  getFormat(): TelemetryExportFormat { return 'otlp'; }
  async shutdown(): Promise<void> { this.connected = false; }
}
```
