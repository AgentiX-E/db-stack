/**
 * MetricsRegistry.test.ts — Tests for MetricsRegistry.
 *
 * Covers: Counter inc/incBy/reset/get, Gauge set/inc/dec/add/get,
 * Histogram observe/count/sum/quantile/reset, labeled metrics,
 * snapshot() correctness.
 */

import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../impl/MetricsRegistry.js';

describe('MetricsRegistry', () => {
  // ── Counter ──

  describe('Counter', () => {
    it('inc increments by 1', () => {
      const registry = new MetricsRegistry();
      const c = registry.counter('requests_total');
      c.inc();
      expect(c.get()).toBe(1);
      c.inc();
      expect(c.get()).toBe(2);
    });

    it('incBy increments by n', () => {
      const registry = new MetricsRegistry();
      const c = registry.counter('requests_total');
      c.incBy(10);
      expect(c.get()).toBe(10);
    });

    it('incBy rejects negative values', () => {
      const registry = new MetricsRegistry();
      const c = registry.counter('requests_total');
      expect(() => c.incBy(-5)).toThrow('Counter cannot decrement');
    });

    it('reset sets value to 0', () => {
      const registry = new MetricsRegistry();
      const c = registry.counter('requests_total');
      c.incBy(25);
      expect(c.get()).toBe(25);
      c.reset();
      expect(c.get()).toBe(0);
    });
  });

  // ── Gauge ──

  describe('Gauge', () => {
    it('set/inc/dec round-trip', () => {
      const registry = new MetricsRegistry();
      const g = registry.gauge('active_connections');

      g.set(42);
      expect(g.get()).toBe(42);

      g.inc();
      expect(g.get()).toBe(43);

      g.dec();
      expect(g.get()).toBe(42);
    });

    it('add with positive value works', () => {
      const registry = new MetricsRegistry();
      const g = registry.gauge('temperature');
      g.set(20);
      g.add(5);
      expect(g.get()).toBe(25);
    });

    it('add with negative value works', () => {
      const registry = new MetricsRegistry();
      const g = registry.gauge('temperature');
      g.set(20);
      g.add(-5);
      expect(g.get()).toBe(15);
    });
  });

  // ── Histogram ──

  describe('Histogram', () => {
    it('observe increases count and sum', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('request_duration_ms');

      h.observe(100);
      h.observe(200);
      h.observe(300);

      expect(h.getCount()).toBe(3);
      expect(h.getSum()).toBe(600);
    });

    it('getQuantile returns approximate value', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('request_duration_ms');

      h.observe(10);
      h.observe(20);
      h.observe(30);
      h.observe(40);
      h.observe(50);

      // Median (p=0.5) should be ~30
      const median = h.getQuantile(0.5);
      expect(median).toBe(30);

      // P90 should be ~46 (index: floor(0.9 * 4) = 3, sorted[3] = 40... wait)
      // Actually: sorted = [10, 20, 30, 40, 50], length=5
      // idx = floor(0.9 * 4) = 3, sorted[3] = 40
      const p90 = h.getQuantile(0.9);
      expect(p90).toBe(40);
    });

    it('getQuantile sorts values before computing the index', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('unsorted_ms');

      // Observe in non-monotonic order; the `a - b` comparator must sort
      // ascending. A `+` mutant (a + b) breaks ordering and yields a wrong value.
      h.observe(50);
      h.observe(10);
      h.observe(40);
      h.observe(20);
      h.observe(30);

      // Sorted ascending → [10, 20, 30, 40, 50]; median = sorted[2] = 30.
      expect(h.getQuantile(0.5)).toBe(30);
    });

    it('getQuantile returns undefined for empty histogram', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('empty');
      expect(h.getQuantile(0.5)).toBeUndefined();
    });

    it('reset clears histogram', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('latency');
      h.observe(100);
      h.observe(200);
      expect(h.getCount()).toBe(2);

      h.reset();
      expect(h.getCount()).toBe(0);
      expect(h.getSum()).toBe(0);
    });

    it('multiple observations of same value', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('ping_ms');
      h.observe(42);
      h.observe(42);
      h.observe(42);

      expect(h.getCount()).toBe(3);
      expect(h.getSum()).toBe(126);
    });
  });

  // ── Labeled Metrics ──

  describe('Labeled Metrics', () => {
    it('multiple metrics with different labels are separate', () => {
      const registry = new MetricsRegistry();
      const c1 = registry.counter('requests_total', { method: 'GET' });
      const c2 = registry.counter('requests_total', { method: 'POST' });

      c1.incBy(10);
      c2.incBy(5);

      expect(c1.get()).toBe(10);
      expect(c2.get()).toBe(5);
    });

    it('same name + same labels returns same instance', () => {
      const registry = new MetricsRegistry();
      const c1 = registry.counter('test', { label: 'val' });
      const c2 = registry.counter('test', { label: 'val' });

      c1.incBy(42);
      expect(c2.get()).toBe(42);
    });

    it('labels order does not affect identity', () => {
      const registry = new MetricsRegistry();
      const c1 = registry.counter('test', { a: '1', b: '2' });
      const c2 = registry.counter('test', { b: '2', a: '1' });

      c1.inc();
      expect(c2.get()).toBe(1);
    });
  });

  // ── Snapshot ──

  describe('Snapshot', () => {
    it('snapshot() returns correct MetricPoints for counters', () => {
      const registry = new MetricsRegistry();
      const c = registry.counter('http_requests', { method: 'GET' });
      c.incBy(10);

      const snapshot = registry.snapshot();
      expect(snapshot.points).toHaveLength(1);
      expect(snapshot.points[0].name).toBe('http_requests');
      expect(snapshot.points[0].type).toBe('counter');
      expect(snapshot.points[0].value).toBe(10);
      expect(snapshot.points[0].labels).toContainEqual({ key: 'method', value: 'GET' });
    });

    it('snapshot() returns correct MetricPoints for gauges', () => {
      const registry = new MetricsRegistry();
      const g = registry.gauge('cpu_usage', { host: 'server-1' });
      g.set(75.5);

      const snapshot = registry.snapshot();
      const gaugePoints = snapshot.points.filter(p => p.type === 'gauge');
      const cpuPoint = gaugePoints.find(p => p.name === 'cpu_usage');
      expect(cpuPoint).toBeDefined();
      expect(cpuPoint!.value).toBe(75.5);
    });

    it('snapshot() includes histogram count and sum', () => {
      const registry = new MetricsRegistry();
      const h = registry.histogram('latency_ms');
      h.observe(100);
      h.observe(200);

      const snapshot = registry.snapshot();
      const names = snapshot.points.map(p => p.name);
      expect(names).toContain('latency_ms_count');
      expect(names).toContain('latency_ms_sum');

      const countPoint = snapshot.points.find(p => p.name === 'latency_ms_count')!;
      const sumPoint = snapshot.points.find(p => p.name === 'latency_ms_sum')!;
      expect(countPoint.value).toBe(2);
      expect(sumPoint.value).toBe(300);
    });

    it('snapshot() includes capturedAt timestamp', () => {
      const registry = new MetricsRegistry();
      registry.counter('test').inc();

      const snapshot = registry.snapshot();
      expect(snapshot.capturedAt).toBeGreaterThan(0);
      expect(typeof snapshot.capturedAt).toBe('number');
    });

    it('snapshot() points include labels for labeled metrics', () => {
      const registry = new MetricsRegistry();
      registry.counter('requests', { env: 'prod', service: 'api' }).inc();

      const snapshot = registry.snapshot();
      expect(snapshot.points[0].labels).toHaveLength(2);
    });

    it('snapshot() returns empty points for empty registry', () => {
      const registry = new MetricsRegistry();
      const snapshot = registry.snapshot();
      expect(snapshot.points).toHaveLength(0);
    });
  });
});
