import { describe, it, expect } from 'vitest';
import { InMemorySLACollector } from '../impl/InMemorySLACollector.js';

describe('InMemorySLACollector', () => {
  it('returns 100% compliance initially', () => {
    const col = new InMemorySLACollector();
    expect(col.getSLACompliance().size).toBe(0);
  });

  it('returns 100% uptime initially', () => {
    const col = new InMemorySLACollector();
    expect(col.getUptime()).toBe(100);
  });

  it('records an event and sets violated flag correctly', () => {
    const col = new InMemorySLACollector();
    col.record({ timestamp: new Date(), metric: 'latency', value: 50, threshold: 100 });
    const violations = col.getViolations();
    expect(violations).toHaveLength(0);
  });

  it('marks as violated when value exceeds threshold', () => {
    const col = new InMemorySLACollector();
    col.record({ timestamp: new Date(), metric: 'latency', value: 200, threshold: 100 });
    const violations = col.getViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0].violated).toBe(true);
  });

  it('calculates compliance percentage per metric', () => {
    const col = new InMemorySLACollector();
    const now = new Date();
    col.record({ timestamp: now, metric: 'latency', value: 50, threshold: 100 });
    col.record({ timestamp: now, metric: 'latency', value: 60, threshold: 100 });
    col.record({ timestamp: now, metric: 'latency', value: 200, threshold: 100 });
    const compliance = col.getSLACompliance();
    expect(compliance.get('latency')).toBeCloseTo(66.67, 1);
  });

  it('filters violations by date', () => {
    const col = new InMemorySLACollector();
    const old = new Date('2020-01-01');
    const recent = new Date('2026-07-12');
    col.record({ timestamp: old, metric: 'latency', value: 200, threshold: 100 });
    col.record({ timestamp: recent, metric: 'latency', value: 300, threshold: 100 });
    const violations = col.getViolations(new Date('2026-01-01'));
    expect(violations).toHaveLength(1);
    expect(violations[0].timestamp).toEqual(recent);
  });

  it('calculates uptime correctly', () => {
    const col = new InMemorySLACollector();
    const now = new Date();
    for (let i = 0; i < 8; i++) {
      col.record({ timestamp: now, metric: 'uptime', value: 50, threshold: 100 });
    }
    for (let i = 0; i < 2; i++) {
      col.record({ timestamp: now, metric: 'uptime', value: 200, threshold: 100 });
    }
    expect(col.getUptime()).toBe(80);
  });

  it('getUptime includes events exactly at the since boundary', () => {
    const col = new InMemorySLACollector();
    const boundary = new Date('2026-07-12T00:00:00Z');
    const older = new Date('2026-07-11T00:00:00Z');

    // One non-violating event exactly AT the boundary, one older.
    col.record({ timestamp: boundary, metric: 'uptime', value: 50, threshold: 100 });
    col.record({ timestamp: older, metric: 'uptime', value: 50, threshold: 100 });

    // `since = boundary` should include the boundary event (>= semantics) and
    // exclude the older one → 1 event, 0 violations → 100% uptime.
    expect(col.getUptime(boundary)).toBe(100);
  });

  it('getUptime excludes events strictly before since', () => {
    const col = new InMemorySLACollector();
    const recent = new Date('2026-07-12T00:00:00Z');
    const older = new Date('2026-07-11T00:00:00Z');

    col.record({ timestamp: older, metric: 'uptime', value: 200, threshold: 100 });
    col.record({ timestamp: recent, metric: 'uptime', value: 50, threshold: 100 });

    // since = recent → only the recent (non-violating) event counts → 100%.
    expect(col.getUptime(recent)).toBe(100);
    // since before older → both count, 1 violation of 2 → 50%.
    expect(col.getUptime(new Date('2026-07-10T00:00:00Z'))).toBe(50);
  });

  it('returns multiple metric compliance', () => {
    const col = new InMemorySLACollector();
    col.record({ timestamp: new Date(), metric: 'latency', value: 50, threshold: 100 });
    col.record({ timestamp: new Date(), metric: 'error_rate', value: 1, threshold: 5 });
    const compliance = col.getSLACompliance();
    expect(compliance.size).toBe(2);
  });

  it('filters compliance by date', () => {
    const col = new InMemorySLACollector();
    col.record({ timestamp: new Date('2020-01-01'), metric: 'latency', value: 50, threshold: 100 });
    col.record({ timestamp: new Date('2026-07-12'), metric: 'latency', value: 200, threshold: 100 });
    const compliance = col.getSLACompliance(new Date('2026-01-01'));
    expect(compliance.get('latency')).toBe(0);
  });

  it('handles empty events for compliance', () => {
    const col = new InMemorySLACollector();
    const compliance = col.getSLACompliance(new Date());
    expect(compliance.size).toBe(0);
  });

  it('records multiple metrics independently', () => {
    const col = new InMemorySLACollector();
    col.record({ timestamp: new Date(), metric: 'latency', value: 50, threshold: 100 });
    col.record({ timestamp: new Date(), metric: 'throughput', value: 1000, threshold: 2000 });
    col.record({ timestamp: new Date(), metric: 'error_rate', value: 10, threshold: 5 });
    expect(col.getViolations()).toHaveLength(1);
    expect(col.getViolations()[0].metric).toBe('error_rate');
  });
});
