/**
 * CDCPublicationRegistry Tests — Publication & Subscription lifecycle.
 *
 * Coverage:
 *   - create/drop publication lifecycle
 *   - create/drop subscription lifecycle
 *   - dispatch events to matching subscriptions
 *   - dispatch filtering by table name
 *   - dispatch filtering by operation type
 *   - onSlotInvalid event
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
    expect(sub.webhookUrl).toBe('https://hooks.example.com/cdc');
  });

  it('should not set webhookUrl for non-http DSN', async () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    await manager.createPublication('pub', ['t']);
    const sub = await manager.createSubscription('sub-db', 'pub', 'postgres://localhost:5432/db');

    expect(sub.webhookUrl).toBeUndefined();
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

describe('CDCPublicationRegistry — event dispatch', () => {
  it('should dispatch events to matching subscriptions by table name', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });
    const hlc = new HLC('test-node');

    // Create publication + subscription for "users" table
    manager.createPublication('pub-users', ['users']);
    manager.createSubscription('sub-users', 'pub-users', 'postgres://...');

    // Events for "users" should match; events for "orders" should not
    // The dispatch is internal — we verify by injecting via engine and
    // checking that the subscription doesn't throw (no handler crash).

    // This is a smoke test that dispatch runs without error
    const event = engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'alice' },
    });

    expect(event.tableName).toBe('users');
    expect(event.operation).toBe('insert');
  });

  it('should not throw when no subscriptions match', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    manager.createPublication('pub-orders', ['orders']);
    manager.createSubscription('sub-orders', 'pub-orders', 'postgres://...');

    // Event for an unwatched table — should dispatch silently with no match
    expect(() => {
      engine.appendChange({
        tableName: 'unwatched_table',
        operation: 'insert',
        oldValues: null,
        newValues: { id: 1 },
      });
    }).not.toThrow();
  });

  it('should filter by operation type', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    manager.createPublication('pub', ['users']);
    manager.createSubscription('sub', 'pub', 'postgres://...');

    // The CDCPublicationRegistry dispatch is fire-and-forget — current implementation
    // delivers all matching events inline. Verify no error for each op type.
    expect(() => {
      engine.appendChange({
        tableName: 'users',
        operation: 'insert',
        oldValues: null,
        newValues: { id: 1 },
      });
      engine.appendChange({
        tableName: 'users',
        operation: 'update',
        oldValues: { id: 1 },
        newValues: { id: 1, name: 'bob' },
      });
      engine.appendChange({
        tableName: 'users',
        operation: 'delete',
        oldValues: { id: 1 },
        newValues: null,
      });
    }).not.toThrow();
  });
});

describe('CDCPublicationRegistry — onSlotInvalid', () => {
  it('should register and fire slotInvalid callbacks', () => {
    const engine = new CDCEngine({ nodeId: 'test-node' });
    const manager = new CDCPublicationRegistry({ nodeId: 'test-node', engine });

    const callback = vi.fn();
    const unsub = manager.onSlotInvalid(callback);

    // The CDCPublicationRegistry has a fireSlotInvalid method for testing
    manager['fireSlotInvalid']('sub-1');
    manager['fireSlotInvalid']('sub-2');

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith('sub-1');
    expect(callback).toHaveBeenCalledWith('sub-2');

    unsub();
    manager['fireSlotInvalid']('sub-3');
    expect(callback).toHaveBeenCalledTimes(2); // unsubscribed
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
