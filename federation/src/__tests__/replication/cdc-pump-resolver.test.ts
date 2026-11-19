/**
 * CDC delivery composition — pump + resolver + sink.
 *
 * The three pieces ship together: `CDCSubscriptionPump` decides *what* goes
 * where, `CDCSinkResolver` owns retry, batching and health for a sink, and the
 * sink writes. No two of them were ever connected in a test before, which is how
 * the pump could be missing altogether while every unit case passed.
 *
 * The measurement is the one the roadmap asked for in P3-37: a change appended
 * to the engine arrives at the subscription's sink, in LSN order, exactly once,
 * through a sink that refuses part of the time.
 *
 *   AC 48.24 — 300 changes reach the sink once each, in order, with a sink that
 *              refuses every seventh emit and a resolver that reconnects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CDCEngine } from '../../replication/CDCEngine';
import { CDCPublicationRegistry } from '../../replication/CDCPublicationRegistry';
import { CDCSubscriptionPump } from '../../replication/CDCSubscriptionPump';
import { CDCSinkResolver } from '../../replication/CDCSinkResolver';
import { InMemoryCDCSink } from '../../replication/InMemoryCDCSink';
import type { ICDCSink, CDCSinkEvent } from '../../interfaces/replication/ICDCSink';

/** Refuses every n-th emit call, and accepts every other one. */
class RefusingEveryNth implements ICDCSink {
  readonly name = 'refusing-every-nth';
  emitCalls = 0;
  connectCalls = 0;
  readonly accepted: CDCSinkEvent[] = [];

  constructor(private readonly everyNth: number) {}

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async disconnect(): Promise<void> {
    /* nothing to release */
  }

  async emit(events: CDCSinkEvent[]): Promise<void> {
    this.emitCalls++;
    if (this.emitCalls % this.everyNth === 0) {
      throw new Error(`refused emit call ${this.emitCalls}`);
    }
    this.accepted.push(...events);
  }
}

describe('CDC delivery composition — AC 48.24', () => {
  const pumps: CDCSubscriptionPump[] = [];

  afterEach(async () => {
    for (const pump of pumps.splice(0)) await pump.stop();
  });

  it('delivers 300 LSN-ordered changes exactly once through a refusing sink', async () => {
    const engine = new CDCEngine({ nodeId: 'compose-node' });
    const registry = new CDCPublicationRegistry({ nodeId: 'compose-node', engine });
    await registry.createPublication('pub-ledger', ['ledger']);
    await registry.createSubscription('sub-ledger', 'pub-ledger', 'memory://ledger');

    const inner = new RefusingEveryNth(7);
    const resolver = new CDCSinkResolver(inner, {
      maxRetries: 2,
      retryBaseMs: 0,
      retryStrategy: 'none',
      healthCheckIntervalMs: 0,
    });

    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: () => resolver,
      maxEmitAttempts: 3,
      retryBaseMs: 0,
    });
    pumps.push(pump);
    await pump.start();

    const appended = Array.from({ length: 300 }, () =>
      engine.appendChange({
        tableName: 'ledger',
        operation: 'insert',
        oldValues: null,
        newValues: { amount: 1 },
      }),
    );

    // 300 changes plus a retry per refusal, each retry one timer hop.
    for (let i = 0; i < 400; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    const expected = appended.map((event) => `${event.lsn}:${event.txId}`);
    expect(inner.accepted.map((event) => event.id)).toEqual(expected);

    const status = pump.getStatus();
    expect(status).toMatchObject({ delivered: 300, failed: 0, dropped: 0 });
    expect(pump.getFailures()).toHaveLength(0);

    // The refusal cost a reconnect and nothing else: the resolver is still
    // connected and the pump never saw the failure.
    expect(resolver.getHealth().totalFailures).toBeGreaterThan(0);
    expect(inner.emitCalls).toBeGreaterThan(300);
    expect(resolver.connected).toBe(true);
  });

  it('writes through a real in-memory sink without the resolver in front', async () => {
    // The composition the API reference shows first: a factory that hands back
    // any ICDCSink. This case pins that the pump needs nothing else from it.
    const engine = new CDCEngine({ nodeId: 'plain-node' });
    const registry = new CDCPublicationRegistry({ nodeId: 'plain-node', engine });
    await registry.createPublication('pub', ['users']);
    await registry.createSubscription('sub', 'pub', 'memory://users');

    const sink = new InMemoryCDCSink('users');
    const pump = new CDCSubscriptionPump({ engine, registry, resolveSink: () => sink });
    pumps.push(pump);
    await pump.start();

    const appended = engine.appendChange({
      tableName: 'users',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 5 },
    });
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink.getEvents()).toHaveLength(1);
    expect(sink.getEvents()[0]).toMatchObject({
      id: `${appended.lsn}:${appended.txId}`,
      table: 'users',
      data: { id: 5 },
    });
  });
});
