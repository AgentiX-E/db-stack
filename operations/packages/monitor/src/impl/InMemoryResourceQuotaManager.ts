/**
 * InMemoryResourceQuotaManager — IResourceQuotaManager implementation.
 *
 * Manages resource quotas per role and checks resource usage against limits.
 * Supports memory, connection, and query rate limits.
 *
 * @module @agentix-e/db-operations-monitor/impl
 */

import type { IResourceQuota, IResourceQuotaManager, ResourceUsageSnapshot } from '../interfaces/index.js';

interface QuotaEntry {
  quota: IResourceQuota;
  usage: {
    cpu: number;
    memoryMB: number;
    connections: number;
    queryRate: number;
  };
}

interface ResourceQuotaConfig {
  maxMemoryMB?: number;
  maxQueriesPerSec?: number;
  maxConnections?: number;
}

interface ResourceUsage {
  memoryMB: number;
  queriesPerSec: number;
  connections: number;
}

/**
 * In-memory resource quota manager.
 */
export class InMemoryResourceQuotaManager implements IResourceQuotaManager {
  private _quotas = new Map<string, QuotaEntry>();
  private _config: Required<ResourceQuotaConfig> = {
    maxMemoryMB: 8192,
    maxQueriesPerSec: 1000,
    maxConnections: 200,
  };
  private _usage: ResourceUsage = {
    memoryMB: 0,
    queriesPerSec: 0,
    connections: 0,
  };

  // ── IResourceQuotaManager interface ──

  setQuota(roleId: string, quota: IResourceQuota): Promise<void> {
    this._quotas.set(roleId, {
      quota,
      usage: { cpu: 0, memoryMB: 0, connections: 0, queryRate: 0 },
    });
    return Promise.resolve();
  }

  getQuota(roleId: string): Promise<IResourceQuota | null> {
    const entry = this._quotas.get(roleId);
    return Promise.resolve(entry ? { ...entry.quota } : null);
  }

  checkQuota(roleId: string): Promise<{ allowed: boolean; reason?: string }> {
    const entry = this._quotas.get(roleId);
    if (!entry) {
      // No quota set = allow
      return Promise.resolve({ allowed: true });
    }

    const u = entry.usage;
    const q = entry.quota;

    if (u.cpu > q.cpuLimit) {
      return Promise.resolve({ allowed: false, reason: `CPU limit exceeded: ${u.cpu} > ${q.cpuLimit}` });
    }
    if (u.memoryMB > q.memoryLimitMB) {
      return Promise.resolve({ allowed: false, reason: `Memory limit exceeded: ${u.memoryMB} > ${q.memoryLimitMB}` });
    }
    if (u.connections > q.connectionLimit) {
      return Promise.resolve({ allowed: false, reason: `Connection limit exceeded: ${u.connections} > ${q.connectionLimit}` });
    }
    if (u.queryRate > q.queryRateLimit) {
      return Promise.resolve({ allowed: false, reason: `Query rate limit exceeded: ${u.queryRate} > ${q.queryRateLimit}` });
    }

    return Promise.resolve({ allowed: true });
  }

  getUsage(roleId: string): Promise<{ cpu: number; memoryMB: number; connections: number; queryRate: number }> {
    const entry = this._quotas.get(roleId);
    if (!entry) {
      return Promise.resolve({ cpu: 0, memoryMB: 0, connections: 0, queryRate: 0 });
    }
    return Promise.resolve({ ...entry.usage });
  }

  // ── Additional methods used by tests ──

  /**
   * Update global resource limits.
   */
  updateConfig(config: ResourceQuotaConfig): void {
    if (config.maxMemoryMB !== undefined) this._config.maxMemoryMB = config.maxMemoryMB;
    if (config.maxQueriesPerSec !== undefined) this._config.maxQueriesPerSec = config.maxQueriesPerSec;
    if (config.maxConnections !== undefined) this._config.maxConnections = config.maxConnections;
  }

  /**
   * Get current global config.
   */
  getConfig(): Required<ResourceQuotaConfig> {
    return { ...this._config };
  }

  /**
   * Check if a resource usage is within global limits.
   */
  checkResource(usage: ResourceUsage): { allowed: boolean; reason?: string } {
    if (usage.memoryMB > this._config.maxMemoryMB) {
      return { allowed: false, reason: 'memory' };
    }
    if (usage.queriesPerSec > this._config.maxQueriesPerSec) {
      return { allowed: false, reason: 'qps' };
    }
    if (usage.connections > this._config.maxConnections) {
      return { allowed: false, reason: 'connections' };
    }
    return { allowed: true };
  }

  /**
   * Get utilization snapshot.
   */
  getUtilization(): ResourceUsageSnapshot {
    return {
      memoryBytes: this._usage.memoryMB * 1024 * 1024,
      memoryLimitBytes: this._config.maxMemoryMB * 1024 * 1024,
      memoryUtilization: this._config.maxMemoryMB > 0
        ? this._usage.memoryMB / this._config.maxMemoryMB
        : 0,
      queriesPerSec: this._usage.queriesPerSec,
      maxQueriesPerSec: this._config.maxQueriesPerSec,
      cpuPercent: 0,
      connectionPool: {
        total: this._usage.connections,
        active: this._usage.connections,
        idle: 0,
        waiting: 0,
        maxSize: this._config.maxConnections,
        utilization: this._config.maxConnections > 0
          ? this._usage.connections / this._config.maxConnections
          : 0,
      },
      diskUsedBytes: 0,
      diskFreeBytes: 0,
    };
  }

  /**
   * Set current resource usage (for testing).
   */
  setUsage(usage: Partial<ResourceUsage>): void {
    if (usage.memoryMB !== undefined) this._usage.memoryMB = usage.memoryMB;
    if (usage.queriesPerSec !== undefined) this._usage.queriesPerSec = usage.queriesPerSec;
    if (usage.connections !== undefined) this._usage.connections = usage.connections;
  }

  /**
   * Set role usage for testing.
   */
  setRoleUsage(roleId: string, usage: Partial<{ cpu: number; memoryMB: number; connections: number; queryRate: number }>): void {
    const entry = this._quotas.get(roleId);
    if (entry) {
      if (usage.cpu !== undefined) entry.usage.cpu = usage.cpu;
      if (usage.memoryMB !== undefined) entry.usage.memoryMB = usage.memoryMB;
      if (usage.connections !== undefined) entry.usage.connections = usage.connections;
      if (usage.queryRate !== undefined) entry.usage.queryRate = usage.queryRate;
    }
  }

  /**
   * Clear all quotas.
   */
  clear(): void {
    this._quotas.clear();
    this._usage = { memoryMB: 0, queriesPerSec: 0, connections: 0 };
  }
}
