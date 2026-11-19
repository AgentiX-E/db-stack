import type { IHLCTimestamp } from '../hlc/IHLCTimestamp';

export interface CDCChangeEvent {
  lsn: string;
  timestamp: IHLCTimestamp;
  tableName: string;
  operation: 'insert' | 'update' | 'delete';
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  txId: string;
}

export interface CDCSubscription {
  subscriptionId: string;
  tables: string[];
  operations: ('insert' | 'update' | 'delete')[];
  webhookUrl?: string;
  createdAt: number;
}

export interface ICDCEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Register a table for CDC tracking */
  watchTable(tableName: string): void;
  /** Unregister a table */
  unwatchTable(tableName: string): void;
  /** Get all watched tables */
  getWatchedTables(): string[];
  /** Event: fires on every CDC change */
  onChange(callback: (event: CDCChangeEvent) => void): () => void;
}

export interface ICDCPublication {
  publicationId: string;
  tables: string[];
  createdAt: number;
}

/**
 * The publication catalogue: which tables are tracked, and which subscriptions
 * read them.
 *
 * It carries no event stream. `onSlotInvalid` used to be declared here, and the
 * only thing that ever fired it was a test hook on the implementation: a slot
 * that goes invalid is a PostgreSQL event this package does not observe, so the
 * member was a promise with no source. Delivery of changes is
 * `ExactlyOnceCDCPipeline`'s job (engine → outbox → transport), not the
 * catalogue's.
 */
export interface ICDCManager {
  createPublication(name: string, tables: string[]): Promise<ICDCPublication>;
  dropPublication(name: string): Promise<void>;
  createSubscription(name: string, publicationName: string, targetDsn: string): Promise<CDCSubscription>;
  dropSubscription(name: string): Promise<void>;
  getSubscriptions(): Promise<CDCSubscription[]>;
  getPublications(): Promise<ICDCPublication[]>;
}
