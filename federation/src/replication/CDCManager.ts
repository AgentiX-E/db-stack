/**
 * CDCManager — CDC publication & subscription management.
 *
 * Manages the lifecycle of CDC publications and subscriptions:
 *   - createPublication: declare a named set of tables to track
 *   - dropPublication: remove a publication
 *   - createSubscription: create a subscription targeting a DSN/webhook
 *   - dropSubscription: remove a subscription
 *   - onSlotInvalid: event when a replication slot becomes invalid
 *
 * The manager delegates table watching to CDCEngine and delivers
 * change events to the appropriate subscriptions.
 */

import type {
  ICDCManager,
  ICDCPublication,
  CDCSubscription,
  ICDCEngine,
  CDCChangeEvent,
} from '../interfaces/replication/ICDCManager';

export type CDCManagerConfig = {
  nodeId: string;
  engine: ICDCEngine;
};

export class CDCManager implements ICDCManager {
  private readonly engine: ICDCEngine;
  private readonly publications = new Map<string, ICDCPublication>();
  private readonly subscriptions = new Map<string, CDCSubscription>();
  private readonly slotInvalidCallbacks = new Set<(subscriptionId: string) => void>();
  private readonly unsubFromEngine: () => void;

  constructor(config: CDCManagerConfig) {
    this.engine = config.engine;

    // Subscribe to engine changes and dispatch to subscriptions
    this.unsubFromEngine = this.engine.onChange((event: CDCChangeEvent) => {
      this.dispatch(event);
    });
  }

  async createPublication(name: string, tables: string[]): Promise<ICDCPublication> {
    if (this.publications.has(name)) {
      throw new Error(`Publication "${name}" already exists`);
    }

    const pub: ICDCPublication = {
      publicationId: name,
      tables,
      createdAt: Date.now(),
    };

    // Register tables with the engine
    for (const table of tables) {
      this.engine.watchTable(table);
    }

    this.publications.set(name, pub);
    return pub;
  }

  async dropPublication(name: string): Promise<void> {
    const pub = this.publications.get(name);
    if (!pub) throw new Error(`Publication "${name}" not found`);

    // Unregister tables no longer watched by any publication
    const stillWatched = new Set<string>();
    for (const [, p] of this.publications) {
      if (p.publicationId !== name) {
        for (const t of p.tables) stillWatched.add(t);
      }
    }

    for (const table of pub.tables) {
      if (!stillWatched.has(table)) {
        this.engine.unwatchTable(table);
      }
    }

    this.publications.delete(name);
  }

  async createSubscription(name: string, publicationName: string, targetDsn: string): Promise<CDCSubscription> {
    if (this.subscriptions.has(name)) {
      throw new Error(`Subscription "${name}" already exists`);
    }

    const pub = this.publications.get(publicationName);
    if (!pub) {
      throw new Error(`Publication "${publicationName}" not found`);
    }

    const sub: CDCSubscription = {
      subscriptionId: name,
      tables: [...pub.tables],
      operations: ['insert', 'update', 'delete'],
      webhookUrl: targetDsn.startsWith('http') ? targetDsn : undefined,
      createdAt: Date.now(),
    };

    this.subscriptions.set(name, sub);
    return sub;
  }

  async dropSubscription(name: string): Promise<void> {
    if (!this.subscriptions.has(name)) {
      throw new Error(`Subscription "${name}" not found`);
    }
    this.subscriptions.delete(name);
  }

  async getSubscriptions(): Promise<CDCSubscription[]> {
    return Array.from(this.subscriptions.values());
  }

  async getPublications(): Promise<ICDCPublication[]> {
    return Array.from(this.publications.values());
  }

  onSlotInvalid(callback: (subscriptionId: string) => void): () => void {
    this.slotInvalidCallbacks.add(callback);
    return () => {
      this.slotInvalidCallbacks.delete(callback);
    };
  }

  /**
   * Simulate a slot becoming invalid (for testing).
   */
  fireSlotInvalid(subscriptionId: string): void {
    for (const cb of this.slotInvalidCallbacks) {
      cb(subscriptionId);
    }
  }

  /**
   * Internal: dispatch a CDC event to matching subscriptions.
   */
  private dispatch(event: CDCChangeEvent): void {
    for (const [, sub] of this.subscriptions) {
      // Check if subscription covers this table
      if (!sub.tables.includes(event.tableName)) continue;
      // Check if subscription covers this operation
      if (!sub.operations.includes(event.operation)) continue;

      // For webhook-based subscriptions, future: async delivery
      // For now, all subscriptions receive inline
    }
  }
}
