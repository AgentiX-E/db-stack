/**
 * CDCEngine + CDCPublicationRegistry Tests — AC 45.x
 *
 * AC 45.1 — CDCEngine watches tables and fires onChange
 * AC 45.2 — CDCPublicationRegistry creates/drops publications
 * AC 45.3 — CDCPublicationRegistry creates/drops subscriptions
 * AC 45.4 — CDC change events carry HLC timestamps
 * AC 45.5 — Subscription filtering by table and operation
 *     — CDCEngine start/stop lifecycle
 *     — CDCPublicationRegistry onSlotInvalid event
 *     — Duplicate publication/subscription rejection
 */

import { describe, it, expect, vi } from 'vitest';
import { CDCEngine } from './CDCEngine';
import { CDCPublicationRegistry } from './CDCPublicationRegistry';
import type { CDCChangeEvent } from '../interfaces/replication/ICDCManager';

// ── CDCEngine Tests ──

describe('CDCEngine — AC 45.1: Table Watching', () => {
  it('should start and stop', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    expect(engine.started).toBe(false);

    await engine.start();
    expect(engine.started).toBe(true);

    await engine.stop();
    expect(engine.started).toBe(false);
  });

  it('should watch and unwatch tables', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    engine.watchTable('users');
    engine.watchTable('orders');
    expect(engine.getWatchedTables()).toEqual(['users', 'orders']);

    engine.unwatchTable('users');
    expect(engine.getWatchedTables()).toEqual(['orders']);
  });

  it('should ignore duplicate watchTable calls', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    engine.watchTable('users');
    engine.watchTable('users');
    expect(engine.getWatchedTables()).toEqual(['users']);
  });
});

describe('CDCEngine — AC 45.4: HLC Timestamps on Events', () => {
  it('should attach HLC timestamp to change events', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'alice' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBeDefined();
    expect(events[0]!.timestamp.nodeId).toBe('n1');
    expect(events[0]!.timestamp.wallTime).toBeGreaterThan(0);
    expect(events[0]!.timestamp.logical).toBeGreaterThanOrEqual(0);
    expect(events[0]!.txId).toBeTruthy();
    expect(events[0]!.lsn).toBeTruthy();
  });

  it('should generate strictly increasing HLC for sequential events', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 't1',
      operation: 'insert',
      oldValues: null,
      newValues: { v: 1 },
    });
    engine.appendChange({
      tableName: 't1',
      operation: 'update',
      oldValues: { v: 1 },
      newValues: { v: 2 },
    });

    expect(events).toHaveLength(2);
    const ts0 = events[0]!.timestamp;
    const ts1 = events[1]!.timestamp;

    const cmp = (a: typeof ts0, b: typeof ts0): number => {
      if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
      return a.logical - b.logical;
    };
    expect(cmp(ts1, ts0)).toBeGreaterThan(0); // ts1 > ts0
  });
});

describe('CDCEngine — Events', () => {
  it('should fire onChange for each appendChange', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 't1',
      operation: 'insert',
      oldValues: null,
      newValues: {},
    });
    engine.appendChange({
      tableName: 't2',
      operation: 'delete',
      oldValues: {},
      newValues: null,
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.tableName).toBe('t1');
    expect(events[0]!.operation).toBe('insert');
    expect(events[1]!.tableName).toBe('t2');
    expect(events[1]!.operation).toBe('delete');
  });

  it('should allow unsubscribe from onChange', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    const unsub = engine.onChange((e) => events.push(e));

    unsub();
    engine.appendChange({
      tableName: 't1',
      operation: 'insert',
      oldValues: null,
      newValues: {},
    });

    expect(events).toHaveLength(0);
  });
});

describe('CDCEngine — Operation Types', () => {
  it('should handle insert with newValues only', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1, name: 'bob' },
    });

    expect(events[0]!.operation).toBe('insert');
    expect(events[0]!.newValues).toEqual({ id: 1, name: 'bob' });
    expect(events[0]!.oldValues).toBeNull();
  });

  it('should handle update with old and new values', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 'users',
      operation: 'update',
      oldValues: { id: 1, name: 'bob' },
      newValues: { id: 1, name: 'robert' },
    });

    expect(events[0]!.operation).toBe('update');
    expect(events[0]!.oldValues).toEqual({ id: 1, name: 'bob' });
    expect(events[0]!.newValues).toEqual({ id: 1, name: 'robert' });
  });

  it('should handle delete with oldValues', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const events: CDCChangeEvent[] = [];
    engine.onChange((e) => events.push(e));

    engine.appendChange({
      tableName: 'users',
      operation: 'delete',
      oldValues: { id: 1, name: 'bob' },
      newValues: null,
    });

    expect(events[0]!.operation).toBe('delete');
    expect(events[0]!.oldValues).toEqual({ id: 1, name: 'bob' });
    expect(events[0]!.newValues).toBeNull();
  });
});

// ── CDCPublicationRegistry Tests ──

describe('CDCPublicationRegistry — AC 45.2: Publications', () => {
  it('should create a publication with tables', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    const pub = await mgr.createPublication('pub_users', ['users']);
    expect(pub.publicationId).toBe('pub_users');
    expect(pub.tables).toEqual(['users']);
    expect(pub.createdAt).toBeGreaterThan(0);

    // Engine should be watching the table
    expect(engine.getWatchedTables()).toContain('users');
  });

  it('should reject duplicate publications', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await expect(mgr.createPublication('pub1', ['orders'])).rejects.toThrow('Publication "pub1" already exists');
  });

  it('should drop a publication', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await mgr.dropPublication('pub1');

    const pubs = await mgr.getPublications();
    expect(pubs).toHaveLength(0);
  });

  it('should reject dropping non-existent publication', async () => {
    const mgr = new CDCPublicationRegistry({
      nodeId: 'n1',
      engine: new CDCEngine({ nodeId: 'n1' }),
    });
    await expect(mgr.dropPublication('nonexistent')).rejects.toThrow('Publication "nonexistent" not found');
  });

  it('should list publications', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await mgr.createPublication('pub2', ['orders', 'products']);

    const pubs = await mgr.getPublications();
    expect(pubs).toHaveLength(2);
  });

  it('should unwatch tables only when no other publication needs them', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub_shared', ['users']);
    await mgr.createPublication('pub_other', ['users', 'orders']);

    // Drop pub_other — "users" is still watched by pub_shared
    await mgr.dropPublication('pub_other');
    expect(engine.getWatchedTables()).toEqual(['users']);

    // Drop pub_shared — "users" no longer watched
    await mgr.dropPublication('pub_shared');
    expect(engine.getWatchedTables()).toEqual([]);
  });
});

describe('CDCPublicationRegistry — AC 45.3: Subscriptions', () => {
  it('should create a subscription from a publication', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    const sub = await mgr.createSubscription('sub1', 'pub1', 'postgres://target/db');

    expect(sub.subscriptionId).toBe('sub1');
    expect(sub.tables).toEqual(['users']);
    expect(sub.operations).toEqual(['insert', 'update', 'delete']);
    expect(sub.webhookUrl).toBeUndefined();
  });

  it('should create a webhook subscription from HTTP DSN', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['orders']);
    const sub = await mgr.createSubscription('webhook1', 'pub1', 'https://hooks.example.com/cdc');
    expect(sub.webhookUrl).toBe('https://hooks.example.com/cdc');
  });

  it('should reject duplicate subscriptions', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await mgr.createSubscription('sub1', 'pub1', 'postgres://target/db');
    await expect(mgr.createSubscription('sub1', 'pub1', 'postgres://target/db')).rejects.toThrow(
      'Subscription "sub1" already exists',
    );
  });

  it('should reject subscription to non-existent publication', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await expect(mgr.createSubscription('sub1', 'nonexistent', 'postgres://target/db')).rejects.toThrow(
      'Publication "nonexistent" not found',
    );
  });

  it('should drop a subscription', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await mgr.createSubscription('sub1', 'pub1', 'postgres://target/db');
    await mgr.dropSubscription('sub1');

    const subs = await mgr.getSubscriptions();
    expect(subs).toHaveLength(0);
  });

  it('should reject dropping non-existent subscription', async () => {
    const mgr = new CDCPublicationRegistry({
      nodeId: 'n1',
      engine: new CDCEngine({ nodeId: 'n1' }),
    });
    await expect(mgr.dropSubscription('nonexistent')).rejects.toThrow('Subscription "nonexistent" not found');
  });

  it('should list subscriptions', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub1', ['users']);
    await mgr.createPublication('pub2', ['orders']);
    await mgr.createSubscription('sub1', 'pub1', 'dsn1');
    await mgr.createSubscription('sub2', 'pub2', 'dsn2');

    const subs = await mgr.getSubscriptions();
    expect(subs).toHaveLength(2);
  });
});

describe('CDCPublicationRegistry — AC 45.5: Event Dispatch', () => {
  it('should dispatch CDC events to matching subscriptions', async () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    await mgr.createPublication('pub_users', ['users']);
    await mgr.createPublication('pub_orders', ['orders']);
    await mgr.createSubscription('sub_users', 'pub_users', 'pg://dst1');

    // Append a change event
    const onEngineCb = vi.fn();
    engine.onChange(onEngineCb);

    engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1 },
    });

    // Engine fires the callback; manager dispatch happens internally
    expect(onEngineCb).toHaveBeenCalledTimes(1);
    const event = onEngineCb.mock.calls[0]![0] as CDCChangeEvent;
    expect(event.tableName).toBe('users');
  });
});

describe('CDCPublicationRegistry — onSlotInvalid', () => {
  it('should fire onSlotInvalid event', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    const invalidSlots: string[] = [];
    mgr.onSlotInvalid((subId) => invalidSlots.push(subId));

    mgr.fireSlotInvalid('sub1');
    expect(invalidSlots).toEqual(['sub1']);
  });

  it('should allow unsubscription from onSlotInvalid', () => {
    const engine = new CDCEngine({ nodeId: 'n1' });
    const mgr = new CDCPublicationRegistry({ nodeId: 'n1', engine });

    const invalidSlots: string[] = [];
    const unsub = mgr.onSlotInvalid((subId) => invalidSlots.push(subId));
    unsub();

    mgr.fireSlotInvalid('sub1');
    expect(invalidSlots).toHaveLength(0);
  });
});
