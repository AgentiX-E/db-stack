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

export interface ICDCManager {
  createPublication(name: string, tables: string[]): Promise<ICDCPublication>;
  dropPublication(name: string): Promise<void>;
  createSubscription(name: string, publicationName: string, targetDsn: string): Promise<CDCSubscription>;
  dropSubscription(name: string): Promise<void>;
  getSubscriptions(): Promise<CDCSubscription[]>;
  getPublications(): Promise<ICDCPublication[]>;
  /** Event: fires when a subscription's replication slot becomes invalid */
  onSlotInvalid(callback: (subscriptionId: string) => void): () => void;
}
