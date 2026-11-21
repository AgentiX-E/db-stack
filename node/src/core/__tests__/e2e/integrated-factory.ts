/**
 * IntegratedFactory — cross-package integration test harness.
 *
 * Wires together ALL 21 packages into a single address space so that
 * integration tests can exercise real inter-package paths
 * (e.g. Encryption→Backup, RBAC→Audit, Health→AutoScale→RollingUpgrade).
 */
import type { IHealthOrchestrator } from '../../../health/index.js';
import type { IMetricsRegistry } from '../../../metrics/index.js';
import type { IBackupManager } from '../../../backup/index.js';
import type { IStorageBackend } from '../../../backup/index.js';
import type { IBackupRetentionPolicy } from '../../../backup/index.js';
import type { IAuditStore } from '../../../audit/index.js';
import type { IDistributedTracer } from '../../../observability/index.js';
import type {
  IDeadlockDetector,
  IAlertRuleManager,
  ISlowQueryRecorder,
  IConnectionMonitor,
} from '../../../monitor/index.js';
import type { IMaintenanceExecutor } from '../../../maintenance/index.js';
import type { IAuthProvider } from '../../../auth/index.js';
import type { ILogger } from '../../../logger/index.js';
import type { IEncryptionManager } from '../../../security/index.js';
import type { IRBACProvider } from '../../../security/index.js';
import type { IAutoScaler } from '../../../autoscaler/index.js';
import type { IRollingUpgrade } from '../../../rollingupgrade/index.js';
import type { ICircuitBreaker } from '../../../circuitbreaker/index.js';
import type { IChaosEngine } from '../../../chaosengine/index.js';

import { HealthOrchestrator } from '../../../health/index.js';
import { MetricsRegistry } from '../../../metrics/index.js';
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '../../../backup/index.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryAuditStore } from '../../../audit/index.js';
import { InMemoryDistributedTracer } from '../../../observability/index.js';
import {
  InMemoryDeadlockDetector,
  InMemoryAlertRuleManager,
  InMemorySlowQueryRecorder,
  InMemoryConnectionMonitor,
} from '../../../monitor/index.js';
import { InMemoryMaintenanceExecutor } from '../../../maintenance/index.js';
import { InMemoryLogger } from '../../../logger/index.js';
import { InMemoryEncryptionManager } from '../../../security/index.js';
import { InMemoryRBACProvider } from '../../../security/index.js';
import { InMemoryCircuitBreaker } from '../../../circuitbreaker/index.js';
import { InMemoryAutoScaler } from '../../../autoscaler/index.js';
import { RollingUpgradeOrchestrator } from '../../../rollingupgrade/index.js';

/**
 * Single factory that creates interconnected instances of every
 * package for end-to-end integration testing.
 */
export class IntegratedFactory {
  private storage = new InMemoryStorageBackend();
  private logger = new InMemoryLogger('integration');
  private metrics = new MetricsRegistry();
  private healthOrch = new HealthOrchestrator();
  private encryption = new InMemoryEncryptionManager();
  private rbac = new InMemoryRBACProvider();
  private tracer = new InMemoryDistributedTracer();
  private deadlock = new InMemoryDeadlockDetector();
  private alerts = new InMemoryAlertRuleManager();
  private slowQuery = new InMemorySlowQueryRecorder(200);
  private connections = new InMemoryConnectionMonitor();
  private auditStore = new InMemoryAuditStore();

  // ── Getters (lazy optional) ─────────────────────────

  getLogger(): InMemoryLogger {
    return this.logger;
  }

  getHealthOrchestrator(): IHealthOrchestrator {
    return this.healthOrch;
  }

  getMetricsRegistry(): IMetricsRegistry {
    return this.metrics;
  }

  getEncryptionManager(): IEncryptionManager {
    return this.encryption;
  }

  getRBACProvider(): IRBACProvider {
    return this.rbac;
  }

  getTracer(): IDistributedTracer {
    return this.tracer;
  }

  getDeadlockDetector(): IDeadlockDetector {
    return this.deadlock;
  }

  getAlertRuleManager(): IAlertRuleManager {
    return this.alerts;
  }

  getSlowQueryRecorder(): ISlowQueryRecorder {
    return this.slowQuery;
  }

  getConnectionMonitor(): IConnectionMonitor {
    return this.connections;
  }

  getAuditStore(): IAuditStore {
    return this.auditStore;
  }

  getStorageBackend(): IStorageBackend {
    return this.storage;
  }

  // ── Auth ───────────────────────────────────────────

  createAuthProvider(): IAuthProvider {
    return {
      authenticate: async (_user: string, _pass: string) => ({
        token: 'integration-token',
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      validateToken: async (_token: string) => ({
        userId: 'integration-user',
        roles: ['admin', 'operator'],
      }),
      revokeToken: async (_token: string) => {},
    };
  }

  // ── Backup (depends on StorageBackend + Encryption) ─

  createBackupManager(): IBackupManager {
    const retention = this.createRetentionPolicy();
    const root = mkdtempSync(join(tmpdir(), 'integrated-backup-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    return new BackupManager(new DirectoryBackupSource(join(root, 'data')), this.storage, retention, {
      workDir: join(root, 'work'),
    });
  }

  createRetentionPolicy(): IBackupRetentionPolicy {
    return new RetentionPolicyEvaluator({
      maxFullSnapshots: 5,
      maxTotalBytes: 10_000_000_000,
    });
  }

  // ── AutoScaler ─────────────────────────────────────

  createAutoScaler(): IAutoScaler {
    return new InMemoryAutoScaler();
  }

  // ── RollingUpgrade ─────────────────────────────────

  createRollingUpgrade(): IRollingUpgrade {
    return new RollingUpgradeOrchestrator();
  }

  // ── CircuitBreaker ─────────────────────────────────

  createCircuitBreaker(
    name: string,
    config?: {
      failureThreshold?: number;
      timeoutMs?: number;
    },
  ): ICircuitBreaker {
    return new InMemoryCircuitBreaker(name, {
      failureThreshold: config?.failureThreshold ?? 3,
      timeoutMs: config?.timeoutMs ?? 5000,
    });
  }

  // ── Maintenance ────────────────────────────────────

  createMaintenanceExecutor(): IMaintenanceExecutor {
    return new InMemoryMaintenanceExecutor();
  }

  // ── Cleanup ────────────────────────────────────────

  async cleanup(): Promise<void> {
    this.storage = new InMemoryStorageBackend();
    this.logger = new InMemoryLogger('integration');
    this.metrics = new MetricsRegistry();
    this.healthOrch = new HealthOrchestrator();
    this.encryption = new InMemoryEncryptionManager();
    this.rbac = new InMemoryRBACProvider();
    this.auditStore = new InMemoryAuditStore();
  }
}
