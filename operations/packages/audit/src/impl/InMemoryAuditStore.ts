/**
 * InMemoryAuditStore — In-memory audit store for testing and development.
 *
 * @module @agentix-e/db-operations-audit/impl
 */

import { randomUUID } from 'node:crypto';
import type {
  IAuditStore,
  WriteAuditEntryOptions,
  AuditQueryFilter,
} from '../interfaces/index.js';
import type { AuditEntry } from '@agentix-e/db-operations-core/types';

/**
 * In-memory audit store that retains entries for query, export, and pruning.
 * Designed for testing and single-process deployments.
 */
export class InMemoryAuditStore implements IAuditStore {
  private entries = new Map<string, AuditEntry>();
  private ordered: AuditEntry[] = [];

  async write(options: WriteAuditEntryOptions): Promise<string> {
    const id = randomUUID();
    const entry: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      operation: options.operation,
      actor: options.actor,
      resource: options.resource,
      result: options.result,
      severity: options.severity ?? 'info',
      details: options.details,
      traceId: options.traceId,
    };
    this.entries.set(id, entry);
    this.ordered.push(entry);
    return id;
  }

  async query(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const filtered = this.ordered.filter((entry) => {
      if (filter.startTime && entry.timestamp < filter.startTime.toISOString()) {
        return false;
      }
      if (filter.endTime && entry.timestamp > filter.endTime.toISOString()) {
        return false;
      }
      if (filter.operation !== undefined && entry.operation !== filter.operation) {
        return false;
      }
      if (filter.actor !== undefined && entry.actor !== filter.actor) {
        return false;
      }
      if (filter.result !== undefined && entry.result !== filter.result) {
        return false;
      }
      if (filter.severity !== undefined && entry.severity !== filter.severity) {
        return false;
      }
      return true;
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return filtered.slice(offset, offset + limit);
  }

  async get(id: string): Promise<AuditEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async count(filter?: AuditQueryFilter): Promise<number> {
    if (!filter || Object.keys(filter).length === 0) {
      return this.ordered.length;
    }
    return (await this.query(filter)).length;
  }

  async pruneOlderThan(timestamp: Date): Promise<number> {
    const before = this.ordered.length;
    const keep: AuditEntry[] = [];
    const toRemove: string[] = [];

    for (const entry of this.ordered) {
      if (new Date(entry.timestamp) >= timestamp) {
        keep.push(entry);
      } else {
        toRemove.push(entry.id);
      }
    }

    for (const id of toRemove) {
      this.entries.delete(id);
    }

    this.ordered = keep;
    return before - keep.length;
  }
}
