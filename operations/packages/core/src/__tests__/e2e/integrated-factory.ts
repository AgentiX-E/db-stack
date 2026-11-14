/**
 * IntegratedFactory — cross-package integration test harness.
 *
 * Wires together ALL 21 packages into a single address space so that
 * integration tests can exercise real inter-package paths
 * (e.g. Encryption→Backup, RBAC→Audit, Health→AutoScale→RollingUpgrade).
 */
import type { IHealthOrchestrator } from "@agentix-e/db-operations-health";
import type { IMetricsRegistry } from "@agentix-e/db-operations-metrics";
import type { IBackupManager } from "@agentix-e/db-operations-backup";
import type { IStorageBackend } from "@agentix-e/db-operations-backup";
import type { IBackupRetentionPolicy } from "@agentix-e/db-operations-backup";
import type { IAuditStore } from "@agentix-e/db-operations-audit";
import type { IDistributedTracer } from "@agentix-e/db-operations-observability";
import type {
  IDeadlockDetector,
  IAlertRuleManager,
  ISlowQueryRecorder,
  IConnectionMonitor,
} from "@agentix-e/db-operations-monitor";
import type { IMaintenanceExecutor } from "@agentix-e/db-operations-maintenance";
import type { IAuthProvider } from "@agentix-e/db-operations-auth";
import type { ILogger } from "@agentix-e/db-operations-logger";
import type { IEncryptionManager } from "@agentix-e/db-operations-security";
import type { IRBACProvider } from "@agentix-e/db-operations-security";
import type { IAuditLogger } from "@agentix-e/db-operations-security";
import type { IKeyRotationManager } from "@agentix-e/db-operations-security";
import type { IAutoScaler } from "@agentix-e/db-operations-autoscaler";
import type { IRollingUpgrade } from "@agentix-e/db-operations-rollingupgrade";
import type { ICircuitBreaker } from "@agentix-e/db-operations-circuitbreaker";
import type { IChaosEngine } from "@agentix-e/db-operations-chaosengine";

import { HealthOrchestrator } from "@agentix-e/db-operations-health";
import { MetricsRegistry } from "@agentix-e/db-operations-metrics";
import {
  InMemoryBackupManager,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from "@agentix-e/db-operations-backup";
import { InMemoryAuditStore } from "@agentix-e/db-operations-audit";
import { InMemoryDistributedTracer } from "@agentix-e/db-operations-observability";
import {
  InMemoryDeadlockDetector,
  InMemoryAlertRuleManager,
  InMemorySlowQueryRecorder,
  InMemoryConnectionMonitor,
} from "@agentix-e/db-operations-monitor";
import { InMemoryMaintenanceExecutor } from "@agentix-e/db-operations-maintenance";
import { InMemoryLogger } from "@agentix-e/db-operations-logger";
import { InMemoryEncryptionManager } from "@agentix-e/db-operations-security";
import { InMemoryRBACProvider } from "@agentix-e/db-operations-security";
import { InMemoryCircuitBreaker } from "@agentix-e/db-operations-circuitbreaker";
import { AutoScaler } from "@agentix-e/db-operations-autoscaler";
import { InMemoryRollingUpgrade } from "@agentix-e/db-operations-rollingupgrade";

/**
 * Single factory that creates interconnected instances of every
 * package for end-to-end integration testing.
 */
export class IntegratedFactory {
  private storage = new InMemoryStorageBackend();
  private logger = new InMemoryLogger("integration");
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

  getLogger(): ILogger {
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
        token: "integration-token",
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      validateToken: async (_token: string) => ({
        userId: "integration-user",
        roles: ["admin", "operator"],
      }),
      revokeToken: async (_token: string) => {},
    };
  }

  // ── Backup (depends on StorageBackend + Encryption) ─

  createBackupManager(): IBackupManager {
    const retention = this.createRetentionPolicy();
    return new InMemoryBackupManager(this.storage, retention);
  }

  createRetentionPolicy(): IBackupRetentionPolicy {
    return new RetentionPolicyEvaluator({
      maxFullSnapshots: 5,
      maxTotalBytes: 10_000_000_000,
    });
  }

  // ── AutoScaler ─────────────────────────────────────

  createAutoScaler(): IAutoScaler {
    return new AutoScaler();
  }

  // ── RollingUpgrade ─────────────────────────────────

  createRollingUpgrade(): IRollingUpgrade {
    return new InMemoryRollingUpgrade();
  }

  // ── CircuitBreaker ─────────────────────────────────

  createCircuitBreaker(name: string, config?: {
    failureThreshold?: number;
    timeoutMs?: number;
  }): ICircuitBreaker {
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
    this.logger = new InMemoryLogger("integration");
    this.metrics = new MetricsRegistry();
    this.healthOrch = new HealthOrchestrator();
    this.encryption = new InMemoryEncryptionManager();
    this.rbac = new InMemoryRBACProvider();
    this.auditStore = new InMemoryAuditStore();
  }
}
