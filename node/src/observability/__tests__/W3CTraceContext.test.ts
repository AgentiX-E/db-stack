import { describe, it, expect, beforeEach } from 'vitest';
import { W3CTraceContextProvider } from '../impl/W3CTraceContext.js';

describe('W3CTraceContextProvider', () => {
  let ctx: W3CTraceContextProvider;

  beforeEach(() => {
    ctx = new W3CTraceContextProvider();
  });

  it('traceparent matches the W3C format', () => {
    const tp = ctx.getTraceParent();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('traceId is a 32-character hex string', () => {
    expect(ctx.getTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('spanId is a 16-character hex string', () => {
    expect(ctx.getSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('an initial traceId can be supplied', () => {
    const custom = new W3CTraceContextProvider('a'.repeat(32));
    expect(custom.getTraceId()).toBe('a'.repeat(32));
  });

  it('a child span shares the parent traceId', () => {
    const traceId = ctx.getTraceId();
    const span = ctx.createChildSpan('child-op');
    expect(span.getTraceParent().match(/00-([0-9a-f]{32})/)![1]).toBe(traceId);
  });

  it('read after setStatus preserves error status', () => {
    const span = ctx.createChildSpan('failing-op');
    span.setStatus('error', 'Connection timeout');
    span.end(); // no default param → should preserve 'error'
    const spans = ctx.flush();
    expect(spans[0]!.status).toBe('error');
    expect(spans[0]!.errorMessage).toBe('Connection timeout');
  });

  it('traceId propagates through the whole chain (cluster→federation→operations)', () => {
    const clusterCtx = new W3CTraceContextProvider();
    const traceId = clusterCtx.getTraceId();

    const raftSpan = clusterCtx.createChildSpan('raft.propose');
    raftSpan.end();

    const fedCtx = new W3CTraceContextProvider();
    fedCtx.extract(raftSpan.getTraceParent());
    expect(fedCtx.getTraceId()).toBe(traceId);

    const cdcSpan = fedCtx.createChildSpan('cdc.pump');
    cdcSpan.end();

    const opsCtx = new W3CTraceContextProvider();
    opsCtx.extract(cdcSpan.getTraceParent());
    expect(opsCtx.getTraceId()).toBe(traceId);

    const backupSpan = opsCtx.createChildSpan('backup.verify');
    backupSpan.end();

    expect(clusterCtx.getTraceId()).toBe(traceId);
    expect(fedCtx.getTraceId()).toBe(traceId);
    expect(opsCtx.getTraceId()).toBe(traceId);
  });

  it('addEvent appends an event to the span', () => {
    const span = ctx.createChildSpan('test');
    span.addEvent('data-sent', { size: '1024' });
    span.addEvent('ack-received');
    span.end();
    const spans = ctx.flush();
    expect(spans[0]!.events).toHaveLength(2);
    expect(spans[0]!.events[0]!.name).toBe('data-sent');
  });

  it('end sets the span end time', () => {
    const span = ctx.createChildSpan('quick-op');
    const before = Date.now();
    span.end('ok');
    const after = Date.now();
    const spans = ctx.flush();
    expect(spans[0]!.endTime).toBeGreaterThanOrEqual(before);
    expect(spans[0]!.endTime).toBeLessThanOrEqual(after);
    expect(spans[0]!.status).toBe('ok');
  });

  it('a repeated end does not change the data', () => {
    const span = ctx.createChildSpan('idempotent-end');
    span.end('ok');
    span.end('error');
    const spans = ctx.flush();
    expect(spans[0]!.status).toBe('ok');
  });

  it('extract restores the context from a valid traceparent', () => {
    const validTP = '00-11aabb22ccdd33ee44ff5566778899aa-bbccddee00112233-01';
    ctx.extract(validTP);
    expect(ctx.getTraceId()).toBe('11aabb22ccdd33ee44ff5566778899aa');
    expect(ctx.getSpanId()).toBe('bbccddee00112233');
  });

  it('extract throws on an invalid traceparent', () => {
    expect(() => ctx.extract('invalid-header')).toThrow('Invalid traceparent format');
    expect(() => ctx.extract('')).toThrow('Invalid traceparent format');
  });

  it('flush returns and clears every span', () => {
    ctx.createChildSpan('a').end();
    ctx.createChildSpan('b').end();
    ctx.createChildSpan('c').end();
    const spans = ctx.flush();
    expect(spans).toHaveLength(3);
    expect(ctx.spanCount()).toBe(0);
  });

  it('getActiveSpans returns only unfinished spans', () => {
    const s1 = ctx.createChildSpan('active1');
    ctx.createChildSpan('active2');
    s1.end();
    const active = ctx.getActiveSpans();
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('active2');
  });

  it('the span records error status and an exception event in a failure scenario', () => {
    const span = ctx.createChildSpan('db.write');
    span.setStatus('error', 'Disk full');
    span.addEvent('exception', { exception: 'Disk full' });
    span.end();
    const spans = ctx.flush();
    expect(spans[0]!.status).toBe('error');
    expect(spans[0]!.errorMessage).toContain('Disk full');
    expect(spans[0]!.events[0]!.name).toBe('exception');
  });
});
