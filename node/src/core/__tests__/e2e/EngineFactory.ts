import type { IHealthProbe, IHealthOrchestrator } from '../../../health/index.js';
import type { IMetricsRegistry } from '../../../metrics/index.js';
import type { IBackupManager } from '../../../backup/index.js';
import type { IStorageBackend } from '../../../backup/index.js';
import type { IBackupRetentionPolicy } from '../../../backup/index.js';
import type { IAuditStore } from '../../../audit/index.js';
import type { IDistributedTracer } from '../../../observability/index.js';
import type { IDeadlockDetector } from '../../../monitor/index.js';
import type { IAlertRuleManager } from '../../../monitor/index.js';
import type { ISlowQueryRecorder } from '../../../monitor/index.js';
import type { IConnectionMonitor } from '../../../monitor/index.js';
import type { IMaintenanceExecutor } from '../../../maintenance/index.js';
import type { IAuthProvider } from '../../../auth/index.js';
import type { ILogger } from '../../../logger/index.js';

export interface EngineFactory {
  createHealthProbe(): IHealthProbe;
  createHealthOrchestrator(): IHealthOrchestrator;
  createMetricsRegistry(): IMetricsRegistry;
  createBackupManager(): IBackupManager;
  createStorageBackend(): IStorageBackend;
  createRetentionPolicy(): IBackupRetentionPolicy;
  createAuditStore(): IAuditStore;
  createDistributedTracer(): IDistributedTracer;
  createDeadlockDetector(): IDeadlockDetector;
  createAlertRuleManager(): IAlertRuleManager;
  createSlowQueryRecorder(): ISlowQueryRecorder;
  createConnectionMonitor(): IConnectionMonitor;
  createMaintenanceExecutor(): IMaintenanceExecutor;
  createAuthProvider(): IAuthProvider;
  createLogger(): ILogger;
  cleanup(): Promise<void>;
}
