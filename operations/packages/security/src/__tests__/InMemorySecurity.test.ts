import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryTLSManager } from '../impl/InMemoryTLSManager.js';
import { InMemoryCertMonitor } from '../impl/InMemoryCertMonitor.js';
import { InMemoryEncryptionManager } from '../impl/InMemoryEncryptionManager.js';
import { InMemoryRBACProvider } from '../impl/InMemoryRBACProvider.js';
import { InMemoryRateLimiter } from '../impl/InMemoryRateLimiter.js';
import { InMemorySCIMSyncProvider } from '../impl/InMemorySCIMSyncProvider.js';
import { InMemorySecurityCompliance } from '../impl/InMemorySecurityCompliance.js';
import type { TLSConfig, EncryptionConfig, Role, Identity, Permission } from '../interfaces/index.js';
import type { SecurityCheck } from '@agentix-e/db-operations-core/types';

// ──────────────────────────────────────────────
// InMemoryTLSManager
// ──────────────────────────────────────────────
describe('InMemoryTLSManager', () => {
  const config: TLSConfig = {
    certPath: '/etc/certs/server.crt',
    keyPath: '/etc/certs/server.key',
  };

  it('loadConfig sets cert info (S1)', async () => {
    const mgr = new InMemoryTLSManager();
    await mgr.loadConfig(config);
    const info = await mgr.getCertInfo();
    expect(info).toBeDefined();
    expect(info.subject).toBe('CN=localhost');
    expect(info.path).toBe('/etc/certs/server.crt');
    expect(info.daysRemaining).toBeGreaterThan(0);
  });

  it('reloadCerts updates cert metadata (S2)', async () => {
    const mgr = new InMemoryTLSManager();
    await mgr.loadConfig(config);
    const before = await mgr.getCertInfo();
    await mgr.reloadCerts();
    const after = await mgr.getCertInfo();
    expect(after.serialNumber).not.toBe(before.serialNumber);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.path).toBe(before.path); // same path, different meta
  });

  it('getCertInfo throws when no config loaded', async () => {
    const mgr = new InMemoryTLSManager();
    await expect(mgr.getCertInfo()).rejects.toThrow('no config loaded');
  });

  it('reloadCerts throws when no config loaded', async () => {
    const mgr = new InMemoryTLSManager();
    await expect(mgr.reloadCerts()).rejects.toThrow('no config loaded');
  });
});

// ──────────────────────────────────────────────
// InMemoryCertMonitor
// ──────────────────────────────────────────────
describe('InMemoryCertMonitor', () => {
  let monitor: InMemoryCertMonitor;
  let certInfo: import('@agentix-e/db-operations-core/types').CertInfo;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new InMemoryCertMonitor();
    certInfo = {
      subject: 'CN=test',
      issuer: 'CN=CA',
      serialNumber: 'SERIAL001',
      validFrom: new Date(Date.now() - 86400000 * 100).toISOString(),
      validTo: new Date(Date.now() + 86400000 * 10).toISOString(),
      daysRemaining: 10,
      path: '/certs/test.crt',
      fingerprint: 'sha256$$cert001',
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onWarning fires after start when cert level is not ok (S3)', () => {
    monitor.addExpiryStatus(certInfo, 'warning');
    const callback = vi.fn();
    monitor.onWarning(callback);
    monitor.start(100);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledWith(certInfo, 'warning');
  });

  it('stop clears expiry status (S4)', () => {
    monitor.addExpiryStatus(certInfo, 'critical');
    monitor.stop();
    expect(monitor.getExpiryStatus()).toHaveLength(0);
  });

  it('stop prevents further checks', () => {
    monitor.addExpiryStatus(certInfo, 'warning');
    const callback = vi.fn();
    monitor.onWarning(callback);
    monitor.start(100);
    monitor.stop();
    vi.advanceTimersByTime(200);
    expect(callback).not.toHaveBeenCalled();
  });

  it('getExpiryStatus returns entries', () => {
    monitor.addExpiryStatus(certInfo, 'ok');
    expect(monitor.getExpiryStatus()).toHaveLength(1);
    expect(monitor.getExpiryStatus()[0].level).toBe('ok');
  });

  it('onWarning returns unsubscribe function', () => {
    const callback = vi.fn();
    const unsub = monitor.onWarning(callback);
    unsub();
    monitor.addExpiryStatus(certInfo, 'critical');
    monitor.start(100);
    vi.advanceTimersByTime(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it('autoRenew returns true', async () => {
    const result = await monitor.autoRenew();
    expect(result).toBe(true);
  });

  it('start is idempotent', () => {
    monitor.start(100);
    monitor.start(100);
    // No error
  });
});

// ──────────────────────────────────────────────
// InMemoryEncryptionManager
// ──────────────────────────────────────────────
describe('InMemoryEncryptionManager', () => {
  const config: EncryptionConfig = {
    algorithm: 'aes-256-gcm',
    keyDerivation: 'pbkdf2',
  };

  it('encrypt/decrypt round-trip (decrypt(encrypt(X)) === X) (S5)', async () => {
    const mgr = new InMemoryEncryptionManager();
    await mgr.initialize(config);
    const plaintext = Buffer.from('Hello, Security!');
    const ciphertext = await mgr.encrypt(plaintext);
    const decrypted = await mgr.decrypt(ciphertext);
    expect(decrypted.toString()).toBe('Hello, Security!');
  });

  it('isEnabled returns true after initialization (S6)', async () => {
    const mgr = new InMemoryEncryptionManager();
    expect(mgr.isEnabled()).toBe(false);
    await mgr.initialize(config);
    expect(mgr.isEnabled()).toBe(true);
  });

  it('isEnabled returns false before initialization', () => {
    const mgr = new InMemoryEncryptionManager();
    expect(mgr.isEnabled()).toBe(false);
  });

  it('encrypt throws when not initialized', async () => {
    const mgr = new InMemoryEncryptionManager();
    await expect(mgr.encrypt(Buffer.from('test'))).rejects.toThrow('not initialized');
  });

  it('rotateKey changes key and increments version (S18)', async () => {
    const mgr = new InMemoryEncryptionManager();
    await mgr.initialize(config);
    const keyBefore = Buffer.from(mgr.getKey());
    const versionBefore = mgr.getKeyVersion();

    await mgr.rotateKey();

    const keyAfter = mgr.getKey();
    const versionAfter = mgr.getKeyVersion();

    expect(versionAfter).toBe(versionBefore + 1);
    expect(keyAfter.equals(keyBefore)).toBe(false);
  });

  it('encrypt produces different output for repeated calls (random key per init)', async () => {
    // Different manager instances have different keys via randomBytes
    const mgr1 = new InMemoryEncryptionManager();
    await mgr1.initialize(config);
    const mgr2 = new InMemoryEncryptionManager();
    await mgr2.initialize(config);

    const pt = Buffer.from('same data');
    const ct1 = await mgr1.encrypt(pt);
    const ct2 = await mgr2.encrypt(pt);
    // Different keys → different ciphertext
    expect(ct1.equals(ct2)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// InMemoryRBACProvider
// ──────────────────────────────────────────────
describe('InMemoryRBACProvider', () => {
  it('hasPermission returns correct result (S7)', () => {
    const rbac = new InMemoryRBACProvider();
    const readRole: Role = {
      name: 'reader',
      permissions: [{ resource: 'users', action: 'read' }],
    };
    rbac.registerRole(readRole);

    const identity: Identity = {
      id: 'user-1',
      roles: ['reader'],
    };

    expect(
      rbac.hasPermission(identity, { resource: 'users', action: 'read' }),
    ).toBe(true);
    expect(
      rbac.hasPermission(identity, { resource: 'users', action: 'delete' }),
    ).toBe(false);
  });

  it('registerRole + getRoles lifecycle (S8)', () => {
    const rbac = new InMemoryRBACProvider();
    expect(rbac.getRoles()).toHaveLength(0);

    const role: Role = {
      name: 'admin',
      permissions: [
        { resource: 'users', action: 'admin' },
        { resource: 'config', action: 'admin' },
      ],
    };
    rbac.registerRole(role);

    const roles = rbac.getRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('admin');
    expect(roles[0].permissions).toHaveLength(2);
  });

  it('identity with multiple roles gets union permissions (S19)', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'users', action: 'read' }] });
    rbac.registerRole({ name: 'editor', permissions: [{ resource: 'users', action: 'update' }] });

    const identity: Identity = { id: 'user-2', roles: ['reader', 'editor'] };

    const perms = rbac.getPermissions(identity);
    expect(perms).toHaveLength(2);
    expect(perms.find((p) => p.resource === 'users' && p.action === 'read')).toBeDefined();
    expect(perms.find((p) => p.resource === 'users' && p.action === 'update')).toBeDefined();
  });

  it('registerRole overwrites existing role', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'role1', permissions: [{ resource: 'a', action: 'read' }] });
    rbac.registerRole({ name: 'role1', permissions: [{ resource: 'b', action: 'delete' }] });
    const roles = rbac.getRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].permissions[0].resource).toBe('b');
  });

  it('hasPermission returns false for unknown identity roles', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'users', action: 'read' }] });
    const identity: Identity = { id: 'unknown', roles: ['nonexistent'] };
    expect(rbac.hasPermission(identity, { resource: 'users', action: 'read' })).toBe(false);
  });

  it('getPermissions deduplicates across roles', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'r1', permissions: [{ resource: 'x', action: 'read' }] });
    rbac.registerRole({ name: 'r2', permissions: [{ resource: 'x', action: 'read' }] });
    const identity: Identity = { id: 'u', roles: ['r1', 'r2'] };
    const perms = rbac.getPermissions(identity);
    expect(perms).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
// InMemoryRateLimiter
// ──────────────────────────────────────────────
describe('InMemoryRateLimiter', () => {
  const config = { maxRequests: 3, windowMs: 1000 };

  it('allows under limit (S10)', () => {
    const limiter = new InMemoryRateLimiter();
    const r1 = limiter.check('key-a', config);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('key-a', config);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it('blocks over maxRequests (S9)', () => {
    const limiter = new InMemoryRateLimiter();
    limiter.check('key-b', config); // 1
    limiter.check('key-b', config); // 2
    limiter.check('key-b', config); // 3
    const r4 = limiter.check('key-b', config);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetMs).toBeGreaterThanOrEqual(0);
  });

  it('resets after window (S11)', () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter();
    limiter.check('key-c', config); // 1
    limiter.check('key-c', config); // 2
    limiter.check('key-c', config); // 3
    vi.advanceTimersByTime(1001);

    const r = limiter.check('key-c', config);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
    vi.useRealTimers();
  });

  it('reset clears tracking for key (S17)', () => {
    const limiter = new InMemoryRateLimiter();
    limiter.check('key-d', config);
    limiter.check('key-d', config);
    limiter.check('key-d', config);

    const r4 = limiter.check('key-d', config);
    expect(r4.allowed).toBe(false);

    limiter.reset('key-d');
    const r5 = limiter.check('key-d', config);
    expect(r5.allowed).toBe(true);
    expect(r5.remaining).toBe(2);
  });

  it('different keys have independent windows', () => {
    const limiter = new InMemoryRateLimiter();
    limiter.check('key-e', { maxRequests: 1, windowMs: 60000 });
    const r1 = limiter.check('key-e', { maxRequests: 1, windowMs: 60000 });
    expect(r1.allowed).toBe(false);

    const r2 = limiter.check('key-f', { maxRequests: 1, windowMs: 60000 });
    expect(r2.allowed).toBe(true);
  });

  it('uses default config when none provided', () => {
    const limiter = new InMemoryRateLimiter();
    const r = limiter.check('default-key');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9); // default maxRequests=10
  });
});

// ──────────────────────────────────────────────
// InMemorySCIMSyncProvider
// ──────────────────────────────────────────────
describe('InMemorySCIMSyncProvider', () => {
  it('syncUsers returns counts (S12)', async () => {
    const sync = new InMemorySCIMSyncProvider();
    const result = await sync.syncUsers();
    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('getLastSyncTime returns Date after sync (S13)', async () => {
    const sync = new InMemorySCIMSyncProvider();
    expect(sync.getLastSyncTime()).toBeNull();
    await sync.syncUsers();
    expect(sync.getLastSyncTime()).toBeInstanceOf(Date);
  });

  it('second sync returns updated count', async () => {
    const sync = new InMemorySCIMSyncProvider();
    await sync.syncUsers();
    const result = await sync.syncUsers();
    expect(result.added).toBe(0);
    expect(result.updated).toBe(3);
    expect(result.removed).toBe(0);
  });

  it('fullResync sets lastSync to now', async () => {
    const sync = new InMemorySCIMSyncProvider();
    await sync.fullResync();
    expect(sync.getLastSyncTime()).toBeInstanceOf(Date);
  });

  it('fullResync allows subsequent syncUsers to return fresh counts', async () => {
    const sync = new InMemorySCIMSyncProvider();
    await sync.syncUsers();
    await sync.fullResync();
    const result = await sync.syncUsers();
    // After fullResync, users exist so syncUsers returns updated
    expect(result.updated).toBe(3);
  });
});

// ──────────────────────────────────────────────
// InMemorySecurityCompliance
// ──────────────────────────────────────────────
describe('InMemorySecurityCompliance', () => {
  const checks: SecurityCheck[] = [
    {
      id: 'TLS-001',
      category: 'tls',
      description: 'TLS 1.2 or higher enabled',
      severity: 'PASS',
      message: 'OK',
      timestamp: '',
    },
    {
      id: 'TLS-002',
      category: 'tls',
      description: 'Certificate not expired',
      severity: 'PASS',
      message: 'OK',
      timestamp: '',
    },
    {
      id: 'AUTH-001',
      category: 'auth',
      description: 'MFA enabled',
      severity: 'WARN',
      message: 'MFA not enforced',
      timestamp: '',
    },
    {
      id: 'ENC-001',
      category: 'encryption',
      description: 'Data at rest encryption',
      severity: 'FAIL',
      message: 'Not configured',
      timestamp: '',
    },
  ];

  it('runChecks returns non-empty array (S14)', async () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks(checks);
    const results = await comp.runChecks();
    expect(results).toHaveLength(4);
    expect(results[0].id).toBe('TLS-001');
  });

  it('runCategory filters correctly (S15)', async () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks(checks);
    const tlsResults = await comp.runCategory('tls');
    expect(tlsResults).toHaveLength(2);
    expect(tlsResults.every((c) => c.category === 'tls')).toBe(true);

    const authResults = await comp.runCategory('auth');
    expect(authResults).toHaveLength(1);
    expect(authResults[0].id).toBe('AUTH-001');
  });

  it('getScore returns 0-100 (S16)', () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks(checks);
    const score = comp.getScore();
    // PASS: 2*1 + WARN: 0.5 + FAIL: 0 = 2.5 / 4 * 100 = 62.5 → 63 (rounded)
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('getScore returns 100 for empty checks (no violations)', () => {
    const comp = new InMemorySecurityCompliance();
    expect(comp.getScore()).toBe(100);
  });

  it('getScore with all PASS returns 100', () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks([
      { id: 'C1', category: 'test', description: 'd', severity: 'PASS' as const, message: 'ok', timestamp: '' },
      { id: 'C2', category: 'test', description: 'd', severity: 'PASS' as const, message: 'ok', timestamp: '' },
    ]);
    expect(comp.getScore()).toBe(100);
  });

  it('getScore with all FAIL returns 0', () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks([
      { id: 'C1', category: 'test', description: 'd', severity: 'FAIL' as const, message: 'fail', timestamp: '' },
      { id: 'C2', category: 'test', description: 'd', severity: 'FAIL' as const, message: 'fail', timestamp: '' },
    ]);
    expect(comp.getScore()).toBe(0);
  });

  it('each runCheck produces fresh timestamp', async () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks([
      { id: 'C1', category: 'test', description: 'd', severity: 'PASS' as const, message: 'ok', timestamp: '' },
    ]);
    const results = await comp.runChecks();
    expect(results[0].timestamp).toBeTruthy();
    expect(new Date(results[0].timestamp).getTime()).not.toBeNaN();
  });

  it('runCategory returns empty array for unknown category', async () => {
    const comp = new InMemorySecurityCompliance();
    comp.registerChecks(checks);
    const results = await comp.runCategory('nonexistent');
    expect(results).toHaveLength(0);
  });
});
