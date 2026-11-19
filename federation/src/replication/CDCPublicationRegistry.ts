/**
 * CDCPublicationRegistry — the CDC publication catalogue.
 *
 * Keeps the two maps that describe what is being captured:
 *   - createPublication: declare a named set of tables to track (and watch them)
 *   - dropPublication: remove a publication, unwatching tables nobody else reads
 *   - createSubscription: record a subscription and the DSN it targets
 *   - dropSubscription: remove a subscription
 *
 * It delivers nothing, and says so. It used to subscribe to the engine's change
 * stream and filter events into a loop whose body only held `continue` — the
 * class claimed to "deliver change events to the appropriate subscriptions"
 * while delivering none of them, and carried both `onSlotInvalid` and the
 * `fireSlotInvalid()` hook that existed only to make that event testable.
 *
 * Delivery lives elsewhere, in two shapes that do not overlap:
 *   - `CDCSubscriptionPump` — engine → per-subscription sink, resolved from the
 *     subscription's `targetDsn`. In-process fan-out to webhooks, queues and
 *     downstream consumers, ordered and at-most-once per subscription.
 *   - `ExactlyOnceCDCPipeline` — engine → outbox → transport → dedup. The
 *     cross-datacenter path, which owns checkpoints and replay.
 *
 * The catalogue stores the DSN and stops there; it is the pump that resolves
 * it, because resolving needs a factory and a factory belongs to the caller.
 */

import type { ICDCManager, ICDCPublication, CDCSubscription, ICDCEngine } from '../interfaces/replication/ICDCManager';

export type CDCPublicationRegistryConfig = {
  nodeId: string;
  engine: ICDCEngine;
};

export class CDCPublicationRegistry implements ICDCManager {
  private readonly engine: ICDCEngine;
  private readonly publications = new Map<string, ICDCPublication>();
  private readonly subscriptions = new Map<string, CDCSubscription>();

  constructor(config: CDCPublicationRegistryConfig) {
    this.engine = config.engine;
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

  /**
   * Record a subscription over a publication's tables.
   *
   * `operations` defaults to all three, which is what PostgreSQL's
   * `CREATE SUBSCRIPTION` gives you. It used to be *pinned* to all three with no
   * parameter at all, so the field could hold one value: a subscription that
   * wanted inserts and not deletes had no way to say so. `CDCSubscriptionPump`
   * reads it, so it is a decision the caller makes here.
   */
  async createSubscription(
    name: string,
    publicationName: string,
    targetDsn: string,
    operations: CDCSubscription['operations'] = ['insert', 'update', 'delete'],
  ): Promise<CDCSubscription> {
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
      operations: [...operations],
      targetDsn,
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
}
