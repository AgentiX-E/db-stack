/**
 * CDCSubscriptionPump — the edge a subscription's target DSN never had.
 *
 * Iteration 51 removed the catalogue's empty dispatch loop and recorded what
 * the loop had hidden: `createSubscription(name, publication, targetDsn)` stored
 * a destination that nothing in the package could resolve, while `ICDCSink`,
 * `InMemoryCDCSink` and `CDCSinkResolver` had no production caller and were not
 * exported at all. These cases measure the property that closes it, with real
 * engines, real catalogues and real sinks:
 *
 *   AC 48.1  a change appended to the engine arrives at the subscription's sink
 *   AC 48.2  the sink sees every change once, in LSN order
 *   AC 48.3  the default projection is the documented one
 *   AC 48.4  a subscription receives only its publication's tables
 *   AC 48.5  `operations` filters what a subscription receives
 *   AC 48.6  a sink that refuses twice is retried and stores the change once
 *   AC 48.7  a sink that always refuses exhausts the budget and is recorded
 *   AC 48.8  a refused change does not stall the ones behind it
 *   AC 48.9  an overflowing queue drops the newest and reports the gap
 *   AC 48.10 stop() abandons queued changes and says so
 *   AC 48.11 sync() opens subscriptions created after start()
 *   AC 48.12 sync() closes subscriptions dropped from the catalogue
 *   AC 48.13 an unresolvable DSN is reported, not thrown
 *   AC 48.14 a sink that cannot connect is the same as an unresolvable DSN
 *   AC 48.15 a repeated sync() does not reconnect an open subscription
 *   AC 48.16 the failure log is bounded and eviction is counted
 *   AC 48.17 a caller-supplied projection replaces the default
 *   AC 48.18 a throwing observer does not break delivery
 *   AC 48.19 status reports queue depth per subscription
 *   AC 48.20 start() and stop() are idempotent and stop() detaches the engine
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CDCEngine } from './CDCEngine';
import { CDCPublicationRegistry } from './CDCPublicationRegistry';
import { InMemoryCDCSink } from './InMemoryCDCSink';
import { CDCSubscriptionPump, projectChangeEvent } from './CDCSubscriptionPump';
import type { CDCPumpEvent } from './CDCSubscriptionPump';
import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';
import type { CDCChangeEvent, CDCSubscription } from '../interfaces/replication/ICDCManager';

// ── Test sinks ─────────────────────────────────────────────
//
// These are objects with behaviour, not mocks: each one is the failure mode it
// is named after, and the pump is measured against the behaviour, not against a
// call count it was told to produce.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Accepts everything, records every batch it was handed. */
class RecordingSink implements ICDCSink {
  readonly name: string = 'recording';
  readonly batches: CDCSinkEvent[][] = [];
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(private readonly gate?: Promise<void>) {}

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }

  async emit(events: CDCSinkEvent[]): Promise<void> {
    if (this.gate) await this.gate;
    this.batches.push(events);
  }

  get events(): CDCSinkEvent[] {
    return this.batches.flat();
  }
}

/** Refuses the first `refusals` calls, then accepts. */
class FlakySink extends RecordingSink {
  override readonly name: string = 'flaky';
  emitCalls = 0;

  constructor(private readonly refusals: number) {
    super();
  }

  override async emit(events: CDCSinkEvent[]): Promise<void> {
    this.emitCalls++;
    if (this.emitCalls <= this.refusals) {
      throw new Error(`refused call ${this.emitCalls}`);
    }
    await super.emit(events);
  }
}

/** Refuses every call. */
class RefusingSink extends RecordingSink {
  override readonly name: string = 'refusing';
  emitCalls = 0;

  override async emit(_events: CDCSinkEvent[]): Promise<void> {
    this.emitCalls++;
    throw new Error(`refused call ${this.emitCalls}`);
  }
}

/** Cannot connect. */
class UnconnectableSink extends RecordingSink {
  override readonly name: string = 'unconnectable';

  override async connect(): Promise<void> {
    throw new Error('no route to sink');
  }
}

/** Accepts changes but cannot release the connection. */
class DisconnectFailingSink extends RecordingSink {
  override readonly name: string = 'disconnect-failing';

  override async disconnect(): Promise<void> {
    throw new Error('socket already gone');
  }
}

// ── Harness ────────────────────────────────────────────────

type Harness = {
  engine: CDCEngine;
  registry: CDCPublicationRegistry;
  pump: CDCSubscriptionPump;
  events: CDCPumpEvent[];
  sinks: Map<string, ICDCSink>;
};

const pumps: CDCSubscriptionPump[] = [];

afterEach(async () => {
  for (const pump of pumps.splice(0)) {
    await pump.stop();
  }
});

async function harness(options: {
  dsnToSink?: (dsn: string) => ICDCSink;
  project?: (event: Parameters<typeof projectChangeEvent>[0]) => CDCSinkEvent;
  maxPendingPerSubscription?: number;
  maxEmitAttempts?: number;
  retryBaseMs?: number;
  maxFailureLog?: number;
  publication?: { name: string; tables: string[] };
  subscription?: { name: string; operations?: CDCSubscription['operations'] };
  start?: boolean;
}): Promise<Harness> {
  const engine = new CDCEngine({ nodeId: 'pump-node' });
  const registry = new CDCPublicationRegistry({ nodeId: 'pump-node', engine });
  const sinks = new Map<string, ICDCSink>();

  const pub = options.publication ?? { name: 'pub', tables: ['orders'] };
  const sub = options.subscription ?? { name: 'sub' };

  await registry.createPublication(pub.name, pub.tables);
  await registry.createSubscription(sub.name, pub.name, `test://${sub.name}`, sub.operations);

  const pump = new CDCSubscriptionPump({
    engine,
    registry,
    resolveSink: (dsn) => {
      const made = options.dsnToSink ? options.dsnToSink(dsn) : new RecordingSink();
      sinks.set(dsn, made);
      return made;
    },
    project: options.project,
    maxPendingPerSubscription: options.maxPendingPerSubscription,
    maxEmitAttempts: options.maxEmitAttempts,
    retryBaseMs: options.retryBaseMs,
    maxFailureLog: options.maxFailureLog,
  });
  pumps.push(pump);

  const events: CDCPumpEvent[] = [];
  pump.onEvent((event) => events.push(event));

  if (options.start !== false) await pump.start();

  return { engine, registry, pump, events, sinks };
}

/**
 * Let the pump's drain loops run. A round is one microtask drain plus one
 * macrotask, because a retry waits on a timer: microtasks alone would stop at
 * the first `setTimeout` and report a retry budget that had not been spent.
 */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function change(tableName: string, operation: 'insert' | 'update' | 'delete' = 'insert') {
  return {
    tableName,
    operation,
    oldValues: operation === 'insert' ? null : { id: 1 },
    newValues: operation === 'delete' ? null : { id: 1, status: 'active' },
  };
}

// ── Cases ──────────────────────────────────────────────────

describe('CDCSubscriptionPump — delivery', () => {
  it('AC 48.1 — a change appended to the engine arrives at the subscription sink', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    h.engine.appendChange(change('orders'));
    await settle();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.table).toBe('orders');
    expect(h.pump.getStatus().delivered).toBe(1);
  });

  it('AC 48.2 — the sink sees every change once, in LSN order', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    const appended = Array.from({ length: 200 }, () => h.engine.appendChange(change('orders')));
    await settle(64);

    expect(sink.events).toHaveLength(200);
    expect(sink.events.map((e) => e.id)).toEqual(appended.map((e) => `${e.lsn}:${e.txId}`));

    const lsns = sink.events.map((e) => e.id.split(':')[0]!);
    const sorted = [...lsns].sort();
    expect(lsns).toEqual(sorted);
    expect(new Set(sink.events.map((e) => e.id)).size).toBe(200);
    expect(h.pump.getStatus()).toMatchObject({ delivered: 200, failed: 0, dropped: 0 });
  });

  it('AC 48.3 — the default projection is the documented one', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    const appended = h.engine.appendChange({
      tableName: 'orders',
      operation: 'update',
      oldValues: { id: 7, status: 'new' },
      newValues: { id: 7, status: 'paid' },
    });
    await settle();

    const delivered = sink.events[0]!;
    expect(delivered).toEqual({
      id: `${appended.lsn}:${appended.txId}`,
      type: 'update',
      table: 'orders',
      // The engine's change event names no key column, so the default does not
      // invent one. A sink that needs row identity supplies `project`.
      key: '',
      data: { id: 7, status: 'paid' },
      timestamp: appended.timestamp.wallTime,
    });
  });

  it('AC 48.4 — a subscription receives only its publication tables', async () => {
    const engine = new CDCEngine({ nodeId: 'n' });
    const registry = new CDCPublicationRegistry({ nodeId: 'n', engine });
    await registry.createPublication('pub-orders', ['orders']);
    await registry.createPublication('pub-users', ['users']);
    await registry.createSubscription('sub-orders', 'pub-orders', 'test://orders');
    await registry.createSubscription('sub-users', 'pub-users', 'test://users');

    const orderSink = new RecordingSink();
    const userSink = new RecordingSink();
    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: (dsn) => (dsn === 'test://orders' ? orderSink : userSink),
    });
    pumps.push(pump);
    await pump.start();

    engine.appendChange(change('orders'));
    engine.appendChange(change('users'));
    await settle();

    expect(orderSink.events.map((e) => e.table)).toEqual(['orders']);
    expect(userSink.events.map((e) => e.table)).toEqual(['users']);
  });

  it('AC 48.5 — operations filters what a subscription receives', async () => {
    const h = await harness({ subscription: { name: 'sub', operations: ['insert'] } });
    const sink = h.sinks.get('test://sub') as RecordingSink;

    h.engine.appendChange(change('orders', 'insert'));
    h.engine.appendChange(change('orders', 'update'));
    h.engine.appendChange(change('orders', 'delete'));
    await settle();

    expect(sink.events.map((e) => e.type)).toEqual(['insert']);
  });

  it('AC 48.17 — a caller-supplied projection replaces the default', async () => {
    const engine = new CDCEngine({ nodeId: 'n' });
    const registry = new CDCPublicationRegistry({ nodeId: 'n', engine });
    await registry.createPublication('pub', ['orders']);
    await registry.createSubscription('sub', 'pub', 'test://sub');
    const sink = new RecordingSink();
    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: () => sink,
      project: (event) => ({
        ...projectChangeEvent(event),
        key: String((event.newValues as { id?: number } | null)?.id ?? ''),
      }),
    });
    pumps.push(pump);
    await pump.start();

    engine.appendChange(change('orders'));
    await settle();

    expect(sink.events[0]!.key).toBe('1');
  });
});

describe('CDCSubscriptionPump — a sink that refuses', () => {
  it('AC 48.6 — a sink that refuses twice is retried and stores the change once', async () => {
    const sink = new FlakySink(2);
    const h = await harness({ dsnToSink: () => sink, maxEmitAttempts: 3, retryBaseMs: 0 });

    h.engine.appendChange(change('orders'));
    await settle();

    expect(sink.emitCalls).toBe(3);
    expect(sink.events).toHaveLength(1);
    expect(h.pump.getStatus()).toMatchObject({ delivered: 1, failed: 0 });
    expect(h.pump.getFailures()).toHaveLength(0);
  });

  it('AC 48.7 — a sink that always refuses exhausts the budget and is recorded', async () => {
    const sink = new RefusingSink();
    const h = await harness({ dsnToSink: () => sink, maxEmitAttempts: 3, retryBaseMs: 0 });

    const appended = h.engine.appendChange(change('orders'));
    await settle();

    expect(sink.emitCalls).toBe(3);
    expect(h.pump.getStatus()).toMatchObject({ delivered: 0, failed: 1 });

    const failures = h.pump.getFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      subscriptionId: 'sub',
      eventId: `${appended.lsn}:${appended.txId}`,
      table: 'orders',
      attempts: 3,
      error: 'refused call 3',
    });

    const failureEvent = h.events.find((e) => e.type === 'delivery_failed');
    expect(failureEvent).toMatchObject({ attempts: 3, error: 'refused call 3' });
  });

  it('AC 48.8 — a refused change does not stall the ones behind it', async () => {
    const sink = new RefusingSink();
    const h = await harness({ dsnToSink: () => sink, maxEmitAttempts: 2, retryBaseMs: 0 });

    h.engine.appendChange(change('orders'));
    h.engine.appendChange(change('orders'));
    h.engine.appendChange(change('orders'));
    await settle(64);

    // Three changes, two attempts each, and the queue drained instead of
    // holding the head: a poisoned event does not become an outage.
    expect(sink.emitCalls).toBe(6);
    expect(h.pump.getStatus()).toMatchObject({ failed: 3, delivered: 0 });
    expect(h.pump.getFailures()).toHaveLength(3);
  });
});

describe('CDCSubscriptionPump — a queue that fills', () => {
  it('AC 48.9 — an overflowing queue drops the newest and reports the gap', async () => {
    const gate = deferred();
    const sink = new RecordingSink(gate.promise);
    const h = await harness({ dsnToSink: () => sink, maxPendingPerSubscription: 2 });

    const appended = [1, 2, 3, 4, 5].map(() => h.engine.appendChange(change('orders')));
    await settle();

    const status = h.pump.getStatus();
    expect(status.dropped).toBe(3);
    expect(status.pending['sub']).toBe(2);

    const overflows = h.events.filter((e) => e.type === 'overflow');
    expect(overflows).toHaveLength(3);
    expect(overflows.every((e) => e.reason === 'queue-full')).toBe(true);
    // The gap is reported where it begins: the first change that found no room.
    expect(overflows[0]!.eventId).toBe(`${appended[2]!.lsn}:${appended[2]!.txId}`);

    gate.resolve();
    await settle(32);

    // The consumer keeps a contiguous prefix instead of a hole in the middle.
    expect(sink.events.map((e) => e.id)).toEqual([
      `${appended[0]!.lsn}:${appended[0]!.txId}`,
      `${appended[1]!.lsn}:${appended[1]!.txId}`,
    ]);
    expect(h.pump.getStatus()).toMatchObject({ delivered: 2, dropped: 3 });
  });

  it('AC 48.10 — stop() abandons queued changes and says so', async () => {
    const gate = deferred();
    const sink = new RecordingSink(gate.promise);
    const h = await harness({ dsnToSink: () => sink });

    h.engine.appendChange(change('orders'));
    h.engine.appendChange(change('orders'));
    await settle();

    await h.pump.stop();

    expect(h.pump.getStatus().dropped).toBe(2);
    const abandoned = h.events.find((e) => e.type === 'overflow');
    expect(abandoned).toMatchObject({ reason: 'stopped', dropped: 2 });

    // The in-flight emit is released after the pump closed; it is not reported
    // as a delivery, because the pump's window has ended.
    gate.resolve();
    await settle();
    expect(h.pump.getStatus().delivered).toBe(0);
    expect(sink.disconnectCalls).toBe(1);
  });

  it('AC 48.20 — start() and stop() are idempotent and stop() detaches the engine', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    await h.pump.start();
    expect(sink.connectCalls).toBe(1);

    await h.pump.stop();
    await h.pump.stop();
    expect(sink.disconnectCalls).toBe(1);

    h.engine.appendChange(change('orders'));
    await settle();
    expect(sink.events).toHaveLength(0);
  });
});

describe('CDCSubscriptionPump — reconciliation', () => {
  it('AC 48.11 — sync() opens subscriptions created after start()', async () => {
    const h = await harness({});
    await h.registry.createPublication('pub-late', ['audit_log']);
    await h.registry.createSubscription('sub-late', 'pub-late', 'test://late');

    h.engine.appendChange(change('audit_log'));
    await settle();
    expect(h.pump.getStatus().subscriptions).toBe(1);

    await h.pump.sync();
    h.engine.appendChange(change('audit_log'));
    await settle();

    expect(h.pump.getStatus().subscriptions).toBe(2);
    const late = h.sinks.get('test://late') as RecordingSink;
    expect(late.events).toHaveLength(1);
  });

  it('AC 48.12 — sync() closes subscriptions dropped from the catalogue', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    await h.registry.dropSubscription('sub');
    await h.pump.sync();

    expect(sink.disconnectCalls).toBe(1);
    expect(h.pump.getStatus().subscriptions).toBe(0);
    expect(h.events.some((e) => e.type === 'subscription_closed')).toBe(true);
  });

  it('AC 48.15 — a repeated sync() does not reconnect an open subscription', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    await h.pump.sync();
    await h.pump.sync();

    expect(sink.connectCalls).toBe(1);
  });

  it('AC 48.13 — an unresolvable DSN is reported, not thrown', async () => {
    const engine = new CDCEngine({ nodeId: 'n' });
    const registry = new CDCPublicationRegistry({ nodeId: 'n', engine });
    await registry.createPublication('pub', ['orders']);
    await registry.createSubscription('sub-bad', 'pub', 'bogus://nothing');
    await registry.createSubscription('sub-good', 'pub', 'test://good');

    const good = new RecordingSink();
    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: (dsn) => {
        if (dsn === 'bogus://nothing') throw new Error('unknown scheme in bogus://nothing');
        return good;
      },
    });
    pumps.push(pump);
    const events: CDCPumpEvent[] = [];
    pump.onEvent((e) => events.push(e));

    await pump.start();

    expect(pump.getStatus().unopened).toEqual(['sub-bad']);
    expect(events.find((e) => e.type === 'subscription_failed')).toMatchObject({
      subscriptionId: 'sub-bad',
      error: 'unknown scheme in bogus://nothing',
    });

    engine.appendChange(change('orders'));
    await settle();
    expect(good.events).toHaveLength(1);
  });

  it('AC 48.14 — a sink that cannot connect is the same as an unresolvable DSN', async () => {
    const h = await harness({ dsnToSink: () => new UnconnectableSink() });

    expect(h.pump.getStatus().unopened).toEqual(['sub']);
    expect(h.pump.getStatus().subscriptions).toBe(0);
    expect(h.events.find((e) => e.type === 'subscription_failed')?.error).toBe('no route to sink');
  });
});

describe('CDCSubscriptionPump — observation', () => {
  it('AC 48.16 — the failure log is bounded and eviction is counted', async () => {
    const sink = new RefusingSink();
    const h = await harness({
      dsnToSink: () => sink,
      maxEmitAttempts: 1,
      retryBaseMs: 0,
      maxFailureLog: 2,
    });

    const appended = [1, 2, 3].map(() => h.engine.appendChange(change('orders')));
    await settle(32);

    const failures = h.pump.getFailures();
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.eventId)).toEqual([
      `${appended[1]!.lsn}:${appended[1]!.txId}`,
      `${appended[2]!.lsn}:${appended[2]!.txId}`,
    ]);
    expect(h.pump.getStatus()).toMatchObject({ failed: 3, evictedFailures: 1 });
  });

  it('AC 48.18 — a throwing observer does not break delivery', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    h.pump.onEvent(() => {
      throw new Error('observer exploded');
    });

    h.engine.appendChange(change('orders'));
    await settle();

    expect(sink.events).toHaveLength(1);
    expect(h.pump.getStatus().delivered).toBe(1);
  });

  it('AC 48.19 — status reports queue depth per subscription', async () => {
    const gate = deferred();
    const sink = new RecordingSink(gate.promise);
    const h = await harness({ dsnToSink: () => sink });

    h.engine.appendChange(change('orders'));
    h.engine.appendChange(change('orders'));
    await settle();

    expect(h.pump.getStatus().pending).toEqual({ sub: 2 });

    gate.resolve();
    await settle(16);
    expect(h.pump.getStatus().pending).toEqual({ sub: 0 });
  });
});

describe('CDCSubscriptionPump — edges that only a hostile sink reaches', () => {
  it('AC 48.27 — a change with neither row is projected with empty data', async () => {
    const h = await harness({});
    const sink = h.sinks.get('test://sub') as RecordingSink;

    h.engine.appendChange({
      tableName: 'orders',
      operation: 'delete',
      oldValues: null,
      newValues: null,
    });
    await settle();

    expect(sink.events[0]!.data).toEqual({});
  });

  it('AC 48.28 — a sink that throws a non-Error is still named in the failure log', async () => {
    // A rejection that is not an `Error` — a value from another realm, or one
    // rebuilt by structured clone. `error instanceof Error` is false, and the
    // failure log has to carry something better than `undefined`.
    class ForeignRejection {
      constructor(readonly reason: string) {}
      toString(): string {
        return this.reason;
      }
    }

    const throwing: ICDCSink = {
      name: 'foreign-thrower',
      connect: async () => undefined,
      disconnect: async () => undefined,
      emit: async () => {
        throw new ForeignRejection('upstream said no');
      },
    };
    const h = await harness({ dsnToSink: () => throwing, maxEmitAttempts: 2, retryBaseMs: 0 });

    h.engine.appendChange(change('orders'));
    await settle();

    expect(h.pump.getFailures()[0]!.error).toBe('upstream said no');
  });
});

describe('CDCSubscriptionPump — a projection that throws', () => {
  it('AC 48.29 — a broken projection is reported instead of breaking the engine', async () => {
    // `onChange` runs inside the engine's listener loop. A throw there abandons
    // every listener registered after this pump, so one caller's broken
    // projection would stop the engine's changes reaching anybody else.
    const engine = new CDCEngine({ nodeId: 'n' });
    const registry = new CDCPublicationRegistry({ nodeId: 'n', engine });
    await registry.createPublication('pub', ['orders']);
    await registry.createSubscription('sub', 'pub', 'test://sub');

    const other: CDCChangeEvent[] = [];
    engine.onChange((event) => other.push(event));

    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: () => new RecordingSink(),
      project: () => {
        throw new Error('no such column');
      },
    });
    pumps.push(pump);
    await pump.start();

    const events: CDCPumpEvent[] = [];
    pump.onEvent((event) => events.push(event));

    const appended = engine.appendChange(change('orders'));
    await settle();

    expect(other).toHaveLength(1);
    expect(events.find((e) => e.type === 'projection_failed')).toMatchObject({
      lsn: appended.lsn,
      table: 'orders',
      error: 'no such column',
    });
    expect(pump.getStatus()).toMatchObject({ delivered: 0, failed: 1 });
  });
});

describe('CDCSubscriptionPump — edges of the observation surface', () => {
  it('AC 48.25 — the disposer returned by onEvent stops the observations', async () => {
    const h = await harness({});
    const disposed: CDCPumpEvent[] = [];
    const dispose = h.pump.onEvent((event) => disposed.push(event));

    h.engine.appendChange(change('orders'));
    await settle();
    expect(disposed.some((e) => e.type === 'delivered')).toBe(true);

    const before = disposed.length;
    dispose();
    h.engine.appendChange(change('orders'));
    await settle();

    expect(disposed).toHaveLength(before);
    // The change itself still reached the sink; only the observation stopped.
    expect(h.pump.getStatus().delivered).toBe(2);
  });

  it('AC 48.26 — a sink that cannot disconnect still closes, with the reason named', async () => {
    const sink = new DisconnectFailingSink();
    const h = await harness({ dsnToSink: () => sink });

    await h.pump.stop();

    expect(h.pump.getStatus().subscriptions).toBe(0);
    const closed = h.events.find((e) => e.type === 'subscription_closed');
    expect(closed).toMatchObject({ subscriptionId: 'sub', error: 'socket already gone' });
  });
});
