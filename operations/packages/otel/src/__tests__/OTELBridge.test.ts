import { describe, it, expect } from 'vitest';
import { InMemoryOTELBridge } from '../impl/InMemoryOTELBridge.js';

describe('InMemoryOTELBridge', () => {
  it('starts empty', () => {
    const otel = new InMemoryOTELBridge();
    expect(otel.getSpans()).toEqual([]);
    expect(otel.getMetrics()).toEqual([]);
    expect(otel.getLogs()).toEqual([]);
  });

  it('startSpan creates a span', () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan('query');
    expect(s.spanId).toBeTruthy();
    expect(s.spanId.length).toBeGreaterThan(0);
    s.end('ok');
    expect(otel.getSpans()).toHaveLength(1);
    expect(otel.getSpans()[0].name).toBe('query');
  });

  it('end sets status correctly', () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan('db-call');
    s.end('error');
    expect(otel.getSpans()[0].status).toBe('error');
  });

  it('end span records endTime', () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan('timed');
    const before = Date.now();
    s.end('ok');
    const span = otel.getSpans()[0];
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
  });

  it('recordMetric stores metric', () => {
    const otel = new InMemoryOTELBridge();
    otel.recordMetric('db.queries', 42, { db: 'main' });
    expect(otel.getMetrics()).toHaveLength(1);
    expect(otel.getMetrics()[0].value).toBe(42);
  });

  it('recordMetric without labels', () => {
    const otel = new InMemoryOTELBridge();
    otel.recordMetric('cpu.usage', 0.85);
    expect(otel.getMetrics()[0].labels).toEqual({});
  });

  it('exportLog stores log entry', () => {
    const otel = new InMemoryOTELBridge();
    otel.exportLog({ severity: 'info', message: 'started', attributes: {} });
    expect(otel.getLogs()).toHaveLength(1);
    expect(otel.getLogs()[0].severity).toBe('info');
  });

  it('exportLog with trace context', () => {
    const otel = new InMemoryOTELBridge();
    otel.exportLog({ severity: 'error', message: 'fail', attributes: {}, traceId: 'trace-abc', spanId: 'span-xyz' });
    expect(otel.getLogs()[0].traceId).toBe('trace-abc');
    expect(otel.getLogs()[0].spanId).toBe('span-xyz');
  });

  it('shutdown does not throw', async () => {
    const otel = new InMemoryOTELBridge();
    await expect(otel.shutdown()).resolves.not.toThrow();
  });

  it('isShutdown reflects shutdown state', async () => {
    const otel = new InMemoryOTELBridge();
    expect(otel.isShutdown()).toBe(false);
    await otel.shutdown();
    expect(otel.isShutdown()).toBe(true);
  });

  it('spans have traceId set', () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan('root');
    expect(s.spanId).toBeTruthy();
    s.end('ok');
    expect(otel.getSpans()[0].traceId).toBeTruthy();
  });

  it('parent-child span relationship via parentSpanId', () => {
    const otel = new InMemoryOTELBridge();
    const parent = otel.startSpan('parent', { attributes: {} });
    const child = otel.startSpan('child', { parentSpanId: parent.spanId, attributes: {} });
    child.end('ok');
    parent.end('ok');
    const spans = otel.getSpans();
    const childSpan = spans.find(s => s.name === 'child');
    expect(childSpan!.parentSpanId).toBe(parent.spanId);
  });

  it('supports multiple metrics of same name', () => {
    const otel = new InMemoryOTELBridge();
    otel.recordMetric('counter', 1);
    otel.recordMetric('counter', 2);
    otel.recordMetric('counter', 3);
    expect(otel.getMetrics()).toHaveLength(3);
  });

  it('end with default status "ok"', () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan('default-status');
    s.end();
    expect(otel.getSpans()[0].status).toBe('ok');
  });
});
