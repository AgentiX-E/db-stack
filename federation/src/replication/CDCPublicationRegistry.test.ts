/**
 * CDCPublicationRegistry Tests — Publication & Subscription lifecycle.
 *
 * Coverage:
 *   - create/drop publication lifecycle
 *   - create/drop subscription lifecycle
 *   - the catalogue is not an event source (delivery belongs to the pipeline)
 *   - error on duplicate publication
 *   - error on non-existent publication
 *   - HLC timestamp ordering via engine
 *   - webhook subscription creation
 */

import { describe, it, expect, vi } from 'vitest';
import { CDCPublicationRegistry } from './CDCPublicationRegistry';
import { CDCEngine } from './CDCEngine';
import { HLC, makeHLC, compareHLC } from '../hlc/HLC';
import type { CDCChangeEvent } from '../interfaces/replication/ICDCManager';

describe('CDCPublicationRegistry — publication lifecycle', () => {
  it('should create a publication with tables', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    const pub = await manager.createPublication('pub-users', ['users', 'profiles']);
    expect(pub.publicationId).toBe('pub-users');
    expect(pub.tables).toEqual(['users', 'profiles']);
    expect(pub.createdAt).toBeGreaterThan(0);
  });

  it('should register tables with the engine on creation', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub-orders', ['orders', 'order_items']);

    expect(engine.getWatchedTables()).toContain('orders');
    expect(engine.getWatchedTables()).toContain('order_items');
  });

  it('should drop a publication and unregister tables', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub-a', ['table1', 'table2']);
    await manager.createPublication('pub-b', ['table2', 'table3']);

    expect(engine.getWatchedTables()).toContain('table1');
    expect(engine.getWatchedTables()).toContain('table2');
    expect(engine.getWatchedTables()).toContain('table3');

    // Drop pub-a; table1 should be unregistered since pub-a is the only
    // publication watching it. table2 should remain (watching by pub-b).
    await manager.dropPublication('pub-a');

    expect(engine.getWatchedTables()).not.toContain('table1');
    expect(engine.getWatchedTables()).toContain('table2');
    expect(engine.getWatchedTables()).toContain('table3');
  });

  it('should get all publications', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub-1', ['t1']);
    await manager.createPublication('pub-2', ['t2']);

    const pubs = await manager.getPublications();
    expect(pubs).toHaveLength(2);
    expect(pubs.map((p) => p.publicationId).sort()).toEqual(['pub-1', 'pub-2']);
  });

  it('should error on duplicate publication', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['t1']);
    await expect(manager.createPublication('pub', ['t2'])).rejects.toThrow('Publication "pub" already exists');
  });

  it('should error on dropping non-existent publication', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await expect(manager.dropPublication('nonexistent')).rejects.toThrow('Publication "nonexistent" not found');
  });
});

describe('CDCPublicationRegistry — subscription lifecycle', () => {
  it('should create a subscription linked to a publication', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['users']);
    const sub = await manager.createSubscription('sub-users', 'pub', 'postgres://...');

    expect(sub.subscriptionId).toBe('sub-users');
    expect(sub.tables).toEqual(['users']);
    expect(sub.operations).toEqual(['insert', 'update', 'delete']);
    expect(sub.createdAt).toBeGreaterThan(0);
  });

  it('should create a webhook subscription when DSN starts with http', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['events']);
    const sub = await manager.createSubscription('sub-webhook', 'pub', 'https://hooks.example.com/cdc');

    expect(sub.subscriptionId).toBe('sub-webhook');
    expect(sub.targetDsn).toBe('https://hooks.example.com/cdc');
  });

  it('should keep a DSN whose scheme is not http', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['t']);
    const sub = await manager.createSubscription('sub-db', 'pub', 'postgres://localhost:5432/db');

    // The catalogue stores what it was given. It used to reduce the DSN to
    // `webhookUrl` when it started with `http` and drop it otherwise, so a
    // subscription to a database target recorded no destination at all.
    expect(sub.targetDsn).toBe('postgres://localhost:5432/db');
  });

  it('should drop a subscription', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['t']);
    await manager.createSubscription('sub', 'pub', 'postgres://...');
    await manager.createSubscription('sub2', 'pub', 'postgres://...');

    let subs = await manager.getSubscriptions();
    expect(subs).toHaveLength(2);

    await manager.dropSubscription('sub');

    subs = await manager.getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.subscriptionId).toBe('sub2');
  });

  it('should error on duplicate subscription', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['t']);
    await manager.createSubscription('sub', 'pub', 'postgres://...');
    await expect(manager.createSubscription('sub', 'pub', 'postgres://...')).rejects.toThrow(
      'Subscription "sub" already exists',
    );
  });

  it('should error on non-existent publication', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await expect(manager.createSubscription('sub', 'nonexistent-pub', 'postgres://...')).rejects.toThrow(
      'Publication "nonexistent-pub" not found',
    );
  });

  it('should error on dropping non-existent subscription', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await expect(manager.dropSubscription('nonexistent')).rejects.toThrow('Subscription "nonexistent" not found');
  });
});

describe('CDCPublicationRegistry — catalogue, not a stream', () => {
  it('leaves delivery to the caller: the engine emitter still reaches its own subscribers', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const registry = new CDCPublicationRegistry({ nodeId: 'test-node', engine });
    const seen: CDCChangeEvent[] = [];
    engine.onChange((e) => seen.push(e));

    registry.createPublication('pub-users', ['users']);

    engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'alice' },
    });

    // The catalogue neither swallows the event nor delivers a copy of it: the
    // one subscriber above is exactly one delivery, which is the property that
    // was missing while `dispatch()` looped over subscriptions and did nothing.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tableName).toBe('users');
  });

  it('publishes no slot-invalid event, because nothing observes a slot', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const registry = new CDCPublicationRegistry({ nodeId: 'test-node', engine });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(registry));

    // `fireSlotInvalid()` lived on this class only so a suite could drive a
    // callback no deployment could ever receive. Both halves are gone; this
    // assertion is what stops either from creeping back as a convenience.
    expect(methods.filter((m) => /slot/i.test(m))).toEqual([]);
  });
});

describe('CDCPublicationRegistry — HLC timestamp ordering', () => {
  it('should attach monotonically increasing HLC timestamps to events', () => {
    const hlc = new HLC('test-node');
    const engine = new CDCEngine({ nodeId: 'test-node', hlc });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    manager.createPublication('pub', ['events']);
    manager.createSubscription('sub', 'pub', 'postgres://...');

    const event1 = engine.appendChange({
      tableName: 'events',
      operation: 'insert',
      oldValues: null,
      newValues: { msg: 'first' },
    });

    const event2 = engine.appendChange({
      tableName: 'events',
      operation: 'insert',
      oldValues: null,
      newValues: { msg: 'second' },
    });

    // HLC timestamps must be strictly increasing
    const cmp = compareHLC(event1.timestamp, event2.timestamp);
    expect(cmp).toBeLessThan(0);
  });
});
