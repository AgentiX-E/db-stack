/**
 * InMemoryAuditStore — In-memory audit store for testing and development.
 *
 * @module @agentix-e/db-node/audit/impl
 */

import { randomUUID } from 'node:crypto';
import type { IAuditStore, WriteAuditEntryOptions, AuditQueryFilter } from '../interfaces/index.js';
import type { AuditTrailVerification } from '../interfaces/index.js';
import type { AuditEntry } from '../../core/types.js';
import { GENESIS_DIGEST, sealEntry, verifyTrail } from './auditChain.js';

/**
 * In-memory audit store that retains entries for query, export, and pruning.
 * Designed for testing and single-process deployments.
 *
 * It chains its entries exactly like the file store does, because the property
 * `IAuditStore.verify()` promises is a property of the contract and not of one
 * implementation: a deployment that swaps the store for a faster one must not
 * silently lose the answer to "how do you know nobody edited this".
 */
export class InMemoryAuditStore implements IAuditStore {
  private entries = new Map<string, AuditEntry>();
  private ordered: AuditEntry[] = [];
  private readonly writerId: string;
  private chainSeq = 0;
  private chainPrev: string = GENESIS_DIGEST;

  constructor(writerId?: string) {
    this.writerId = writerId ?? randomUUID();
  }

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
    const link = sealEntry(entry, this.writerId, this.chainSeq + 1, this.chainPrev);
    entry.chain = link;
    this.chainSeq = link.seq;
    this.chainPrev = link.hash;

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

  /**
   * Verify the chain over the entries this store still holds.
   *
   * Pruning removes a prefix, and a prefix is what a chain cannot prove: the first
   * entry still held starts a chain from wherever it is. That limit is the same one
   * the file store has, and it is stated in `verifyTrail` rather than papered over
   * here by pretending a pruned trail is a broken one.
   */
  async verify(): Promise<AuditTrailVerification> {
    return verifyTrail(this.ordered);
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
