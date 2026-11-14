import { describe, it, expect, vi } from 'vitest';
import type {
  IMetricsRegistry,
  ISlowQueryRecorder,
  IAlertRuleManager,
  IHealthCheck,
  SlowQueryRecord,
  AlertRule,
  ComponentStatus,
  IDeadlockInfo,
  IDeadlockDetector,
  IConnectionInfo,
  IConnectionMonitor,
  IResourceQuota,
  IResourceQuotaManager,
} from '../interfaces/index.js';

describe('IMetricsRegistry', () => {
  const mockRegistry: IMetricsRegistry = {
    incrementCounter: vi.fn(),
    observeHistogram: vi.fn(),
    setGauge: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({ http_requests_total: 100 }),
    reset: vi.fn(),
  };

  it('should increment a counter', () => {
    mockRegistry.incrementCounter('http_requests_total', { method: 'GET' });
    expect(mockRegistry.incrementCounter).toHaveBeenCalledWith('http_requests_total', { method: 'GET' });
  });

  it('should observe a histogram value', () => {
    mockRegistry.observeHistogram('request_duration_ms', 150, { endpoint: '/api' });
    expect(mockRegistry.observeHistogram).toHaveBeenCalledWith('request_duration_ms', 150, { endpoint: '/api' });
  });

  it('should set a gauge', () => {
    mockRegistry.setGauge('active_connections', 42);
    expect(mockRegistry.setGauge).toHaveBeenCalledWith('active_connections', 42);
  });

  it('should take a snapshot', async () => {
    const snapshot = await mockRegistry.snapshot();
    expect(snapshot.http_requests_total).toBe(100);
  });

  it('should reset all metrics', () => {
    mockRegistry.reset();
    expect(mockRegistry.reset).toHaveBeenCalled();
  });
});

describe('ISlowQueryRecorder', () => {
  const createSlowQuery = (overrides: Partial<SlowQueryRecord> = {}): SlowQueryRecord => ({
    query: 'SELECT * FROM orders',
    durationMs: 2500,
    timestamp: new Date(),
    database: 'production',
    ...overrides,
  });

  const mockRecorder: ISlowQueryRecorder = {
    record: vi.fn().mockResolvedValue(undefined),
    getSlowQueries: vi.fn().mockResolvedValue([createSlowQuery()]),
    analyzePatterns: vi.fn().mockResolvedValue([
      { pattern: 'SELECT * FROM orders WHERE ...', averageDurationMs: 1200, count: 5, lastSeen: new Date() },
    ]),
  };

  it('should record a slow query', async () => {
    const query = createSlowQuery();
    await mockRecorder.record(query);
    expect(mockRecorder.record).toHaveBeenCalled();
  });

  it('should retrieve slow queries', async () => {
    const queries = await mockRecorder.getSlowQueries(1000);
    expect(queries[0].durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('should analyze query patterns', async () => {
    const patterns = await mockRecorder.analyzePatterns();
    expect(patterns[0]).toHaveProperty('pattern');
    expect(patterns[0]).toHaveProperty('averageDurationMs');
    expect(patterns[0]).toHaveProperty('count');
  });

  it('should create a valid slow query record', () => {
    const query = createSlowQuery();
    expect(query).toHaveProperty('query');
    expect(query).toHaveProperty('durationMs');
    expect(query).toHaveProperty('database');
  });
});

describe('IAlertRuleManager', () => {
  const mockRuleManager: IAlertRuleManager = {
    createRule: vi.fn().mockResolvedValue('rule-1'),
    updateRule: vi.fn().mockResolvedValue(undefined),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue([
      { ruleId: 'rule-1', ruleName: 'High CPU', severity: 'critical', value: 95, threshold: 90, triggeredAt: new Date(), message: 'CPU usage exceeded 90%' },
    ]),
    silenceRule: vi.fn().mockResolvedValue(undefined),
  };

  it('should create a rule', async () => {
    const rule: AlertRule = { name: 'High CPU', metric: 'cpu_usage', condition: 'gt', threshold: 90, durationMs: 60000, severity: 'critical', enabled: true };
    const id = await mockRuleManager.createRule(rule);
    expect(id).toBe('rule-1');
  });

  it('should update a rule', async () => {
    await expect(mockRuleManager.updateRule('rule-1', { threshold: 95 })).resolves.toBeUndefined();
  });

  it('should delete a rule', async () => {
    await expect(mockRuleManager.deleteRule('rule-1')).resolves.toBeUndefined();
  });

  it('should evaluate rules', async () => {
    const alerts = await mockRuleManager.evaluate();
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].value).toBeGreaterThan(alerts[0].threshold);
  });

  it('should silence a rule', async () => {
    await expect(mockRuleManager.silenceRule('rule-1', 300000)).resolves.toBeUndefined();
  });
});

describe('IHealthCheck', () => {
  const componentStatus: ComponentStatus = { name: 'database', healthy: true, message: 'OK', lastChecked: new Date(), latencyMs: 5 };

  const mockHealthCheck: IHealthCheck = {
    check: vi.fn().mockResolvedValue({ overall: true, components: [componentStatus], timestamp: new Date() }),
    getHistory: vi.fn().mockResolvedValue([
      { overall: true, components: [componentStatus], timestamp: new Date() },
    ]),
    registerComponent: vi.fn(),
  };

  it('should perform a health check', async () => {
    const result = await mockHealthCheck.check();
    expect(result.overall).toBe(true);
    expect(result.components[0].healthy).toBe(true);
  });

  it('should get health check history', async () => {
    const history = await mockHealthCheck.getHistory(5);
    expect(Array.isArray(history)).toBe(true);
  });

  it('should register a new component', () => {
    mockHealthCheck.registerComponent('cache', async () => ({ name: 'cache', healthy: true, message: 'OK', lastChecked: new Date(), latencyMs: 1 }));
    expect(mockHealthCheck.registerComponent).toHaveBeenCalled();
  });

  it('should create a valid component status', () => {
    expect(componentStatus).toHaveProperty('name');
    expect(componentStatus).toHaveProperty('healthy');
    expect(componentStatus).toHaveProperty('latencyMs');
  });
});

// ── Sprint 1.2: New Interface Tests ──

describe('IDeadlockInfo', () => {
  it('should create a valid deadlock info', () => {
    const info: IDeadlockInfo = {
      cycle: ['txn-001', 'txn-002', 'txn-003'],
      victimTransaction: 'txn-002',
      detectedAt: new Date(),
    };
    expect(Array.isArray(info.cycle)).toBe(true);
    expect(info.cycle.length).toBeGreaterThanOrEqual(2);
    expect(typeof info.victimTransaction).toBe('string');
    expect(info.detectedAt).toBeInstanceOf(Date);
  });

  it('should have all required properties', () => {
    const info: IDeadlockInfo = {
      cycle: ['txn-a', 'txn-b'],
      victimTransaction: 'txn-a',
      detectedAt: new Date(),
    };
    expect(info).toHaveProperty('cycle');
    expect(info).toHaveProperty('victimTransaction');
    expect(info).toHaveProperty('detectedAt');
  });
});

describe('IDeadlockDetector', () => {
  const mockDetector: IDeadlockDetector = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onDeadlock: vi.fn(),
    getDeadlockHistory: vi.fn().mockResolvedValue([
      { cycle: ['txn-1', 'txn-2'], victimTransaction: 'txn-1', detectedAt: new Date() },
    ]),
  };

  it('should start monitoring', async () => {
    await expect(mockDetector.start()).resolves.toBeUndefined();
  });

  it('should stop monitoring', async () => {
    await expect(mockDetector.stop()).resolves.toBeUndefined();
  });

  it('should register deadlock callback', () => {
    const callback = vi.fn();
    mockDetector.onDeadlock(callback);
    expect(mockDetector.onDeadlock).toHaveBeenCalledWith(callback);
  });

  it('should get deadlock history', async () => {
    const history = await mockDetector.getDeadlockHistory();
    expect(Array.isArray(history)).toBe(true);
    expect(history[0]).toHaveProperty('victimTransaction');
  });
});

describe('IConnectionInfo', () => {
  it('should create a valid connection info', () => {
    const info: IConnectionInfo = {
      id: 'conn-42',
      user: 'app_user',
      database: 'production',
      state: 'active',
      query: 'SELECT * FROM orders',
      connectedAt: new Date(),
      idleInTransaction: false,
    };
    expect(info.id).toBe('conn-42');
    expect(info.query).toBe('SELECT * FROM orders');
    expect(info.idleInTransaction).toBe(false);
  });

  it('should have all required properties', () => {
    const info: IConnectionInfo = {
      id: 'conn-1',
      user: 'admin',
      database: 'test',
      state: 'idle',
      connectedAt: new Date(),
      idleInTransaction: false,
    };
    expect(info).toHaveProperty('id');
    expect(info).toHaveProperty('user');
    expect(info).toHaveProperty('database');
    expect(info).toHaveProperty('state');
    expect(info).toHaveProperty('connectedAt');
    expect(info).toHaveProperty('idleInTransaction');
  });
});

describe('IConnectionMonitor', () => {
  const mockMonitor: IConnectionMonitor = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getConnections: vi.fn().mockResolvedValue([
      { id: 'conn-1', user: 'admin', database: 'prod', state: 'active', connectedAt: new Date(), idleInTransaction: false },
    ]),
    getPoolUtilization: vi.fn().mockResolvedValue({ total: 100, active: 45, idle: 55, waiting: 0 }),
    onExhaustion: vi.fn(),
  };

  it('should start monitoring', async () => {
    await expect(mockMonitor.start()).resolves.toBeUndefined();
  });

  it('should stop monitoring', async () => {
    await expect(mockMonitor.stop()).resolves.toBeUndefined();
  });

  it('should get connections', async () => {
    const connections = await mockMonitor.getConnections();
    expect(Array.isArray(connections)).toBe(true);
    expect(connections[0]).toHaveProperty('state');
  });

  it('should get pool utilization', async () => {
    const stats = await mockMonitor.getPoolUtilization();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('active');
    expect(stats).toHaveProperty('idle');
    expect(stats).toHaveProperty('waiting');
    expect(stats.total).toBe(stats.active + stats.idle + stats.waiting);
  });

  it('should register exhaust callback', () => {
    const callback = vi.fn();
    mockMonitor.onExhaustion(callback);
    expect(mockMonitor.onExhaustion).toHaveBeenCalledWith(callback);
  });
});

describe('IResourceQuota', () => {
  it('should create a valid resource quota', () => {
    const quota: IResourceQuota = {
      cpuLimit: 80,
      memoryLimitMB: 4096,
      connectionLimit: 50,
      queryRateLimit: 1000,
    };
    expect(quota.cpuLimit).toBe(80);
    expect(quota.memoryLimitMB).toBe(4096);
  });

  it('should have all required properties', () => {
    const quota: IResourceQuota = {
      cpuLimit: 50,
      memoryLimitMB: 2048,
      connectionLimit: 25,
      queryRateLimit: 500,
    };
    expect(quota).toHaveProperty('cpuLimit');
    expect(quota).toHaveProperty('memoryLimitMB');
    expect(quota).toHaveProperty('connectionLimit');
    expect(quota).toHaveProperty('queryRateLimit');
  });
});

describe('IResourceQuotaManager', () => {
  const mockQuotaManager: IResourceQuotaManager = {
    setQuota: vi.fn().mockResolvedValue(undefined),
    getQuota: vi.fn().mockImplementation(async (roleId: string) =>
      roleId === 'admin' ? { cpuLimit: 80, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 } : null
    ),
    checkQuota: vi.fn().mockResolvedValue({ allowed: true }),
    getUsage: vi.fn().mockResolvedValue({ cpu: 45, memoryMB: 2048, connections: 20, queryRate: 500 }),
  };

  it('should set a quota', async () => {
    const quota: IResourceQuota = { cpuLimit: 80, memoryLimitMB: 4096, connectionLimit: 50, queryRateLimit: 1000 };
    await expect(mockQuotaManager.setQuota('admin', quota)).resolves.toBeUndefined();
  });

  it('should get a quota for existing role', async () => {
    const quota = await mockQuotaManager.getQuota('admin');
    expect(quota).not.toBeNull();
    expect(quota!.connectionLimit).toBe(50);
  });

  it('should return null for non-existent role', async () => {
    const quota = await mockQuotaManager.getQuota('nonexistent');
    expect(quota).toBeNull();
  });

  it('should check quota', async () => {
    const result = await mockQuotaManager.checkQuota('admin');
    expect(result).toHaveProperty('allowed');
    expect(result.allowed).toBe(true);
  });

  it('should get current usage', async () => {
    const usage = await mockQuotaManager.getUsage('admin');
    expect(usage).toHaveProperty('cpu');
    expect(usage).toHaveProperty('memoryMB');
    expect(usage).toHaveProperty('connections');
    expect(usage).toHaveProperty('queryRate');
  });
});
