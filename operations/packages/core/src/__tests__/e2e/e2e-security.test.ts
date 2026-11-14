import { describe, it, expect } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([
  { name: 'InMemory', factory: new InMemoryEngineFactory() },
])('$name e2e: Security', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create an auth provider that authenticates', async () => {
    const auth = factory.createAuthProvider();
    const result = await auth.authenticate('user', 'pass');
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('should validate token', async () => {
    const auth = factory.createAuthProvider();
    const info = await auth.validateToken('some-token');
    expect(info.userId).toBe('test-user');
    expect(info.roles).toContain('admin');
  });

  it('should revoke token without error', async () => {
    const auth = factory.createAuthProvider();
    await expect(auth.revokeToken('some-token')).resolves.not.toThrow();
  });

  it('should create audit store', () => {
    const store = factory.createAuditStore();
    expect(store).toBeDefined();
  });

  it('should write audit entries', async () => {
    const store = factory.createAuditStore();
    const id = await store.write({
      operation: 'USER_LOGIN',
      actor: 'alice',
      resource: 'auth',
      result: 'success',
    });
    expect(id).toBeTruthy();
  });

  it('should query audit entries', async () => {
    const store = factory.createAuditStore();
    await store.write({ operation: 'BACKUP', actor: 'system', resource: 'backup', result: 'success' });
    const entries = await store.query({});
    expect(entries.length).toBeGreaterThan(0);
  });

  it('should get audit entry by ID', async () => {
    const store = factory.createAuditStore();
    const id = await store.write({ operation: 'TEST', actor: 'tester', resource: 'test', result: 'success' });
    const entry = await store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
  });

  it('should count audit entries', async () => {
    const store = factory.createAuditStore();
    await store.write({ operation: 'OP1', actor: 'a', resource: 'r', result: 'success' });
    await store.write({ operation: 'OP2', actor: 'b', resource: 'r', result: 'failure' });
    const count = await store.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('should prune old audit entries', async () => {
    const store = factory.createAuditStore();
    await store.write({ operation: 'OLD', actor: 'sys', resource: 'r', result: 'success' });
    const oldDate = new Date('2020-01-01');
    const pruned = await store.pruneOlderThan(oldDate);
    expect(typeof pruned).toBe('number');
  });

  it('should create maintenance executor', () => {
    const maint = factory.createMaintenanceExecutor();
    expect(maint).toBeDefined();
  });

  it('should run vacuum on maintenance executor', async () => {
    const maint = factory.createMaintenanceExecutor();
    const result = await maint.vacuum({ target: '*' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('VACUUM');
  });

  it('should run analyze', async () => {
    const maint = factory.createMaintenanceExecutor();
    const result = await maint.analyze({ target: '*' });
    expect(result.success).toBe(true);
  });

  it('should run reindex', async () => {
    const maint = factory.createMaintenanceExecutor();
    const result = await maint.reindex({ target: '*' });
    expect(result.success).toBe(true);
  });

  it('should count audit entries with filter', async () => {
    const audit = factory.createAuditStore();
    const c1 = await audit.count({ actor: 'nobody' });
    expect(typeof c1).toBe('number');
  });

  it('should query audit with limit', async () => {
    const audit = factory.createAuditStore();
    await audit.write({ operation: 'OP1', actor: 'a', resource: 'r', result: 'success' });
    await audit.write({ operation: 'OP2', actor: 'a', resource: 'r', result: 'success' });
    const entries = await audit.query({ limit: 1 });
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('should prune with zero result for recent dates', async () => {
    const audit = factory.createAuditStore();
    const future = new Date('2099-01-01');
    const pruned = await audit.pruneOlderThan(future);
    expect(pruned).toBe(0);
  });

  it('should handle audit query with unknown actor', async () => {
    const audit = factory.createAuditStore();
    const entries = await audit.query({ actor: 'unknown' });
    expect(Array.isArray(entries)).toBe(true);
  });
});
