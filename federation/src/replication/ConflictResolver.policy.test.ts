/**
 * ConflictResolver — per-table policy selection.
 *
 * The roadmap promises an explicit per-table selection policy with LWW as the
 * documented default, rather than a fall-through that silently happens to pick
 * LWW. A registered resolver is dispatched by a predicate (table name or key
 * prefix); the selection must be deterministic regardless of registration
 * order and must not let one resolver shadow a more specific one.
 *
 * These cases are written before the fix: each name states the decision the
 * resolver is expected to publish, so a wrong choice is a red test rather than
 * a score that counts a mutant as killed by accident.
 */

import { describe, it, expect } from 'vitest';
import { ConflictResolver, type ConflictValue, type ConflictResult } from './ConflictResolver';
import { makeHLC } from '../hlc/HLC';

function value(id: string, wallTime: number): ConflictValue {
  return {
    key: 'k',
    value: id,
    hlc: makeHLC(BigInt(wallTime), 0, id),
    nodeId: id,
  };
}

function custom(tag: string) {
  return async (): Promise<ConflictResult> => ({
    resolvedValue: tag,
    strategyUsed: 'custom',
    loserNodeIds: [],
    merged: false,
  });
}

const LOCAL = value('n1', 100);
const REMOTE = value('n2', 200);

describe('ConflictResolver — deterministic per-table selection', () => {
  it('an exact table resolver wins over a bare fallback even when the fallback is registered first', async () => {
    const resolver = new ConflictResolver('n1');
    resolver.registerCustomResolver({}, custom('fallback'));
    resolver.registerCustomResolver({ tableName: 'orders' }, custom('orders'));

    const result = await resolver.resolve('orders:1', LOCAL, REMOTE);
    expect(result.resolvedValue).toBe('orders');
  });

  it('a table name matches only that table, not a longer table sharing its prefix', async () => {
    const resolver = new ConflictResolver('n1');
    resolver.registerCustomResolver({ tableName: 'user' }, custom('user'));

    const result = await resolver.resolve('users_archive:1', LOCAL, REMOTE);
    // No custom resolver matches this table → LWW picks the higher HLC (n2).
    expect(result.strategyUsed).toBe('lww');
    expect(result.resolvedValue).toBe(REMOTE.value);
  });

  it('a longer, more specific key prefix wins over a shorter one regardless of registration order', async () => {
    const resolver = new ConflictResolver('n1');
    resolver.registerCustomResolver({ keyPrefix: 'cache' }, custom('broad'));
    resolver.registerCustomResolver({ keyPrefix: 'cache:hot' }, custom('specific'));

    const result = await resolver.resolve('cache:hot:1', LOCAL, REMOTE);
    expect(result.resolvedValue).toBe('specific');
  });

  it('registering the same token as a table and as a prefix keeps both resolvers addressable', async () => {
    const resolver = new ConflictResolver('n1');
    resolver.registerCustomResolver({ tableName: 'user' }, custom('by-table'));
    resolver.registerCustomResolver({ keyPrefix: 'user' }, custom('by-prefix'));

    // The exact-table match takes precedence for a key in that table.
    const tableKey = await resolver.resolve('user:1', LOCAL, REMOTE);
    expect(tableKey.resolvedValue).toBe('by-table');

    // Unregistering the table resolver must not delete the prefix resolver
    // that happened to share the same token.
    resolver.unregisterCustomResolver({ tableName: 'user' });
    const prefixKey = await resolver.resolve('user:2', LOCAL, REMOTE);
    expect(prefixKey.resolvedValue).toBe('by-prefix');
  });
});
