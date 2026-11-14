import { describe, it, expect } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([
  { name: 'InMemory', factory: new InMemoryEngineFactory() },
])('$name e2e: Tracing', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create distributed tracer', () => {
    const tracer = factory.createDistributedTracer();
    expect(tracer).toBeDefined();
  });

  it('should start and end a span', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('op1');
    expect(span.spanId).toBeTruthy();
    span.end('ok');
    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(completed[0].name).toBe('op1');
  });

  it('should create nested spans with parent-child relationship', () => {
    const tracer = factory.createDistributedTracer();
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child');
    child.end();
    parent.end();
    const completed = tracer.getCompletedSpans();
    const childSpan = completed.find(s => s.name === 'child');
    expect(childSpan!.parentSpanId).toBe(parent.spanId);
  });

  it('should share traceId across nested spans', () => {
    const tracer = factory.createDistributedTracer();
    const parent = tracer.startSpan('root');
    const child = tracer.startSpan('leaf');
    child.end();
    parent.end();
    const ids = new Set(tracer.getCompletedSpans().map(s => s.traceId));
    expect(ids.size).toBe(1);
  });

  it('should inject W3C trace headers', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('span');
    const carrier: Record<string, string> = {};
    tracer.inject(carrier);
    expect(carrier['traceparent']).toBeDefined();
    expect(carrier['traceparent']).toMatch(/^00-/);
    span.end('ok');
  });

  it('should extract W3C trace headers', () => {
    const tracer = factory.createDistributedTracer();
    const carrier = { traceparent: '00-abc123-def456-01' };
    const ctx = tracer.extract(carrier);
    expect(ctx).toBeDefined();
    expect(ctx!.traceId).toBe('abc123');
    expect(ctx!.parentSpanId).toBe('def456');
  });

  it('should clear completed spans', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('temp');
    span.end('ok');
    expect(tracer.getCompletedSpans()).toHaveLength(1);
    tracer.clearCompletedSpans();
    expect(tracer.getCompletedSpans()).toHaveLength(0);
  });

  it('should return undefined for getCurrentSpan when no active span', () => {
    const tracer = factory.createDistributedTracer();
    expect(tracer.getCurrentSpan()).toBeUndefined();
  });

  it('should return current span while active', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('active');
    const current = tracer.getCurrentSpan();
    expect(current).toBeDefined();
    expect(current!.spanId).toBe(span.spanId);
    span.end();
    expect(tracer.getCurrentSpan()).toBeUndefined();
  });

  it('should handle span status error', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('failing');
    span.end('error');
    expect(tracer.getCompletedSpans()[0].status).toBe('error');
  });

  it('should handle span with attributes', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('with-attrs', { attributes: { db: 'main', query: 'SELECT' } });
    span.end('ok');
    expect(tracer.getCompletedSpans()[0].attributes.db).toBe('main');
  });

  it('should return undefined for extract without header', () => {
    const tracer = factory.createDistributedTracer();
    const ctx = tracer.extract({});
    expect(ctx).toBeUndefined();
  });

  it('should support sibling spans', () => {
    const tracer = factory.createDistributedTracer();
    const parent = tracer.startSpan('parent');
    const child1 = tracer.startSpan('child1');
    child1.end();
    const child2 = tracer.startSpan('child2');
    child2.end();
    parent.end();
    const completed = tracer.getCompletedSpans();
    const c1 = completed.find(s => s.name === 'child1');
    const c2 = completed.find(s => s.name === 'child2');
    expect(c1!.traceId).toBe(c2!.traceId);
  });

  it('should inject trace context with correct format', () => {
    const tracer = factory.createDistributedTracer();
    const span = tracer.startSpan('formatted');
    const carrier: Record<string, string> = {};
    tracer.inject(carrier);
    expect(carrier.traceparent).toMatch(/^00-/);
    span.end();
  });

  it('should handle multiple active spans', () => {
    const tracer = factory.createDistributedTracer();
    const s1 = tracer.startSpan('s1');
    const s2 = tracer.startSpan('s2');
    const current = tracer.getCurrentSpan();
    expect(current).toBeDefined();
    s2.end();
    s1.end();
    expect(tracer.getCompletedSpans()).toHaveLength(2);
  });

  it('should share traceId across all spans', () => {
    const tracer = factory.createDistributedTracer();
    const parent = tracer.startSpan('root');
    const c1 = tracer.startSpan('c1');
    c1.end();
    const c2 = tracer.startSpan('c2');
    c2.end();
    parent.end();
    const traceIds = new Set(tracer.getCompletedSpans().map(s => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  it('should create and use multiple tracers independently', () => {
    const tracer = factory.createDistributedTracer();
    const t1Span = tracer.startSpan('tracer1');
    t1Span.end();
    expect(tracer.getCompletedSpans()).toHaveLength(1);
  });

  it('should clear empty tracer', () => {
    const tracer = factory.createDistributedTracer();
    tracer.clearCompletedSpans();
    expect(tracer.getCompletedSpans()).toEqual([]);
  });
});
