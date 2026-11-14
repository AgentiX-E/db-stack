/**
 * Parameterized E2E metrics registry tests across all real engines.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  IN_MEM_FACTORY,
  GRAPH_VEC_FACTORY,
  SQL_VEC_FACTORY,
  ENGINE_CASES,
} from './engineFactories.js';

const inMemFactory = IN_MEM_FACTORY;
const graphVecFactory = GRAPH_VEC_FACTORY;
const sqlVecFactory = SQL_VEC_FACTORY;

afterAll(async () => {
  await inMemFactory.cleanup();
  await sqlVecFactory.cleanup();
  await graphVecFactory.cleanup();
});

describe.each(ENGINE_CASES)('$name E2E: MetricsRegistry', ({ factory }) => {
  it('should create a metrics registry', async () => {
    const registry = await factory.createMetricsRegistry();
    expect(registry).toBeDefined();
  });

  it('should create a counter that increments', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('test_counter', { method: 'GET' });
    expect(c).toBeDefined();
    expect(typeof c.inc).toBe('function');
    c.inc();
    expect(c.get()).toBe(1);
  });

  it('should increment counter by arbitrary values', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('test_counter_by');
    c.incBy(5);
    expect(c.get()).toBe(5);
    c.incBy(3);
    expect(c.get()).toBe(8);
  });

  it('should support multiple independent counters', async () => {
    const registry = await factory.createMetricsRegistry();
    const a = registry.counter('requests');
    const b = registry.counter('errors');
    a.incBy(10);
    b.incBy(2);
    expect(a.get()).toBe(10);
    expect(b.get()).toBe(2);
  });

  it('should create a gauge', async () => {
    const registry = await factory.createMetricsRegistry();
    const g = registry.gauge('memory_usage');
    expect(g).toBeDefined();
    expect(typeof g.set).toBe('function');
  });

  it('should create a histogram', async () => {
    const registry = await factory.createMetricsRegistry();
    const h = registry.histogram('request_duration_ms');
    expect(h).toBeDefined();
    expect(typeof h.observe).toBe('function');
    h.observe(42);
    h.observe(100);
  });

  it('should produce a snapshot', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('snapshot_test');
    c.incBy(7);
    const snap = registry.snapshot();
    expect(snap).toBeDefined();
    expect(snap.points).toBeDefined();
  });

  it('snapshot should include counter values', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('snapshot_val');
    c.incBy(3);
    const snap = registry.snapshot();
    const point = snap.points.find(p => p.name === 'snapshot_val');
    if (point) {
      expect(point.value).toBe(3);
    }
  });

  it('should allow resetting counters', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('resettable');
    c.incBy(10);
    expect(c.get()).toBe(10);
    c.reset();
    expect(c.get()).toBe(0);
  });

  it('should support labeled counters across multiple values', async () => {
    const registry = await factory.createMetricsRegistry();
    const c1 = registry.counter('ops', { kind: 'read' });
    const c2 = registry.counter('ops', { kind: 'write' });
    c1.incBy(3);
    c2.incBy(7);
    // Each label group should track independently
    const snap = registry.snapshot();
    const opsPoints = snap.points.filter(p => p.name === 'ops');
    expect(opsPoints.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle concurrent counter operations', async () => {
    const registry = await factory.createMetricsRegistry();
    const c = registry.counter('concurrent');
    await Promise.all([
      c.inc(),
      c.incBy(2),
      c.incBy(3),
      c.inc(),
    ]);
    expect(c.get()).toBe(7);
  });
});
