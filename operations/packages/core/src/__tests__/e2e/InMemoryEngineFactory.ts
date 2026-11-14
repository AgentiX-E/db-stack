import type { EngineFactory } from './EngineFactory.js';
import type { IHealthProbe, IHealthOrchestrator } from '@agentix-e/db-operations-health';
import type { IMetricsRegistry } from '@agentix-e/db-operations-metrics';
import type { IBackupManager, IStorageBackend, IBackupRetentionPolicy } from '@agentix-e/db-operations-backup';
import type { IAuditStore } from '@agentix-e/db-operations-audit';
import type { IDistributedTracer } from '@agentix-e/db-operations-observability';
import type { IDeadlockDetector, IAlertRuleManager, ISlowQueryRecorder, IConnectionMonitor } from '@agentix-e/db-operations-monitor';
import type { IMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';
import type { IAuthProvider } from '@agentix-e/db-operations-auth';
import type { ILogger } from '@agentix-e/db-operations-logger';

import { HealthOrchestrator, componentProbe } from '@agentix-e/db-operations-health';
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';
import { InMemoryBackupManager, InMemoryStorageBackend, RetentionPolicyEvaluator } from '@agentix-e/db-operations-backup';
import { InMemoryAuditStore } from '@agentix-e/db-operations-audit';
import { InMemoryDistributedTracer } from '@agentix-e/db-operations-observability';
import {
  InMemoryDeadlockDetector,
  InMemoryAlertRuleManager,
  InMemorySlowQueryRecorder,
  InMemoryConnectionMonitor,
} from '@agentix-e/db-operations-monitor';
import { InMemoryMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';
import { InMemoryLogger } from '@agentix-e/db-operations-logger';

export class InMemoryEngineFactory implements EngineFactory {
  private storage?: InMemoryStorageBackend;
  private logger?: InMemoryLogger;

  createHealthProbe(): IHealthProbe {
    return componentProbe('engine-probe', 'Engine Probe', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
  }

  createHealthOrchestrator(): IHealthOrchestrator {
    const orch = new HealthOrchestrator();
    orch.registerFunctional('probe', 'Default Probe', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    return orch;
  }

  createMetricsRegistry(): IMetricsRegistry {
    return new MetricsRegistry();
  }

  createBackupManager(): IBackupManager {
    const storage = this.createStorageBackend() as InMemoryStorageBackend;
    const retention = this.createRetentionPolicy();
    return new InMemoryBackupManager(storage, retention);
  }

  createStorageBackend(): IStorageBackend {
    if (!this.storage) {
      this.storage = new InMemoryStorageBackend();
    }
    return this.storage;
  }

  createRetentionPolicy(): IBackupRetentionPolicy {
    return new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1_000_000_000 });
  }

  createAuditStore(): IAuditStore {
    return new InMemoryAuditStore();
  }

  createDistributedTracer(): IDistributedTracer {
    return new InMemoryDistributedTracer();
  }

  createDeadlockDetector(): IDeadlockDetector {
    return new InMemoryDeadlockDetector();
  }

  createAlertRuleManager(): IAlertRuleManager {
    return new InMemoryAlertRuleManager();
  }

  createSlowQueryRecorder(): ISlowQueryRecorder {
    return new InMemorySlowQueryRecorder(100);
  }

  createConnectionMonitor(): IConnectionMonitor {
    return new InMemoryConnectionMonitor();
  }

  createMaintenanceExecutor(): IMaintenanceExecutor {
    return new InMemoryMaintenanceExecutor();
  }

  createAuthProvider(): IAuthProvider {
    // Return a simple auth provider for testing
    return {
      authenticate: async (_username: string, _password: string) => ({
        token: 'test-token',
        expiresAt: new Date(Date.now() + 3600000),
      }),
      validateToken: async (_token: string) => ({ userId: 'test-user', roles: ['admin'] }),
      revokeToken: async (_token: string) => {},
    };
  }

  createLogger(): ILogger {
    if (!this.logger) {
      this.logger = new InMemoryLogger('e2e-test');
    }
    return this.logger;
  }

  async cleanup(): Promise<void> {
    this.storage = undefined;
    this.logger = undefined;
  }
}
