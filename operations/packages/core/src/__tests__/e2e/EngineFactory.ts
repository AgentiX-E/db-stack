import type { IHealthProbe } from '@agentix-e/db-operations-health';
import type { IHealthOrchestrator } from '@agentix-e/db-operations-health';
import type { IMetricsRegistry } from '@agentix-e/db-operations-metrics';
import type { IBackupManager } from '@agentix-e/db-operations-backup';
import type { IStorageBackend } from '@agentix-e/db-operations-backup';
import type { IBackupRetentionPolicy } from '@agentix-e/db-operations-backup';
import type { IAuditStore } from '@agentix-e/db-operations-audit';
import type { IDistributedTracer } from '@agentix-e/db-operations-observability';
import type { IDeadlockDetector } from '@agentix-e/db-operations-monitor';
import type { IAlertRuleManager } from '@agentix-e/db-operations-monitor';
import type { ISlowQueryRecorder } from '@agentix-e/db-operations-monitor';
import type { IConnectionMonitor } from '@agentix-e/db-operations-monitor';
import type { IMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';
import type { IAuthProvider } from '@agentix-e/db-operations-auth';
import type { ILogger } from '@agentix-e/db-operations-logger';

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
