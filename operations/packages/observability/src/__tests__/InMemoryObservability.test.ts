import { describe, it, expect } from 'vitest';
import { InMemoryDistributedTracer } from '../impl/InMemoryDistributedTracer.js';
import { InMemoryTelemetryExporter } from '../impl/InMemoryTelemetryExporter.js';

describe('InMemoryDistributedTracer', () => {
  // O1: startSpan creates span with unique non-empty spanId
  it('O1: startSpan creates span with unique non-empty spanId', () => {
    const tracer = new InMemoryDistributedTracer();
    const s1 = tracer.startSpan('op1');
    const s2 = tracer.startSpan('op2');

    expect(s1.spanId).toBeTruthy();
    expect(s2.spanId).toBeTruthy();
    expect(typeof s1.spanId).toBe('string');
    expect(s1.spanId.length).toBeGreaterThan(0);
    expect(s2.spanId.length).toBeGreaterThan(0);
    expect(s1.spanId).not.toBe(s2.spanId);

    s1.end();
    s2.end();
  });

  // O2: end span records duration (endTime >= startTime)
  it('O2: end span records duration (endTime >= startTime)', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('timed-op');
    end();

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(completed[0].endTime).toBeDefined();
    expect(completed[0].endTime!).toBeGreaterThanOrEqual(completed[0].startTime);
  });

  // O3: nested spans parent-child: child.parentSpanId === parent.spanId
  it('O3: nested spans parent-child relationship', () => {
    const tracer = new InMemoryDistributedTracer();
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child');

    child.end();
    parent.end();

    const completed = tracer.getCompletedSpans();
    const parentSpan = completed.find((s) => s.spanId === parent.spanId);
    const childSpan = completed.find((s) => s.spanId === child.spanId);

    expect(childSpan!.parentSpanId).toBe(parent.spanId);
  });

  // O4: sibling spans share same traceId
  it('O4: sibling spans share same traceId', () => {
    const tracer = new InMemoryDistributedTracer();
    const parent = tracer.startSpan('parent');
    const child1 = tracer.startSpan('child1');
    child1.end();

    const child2 = tracer.startSpan('child2');
    child2.end();
    parent.end();

    const completed = tracer.getCompletedSpans();
    const traceIds = new Set(completed.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  // O5: getCurrentSpan returns active span during span, undefined after end
  it('O5: getCurrentSpan returns active span during span, undefined after end', () => {
    const tracer = new InMemoryDistributedTracer();

    expect(tracer.getCurrentSpan()).toBeUndefined();

    const { spanId, end } = tracer.startSpan('active-test');
    const current = tracer.getCurrentSpan();
    expect(current).toBeDefined();
    expect(current!.spanId).toBe(spanId);
    expect(current!.traceId).toBeTruthy();

    end();

    expect(tracer.getCurrentSpan()).toBeUndefined();
  });

  // O6: inject creates W3C traceparent header format: 00-{traceId}-{spanId}-01
  it('O6: inject creates W3C traceparent header format', () => {
    const tracer = new InMemoryDistributedTracer();
    const { spanId, end } = tracer.startSpan('inject-test');
    const carrier: Record<string, string> = {};

    tracer.inject(carrier);

    const current = tracer.getCurrentSpan();
    expect(carrier['traceparent']).toBe(`00-${current!.traceId}-${spanId}-01`);

    end();
  });

  // O7: extract parses W3C traceparent header from carrier
  it('O7: extract parses W3C traceparent header from carrier', () => {
    const tracer = new InMemoryDistributedTracer();
    const carrier = {
      traceparent: '00-abc123-def456-01',
    };

    const result = tracer.extract(carrier);
    expect(result).toBeDefined();
    expect(result!.traceId).toBe('abc123');
    expect(result!.parentSpanId).toBe('def456');
  });

  // O8: extract returns undefined if no traceparent
  it('O8: extract returns undefined if no traceparent', () => {
    const tracer = new InMemoryDistributedTracer();
    const result = tracer.extract({});
    expect(result).toBeUndefined();
  });

  // O8.1: extract handles malformed 5-part header gracefully
  it('O8.1: extract handles malformed 5-part header', () => {
    const tracer = new InMemoryDistributedTracer();
    const result = tracer.extract({ traceparent: '00-abc-def-gh-01-extra' });
    expect(result!.traceId).toBe('abc');
    expect(result!.parentSpanId).toBe('def');
  });

  // O8.2: extract handles empty parts in header
  it('O8.2: extract handles header with empty traceId', () => {
    const tracer = new InMemoryDistributedTracer();
    const result = tracer.extract({ traceparent: '00--def-01' });
    expect(result).toBeDefined();
    expect(result!.traceId).toBe('');
    expect(result!.parentSpanId).toBe('def');
  });

  // O11: startSpan attributes passed through correctly
  it('O11: startSpan attributes passed through correctly', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('attr-test', {
      attributes: { key1: 'value1', key2: 42, key3: true },
    });
    end();

    const completed = tracer.getCompletedSpans();
    expect(completed[0].attributes).toEqual({
      key1: 'value1',
      key2: 42,
      key3: true,
    });
  });

  // O12: getCompletedSpans returns all ended spans
  it('O12: getCompletedSpans returns all ended spans', () => {
    const tracer = new InMemoryDistributedTracer();
    const s1 = tracer.startSpan('span1');
    const s2 = tracer.startSpan('span2');
    const s3 = tracer.startSpan('span3');

    expect(tracer.getCompletedSpans()).toHaveLength(0);

    s3.end();
    expect(tracer.getCompletedSpans()).toHaveLength(1);

    s2.end();
    expect(tracer.getCompletedSpans()).toHaveLength(2);

    s1.end();
    expect(tracer.getCompletedSpans()).toHaveLength(3);
  });

  // O13: clearCompletedSpans resets completed spans
  it('O13: clearCompletedSpans resets completed spans', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('clear-test');
    end();

    expect(tracer.getCompletedSpans()).toHaveLength(1);
    tracer.clearCompletedSpans();
    expect(tracer.getCompletedSpans()).toHaveLength(0);
  });

  // Additional: extract with malformed traceparent (less than 4 parts)
  it('extract handles malformed traceparent gracefully', () => {
    const tracer = new InMemoryDistributedTracer();
    const carrier = { traceparent: '00-abc' };
    const result = tracer.extract(carrier);
    expect(result).toBeDefined();
    expect(result!.traceId).toBe('abc');
  });

  // Additional: status 'error' with errorMessage
  it('status and errorMessage passed to end() are reflected in span', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('error-span');
    end('error', 'something went wrong');

    const completed = tracer.getCompletedSpans();
    expect(completed[0].status).toBe('error');
    expect(completed[0].errorMessage).toBe('something went wrong');
  });

  // Additional: default status is 'ok' when end is called without args
  it('default status is ok when end called without args', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('default-ok');
    end();

    const completed = tracer.getCompletedSpans();
    expect(completed[0].status).toBe('ok');
  });

  // Additional: traceId not passed, no active span -> random traceId
  it('traceId is random when no active span and no options.traceId', () => {
    const tracer = new InMemoryDistributedTracer();
    const { end } = tracer.startSpan('root');
    end();

    const completed = tracer.getCompletedSpans();
    expect(completed[0].traceId).toBeTruthy();
    expect(completed[0].traceId.length).toBeGreaterThan(0);
  });

  // Additional: injected carrier only when span active
  it('inject does nothing when no active span', () => {
    const tracer = new InMemoryDistributedTracer();
    const carrier: Record<string, string> = {};
    tracer.inject(carrier);
    expect(carrier['traceparent']).toBeUndefined();
  });
});

describe('InMemoryTelemetryExporter', () => {
  // O9: exporter.export receives spans (exported.length increments)
  it('O9: exporter.export receives spans', async () => {
    const tracer = new InMemoryDistributedTracer();
    const exporter = new InMemoryTelemetryExporter();

    const { end } = tracer.startSpan('export-me');
    end();
    const spans = tracer.getCompletedSpans();

    await exporter.export(spans);
    expect(exporter.getExported()).toHaveLength(1);
    expect(exporter.getExported()[0]).toHaveLength(1);
    expect(exporter.getExported()[0][0].name).toBe('export-me');
  });

  // O10: exporter shutdown: isConnected() = false
  it('O10: exporter shutdown marks disconnected', async () => {
    const exporter = new InMemoryTelemetryExporter();
    expect(exporter.isConnected()).toBe(true);

    await exporter.shutdown();
    expect(exporter.isConnected()).toBe(false);
  });

  // O14: exporter.getFormat returns 'json'
  it('O14: exporter.getFormat returns json', () => {
    const exporter = new InMemoryTelemetryExporter();
    expect(exporter.getFormat()).toBe('json');
  });

  // O15: multiple export calls accumulate
  it('O15: multiple export calls accumulate', async () => {
    const tracer = new InMemoryDistributedTracer();
    const exporter = new InMemoryTelemetryExporter();

    const s1 = tracer.startSpan('batch1');
    s1.end();
    await exporter.export(tracer.getCompletedSpans());
    tracer.clearCompletedSpans();

    const s2 = tracer.startSpan('batch2');
    s2.end();
    await exporter.export(tracer.getCompletedSpans());

    expect(exporter.getExported()).toHaveLength(2);
    expect(exporter.getExported()[0][0].name).toBe('batch1');
    expect(exporter.getExported()[1][0].name).toBe('batch2');
  });

  // Reconnect not possible after shutdown
  it('stays disconnected after shutdown', async () => {
    const exporter = new InMemoryTelemetryExporter();
    await exporter.shutdown();
    expect(exporter.isConnected()).toBe(false);
    // No reconnect method, stays disconnected
  });
});
