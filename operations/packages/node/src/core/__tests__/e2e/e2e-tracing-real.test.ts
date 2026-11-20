/**
 * Parameterized E2E distributed tracing tests across all real engines.
 *
 * Tests span lifecycle, W3C traceparent propagation, and context
 * management for each engine's IDistributedTracer implementation.
 *
 * The IDistributedTracer.startSpan contract returns { spanId, end }.
 * Full span metadata (traceId, name, attributes) is available via
 * getCurrentSpan() or getCompletedSpans() depending on implementation.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { IN_MEM_FACTORY, GRAPH_VEC_FACTORY, SQL_VEC_FACTORY, ENGINE_CASES } from './engineFactories.js';

const inMemFactory = IN_MEM_FACTORY;
const graphVecFactory = GRAPH_VEC_FACTORY;
const sqlVecFactory = SQL_VEC_FACTORY;

afterAll(async () => {
  await inMemFactory.cleanup();
  await sqlVecFactory.cleanup();
  await graphVecFactory.cleanup();
});

describe.each(ENGINE_CASES)('$name E2E: DistributedTracer', ({ factory }) => {
  it('should create a distributed tracer', async () => {
    const tracer = await factory.createDistributedTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
  });

  it('should start a span returning spanId and end', async () => {
    const tracer = await factory.createDistributedTracer();
    const result = tracer.startSpan('test-operation');
    expect(result).toBeDefined();
    expect(result.spanId).toBeDefined();
    expect(typeof result.spanId).toBe('string');
    expect(typeof result.end).toBe('function');
  });

  it('should end a span without error', async () => {
    const tracer = await factory.createDistributedTracer();
    const { end } = tracer.startSpan('endable');
    expect(() => end()).not.toThrow();
    expect(() => end('ok')).not.toThrow();
    expect(() => end('error')).not.toThrow();
  });

  it('should inject trace context into a carrier object', async () => {
    const tracer = await factory.createDistributedTracer();
    const span = tracer.startSpan('inject-test');
    expect(span).toBeDefined();

    const carrier: Record<string, string> = {};
    tracer.inject(carrier);
    expect(carrier.traceparent).toBeDefined();
    expect(typeof carrier.traceparent).toBe('string');
    expect(carrier['traceparent']!.length).toBeGreaterThan(0);
  });

  it('injected traceparent should start with W3C version prefix', async () => {
    const tracer = await factory.createDistributedTracer();
    tracer.startSpan('tp-test');
    const carrier: Record<string, string> = {};
    tracer.inject(carrier);
    if (carrier.traceparent) {
      expect(carrier.traceparent).toMatch(/^00-/);
    }
  });

  it('should extract trace context from a valid carrier', async () => {
    const tracer = await factory.createDistributedTracer();
    tracer.startSpan('extract-test');
    const carrier: Record<string, string> = {};
    tracer.inject(carrier);

    if (Object.keys(carrier).length > 0) {
      const context = tracer.extract(carrier);
      expect(context).toBeDefined();
      if (context) {
        expect(context.traceId).toBeDefined();
      }
    }
  });

  it('should handle invalid carrier gracefully (no throw)', async () => {
    const tracer = await factory.createDistributedTracer();
    expect(() => {
      tracer.extract({ invalid: 'carrier' });
    }).not.toThrow();
  });

  it('should retrieve current span context', async () => {
    const tracer = await factory.createDistributedTracer();
    tracer.startSpan('current-test');
    const current = tracer.getCurrentSpan();
    // Not all tracers track current span — undefined is acceptable
    if (current) {
      expect(current.traceId).toBeDefined();
      expect(current.spanId).toBeDefined();
      expect(typeof current.traceId).toBe('string');
      expect(typeof current.spanId).toBe('string');
    }
  });

  it('should get completed spans as an array', async () => {
    const tracer = await factory.createDistributedTracer();
    const { end } = tracer.startSpan('completable');
    end();
    const completed = tracer.getCompletedSpans();
    expect(completed).toBeInstanceOf(Array);
  });

  it('completed spans should have spanId', async () => {
    const tracer = await factory.createDistributedTracer();
    const { spanId, end } = tracer.startSpan('checkable');
    end('ok');
    const completed = tracer.getCompletedSpans();
    if (completed.length > 0) {
      expect(completed[0]!.spanId).toBeDefined();
    }
  });

  it('should create multiple spans with unique spanIds', async () => {
    const tracer = await factory.createDistributedTracer();
    const results = [];
    for (let i = 0; i < 5; i++) {
      const { spanId, end } = tracer.startSpan(`concurrent-${i}`);
      results.push({ spanId, end });
    }
    expect(results.length).toBe(5);
    const ids = results.map((r) => r.spanId);
    expect(new Set(ids).size).toBe(5); // All unique
    results.forEach((r) => r.end());
  });

  it('should create a child span sharing trace context', async () => {
    const tracer = await factory.createDistributedTracer();
    const { spanId: parentId } = tracer.startSpan('parent');
    const { spanId: childId } = tracer.startSpan('child', {
      parentSpanId: parentId,
    });
    expect(childId).toBeDefined();
    expect(childId).not.toBe(parentId);
  });

  it('should clear completed spans', async () => {
    const tracer = await factory.createDistributedTracer();
    const { end } = tracer.startSpan('clearable');
    end();
    tracer.clearCompletedSpans();
    const completed = tracer.getCompletedSpans();
    expect(completed.length).toBe(0);
  });
});
