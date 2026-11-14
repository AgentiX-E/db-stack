import { describe, it, expect } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([
  { name: 'InMemory', factory: new InMemoryEngineFactory() },
])('$name e2e: Monitor', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create metrics registry', () => {
    const metrics = factory.createMetricsRegistry();
    const counter = metrics.counter('test_counter');
    counter.inc();
    expect(counter.get()).toBe(1);
  });

  it('should create gauges', () => {
    const metrics = factory.createMetricsRegistry();
    const gauge = metrics.gauge('test_gauge');
    gauge.set(42);
    expect(gauge.get()).toBe(42);
  });

  it('should create histograms', () => {
    const metrics = factory.createMetricsRegistry();
    const hist = metrics.histogram('latency_ms');
    hist.observe(10);
    hist.observe(20);
    expect(hist.getCount()).toBe(2);
  });

  it('should snapshot all metrics', () => {
    const metrics = factory.createMetricsRegistry();
    metrics.counter('counter_a').inc();
    metrics.gauge('gauge_b').set(100);
    const snap = metrics.snapshot();
    expect(snap.points.length).toBeGreaterThan(0);
  });

  it('should create deadlock detector', () => {
    const detector = factory.createDeadlockDetector();
    expect(detector).toBeDefined();
  });

  it('should create alert rule manager', () => {
    const rules = factory.createAlertRuleManager();
    expect(rules).toBeDefined();
  });

  it('should create slow query recorder', async () => {
    const recorder = factory.createSlowQueryRecorder();
    await recorder.record({ query: 'SELECT 1', durationMs: 200, timestamp: new Date(), database: 'test' });
    const queries = await recorder.getSlowQueries(50);
    expect(queries.length).toBeGreaterThan(0);
  });

  it('should create connection monitor', () => {
    const mon = factory.createConnectionMonitor();
    expect(mon).toBeDefined();
  });

  it('alert rules evaluate correctly', async () => {
    const rules = factory.createAlertRuleManager();
    await rules.createRule({
      name: 'High CPU', metric: 'cpu', condition: 'gt',
      threshold: 90, severity: 'critical', durationMs: 30000, enabled: true,
    });
    const alerts = rules.evaluateSnapshot({ cpu: 95 });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('critical');
  });

  it('counter with labels', () => {
    const metrics = factory.createMetricsRegistry();
    const counter = metrics.counter('ops', { db: 'main' });
    counter.incBy(5);
    expect(counter.get()).toBe(5);
  });

  it('histogram quantile approximation', () => {
    const metrics = factory.createMetricsRegistry();
    const hist = metrics.histogram('request_time', {}, [1, 5, 10, 50]);
    hist.observe(3);
    hist.observe(7);
    hist.observe(25);
    const median = hist.getQuantile(0.5);
    expect(typeof median).toBe('number');
  });

  it('connection monitor reports pool utilization', async () => {
    const mon = factory.createConnectionMonitor();
    mon.reportConnectionOpened('pool-main');
    mon.reportConnectionOpened('pool-main');
    mon.reportConnectionClosed('pool-main');
    const usage = await mon.getPoolUtilization();
    expect(usage.active).toBeDefined();
    expect(usage.total).toBeDefined();
  });

  it('deadlock detector can start and stop', async () => {
    const detector = factory.createDeadlockDetector();
    await detector.start();
    await detector.stop();
    const history = detector.getDeadlockHistory();
    const resolved = history instanceof Promise ? await history : history;
    expect(Array.isArray(resolved)).toBe(true);
  });

  it('should reset counter', () => {
    const metrics = factory.createMetricsRegistry();
    const counter = metrics.counter('resettable');
    counter.incBy(10);
    counter.reset();
    expect(counter.get()).toBe(0);
  });

  it('should gauge dec and inc', () => {
    const metrics = factory.createMetricsRegistry();
    const gauge = metrics.gauge('dynamic');
    gauge.set(50);
    gauge.add(5);
    expect(gauge.get()).toBe(55);
    gauge.add(-10);
    expect(gauge.get()).toBe(45);
  });

  it('should hist observe zero values', () => {
    const metrics = factory.createMetricsRegistry();
    const hist = metrics.histogram('zero_test');
    hist.observe(0);
    expect(hist.getCount()).toBe(1);
  });

  it('should record slow queries with different thresholds', async () => {
    const recorder = factory.createSlowQueryRecorder();
    await recorder.record({ query: 'SELECT *', durationMs: 500, timestamp: new Date(), database: 'db1' });
    await recorder.record({ query: 'UPDATE t', durationMs: 1000, timestamp: new Date(), database: 'db1' });
    const slow = await recorder.getSlowQueries(200);
    expect(slow.length).toBe(2);
  });

  it('should evaluate multiple rules with different severities', async () => {
    const rules = factory.createAlertRuleManager();
    await rules.createRule({ name: 'CPU', metric: 'cpu', condition: 'gt', threshold: 80, severity: 'warning', durationMs: 30000, enabled: true });
    await rules.createRule({ name: 'MEM', metric: 'mem', condition: 'gt', threshold: 90, severity: 'critical', durationMs: 30000, enabled: true });
    const alerts = rules.evaluateSnapshot({ cpu: 95, mem: 95 });
    expect(alerts.length).toBe(2);
  });

  it('should update and delete alert rules', async () => {
    const rules = factory.createAlertRuleManager();
    const id = await rules.createRule({ name: 'Test', metric: 'cpu', condition: 'gt', threshold: 80, durationMs: 30000, severity: 'warning', enabled: true });
    await rules.updateRule(id, { threshold: 90 });
    await expect(rules.deleteRule(id)).resolves.not.toThrow();
  });
});
