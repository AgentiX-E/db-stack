import type { EngineFactory } from './EngineFactory.js';
import type { IHealthProbe } from '../../../health/index.js';
import type { IMetricsRegistry } from '../../../metrics/index.js';
import type { IBackupManager, IStorageBackend, IBackupRetentionPolicy } from '../../../backup/index.js';
import type { IAuditStore } from '../../../audit/index.js';
import type { IDistributedTracer } from '../../../observability/index.js';
import type { IDeadlockDetector, ISlowQueryRecorder } from '../../../monitor/index.js';
import type { IMaintenanceExecutor } from '../../../maintenance/index.js';
import type { IAuthProvider } from '../../../auth/index.js';
import type { ILogger } from '../../../logger/index.js';

import { HealthOrchestrator, componentProbe } from '../../../health/index.js';
import { MetricsRegistry } from '../../../metrics/index.js';
import { InMemoryBackupManager, InMemoryStorageBackend, RetentionPolicyEvaluator } from '../../../backup/index.js';
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

export class InMemoryEngineFactory implements EngineFactory {
  private storage?: InMemoryStorageBackend;
  private logger?: InMemoryLogger;

  createHealthProbe(): IHealthProbe {
    return componentProbe('engine-probe', 'Engine Probe', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
  }

  createHealthOrchestrator(): HealthOrchestrator {
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
    return new RetentionPolicyEvaluator({
      maxFullSnapshots: 3,
      maxTotalBytes: 1_000_000_000,
    });
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

  createAlertRuleManager(): InMemoryAlertRuleManager {
    return new InMemoryAlertRuleManager();
  }

  createSlowQueryRecorder(): ISlowQueryRecorder {
    return new InMemorySlowQueryRecorder(100);
  }

  createConnectionMonitor(): InMemoryConnectionMonitor {
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
      validateToken: async (_token: string) => ({
        userId: 'test-user',
        roles: ['admin'],
      }),
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
