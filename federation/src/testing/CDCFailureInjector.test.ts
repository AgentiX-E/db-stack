import { describe, it, expect } from 'vitest';

// Imported through the subpath's own entry point, not the module beside it: the
// barrel is what a consumer resolves, and a barrel that names a file the build
// did not emit compiles and fails only here.
import { CDCFailureInjector } from './index';
import type { FailureConfig } from './index';
import { InMemoryCDCSink } from '../replication/InMemoryCDCSink';
import { CDCSinkResolver } from '../replication/CDCSinkResolver';
import { CDCEngine } from '../replication/CDCEngine';
import { CDCPublicationRegistry } from '../replication/CDCPublicationRegistry';
import { CDCSubscriptionPump } from '../replication/CDCSubscriptionPump';
import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

// The real shape: `type`, not `operation`, and an HLC timestamp as a bigint.
// A fixture that only had an `id` would have passed every assertion here while
// describing an object the sink contract does not have.
const evt = (id: string): CDCSinkEvent => ({
  id,
  type: 'insert',
  table: 'orders',
  key: id,
  data: {},
  timestamp: 1n,
});

const events = (n: number): CDCSinkEvent[] => Array.from({ length: n }, (_, i) => evt(`e${i}`));

/** A sink whose `disconnect()` fails after the connection is already gone. */
class DisconnectFailingSink implements ICDCSink {
  readonly name = 'disconnect-failing';
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    throw new Error('socket already gone');
  }
  async emit(): Promise<void> {}
}

describe('CDCFailureInjector — one budget per configured fault', () => {
  it('AC 48.30 — a latency spike cannot spend the connection drop it is configured beside', async () => {
    // The budget used to be a single counter shared by every entry and compared
    // against each entry's own limit. With these two entries the latency spike
    // fired once, `injectedFailures` reached 1, and `connection_drop` — whose
    // own limit was also 1 — saw the shared count already at its limit and never
    // fired again. A suite asserting "exactly-once under connection drops" was
    // measuring an injector that never dropped a connection.
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'latency_spike', probability: 1, latencyMs: 0, maxFailures: 1 },
      { type: 'connection_drop', failEveryN: 1, maxFailures: 1, on: 'emit' },
    ]);

    await injector.connect();
    await expect(injector.emit(events(1))).rejects.toThrow('injected connection drop during emit');

    expect(injector.failureCount).toBe(2);
    expect(injector.injectedBy('latency_spike')).toBe(1);
    expect(injector.injectedBy('connection_drop')).toBe(1);
    expect(injector.connected).toBe(false);
    expect(sink.getEvents()).toHaveLength(0);
  });

  it('AC 48.31 — two entries for the same fault are refused, because one could never fire', () => {
    // `find()` returned the first entry of a type, so the second was dead
    // configuration: a test that set `maxFailures: 5` on the second and watched
    // the first (`maxFailures: 1`) decide.
    expect(
      () => new CDCFailureInjector(new InMemoryCDCSink(), [{ type: 'duplicate_inject' }, { type: 'duplicate_inject' }]),
    ).toThrow(/configured twice/);

    // The same type at two different injection points is two different faults,
    // so that is allowed.
    const both = new CDCFailureInjector(new InMemoryCDCSink(), [
      { type: 'connection_drop', probability: 0, on: 'connect' },
      { type: 'connection_drop', probability: 0, on: 'emit' },
    ]);
    expect(both.failureCount).toBe(0);
  });

  it('AC 48.32b — an emit before the handshake is refused by name', async () => {
    const injector = new CDCFailureInjector(new InMemoryCDCSink(), []);
    await expect(injector.emit(events(1))).rejects.toThrow('failure-in-memory-cdc-sink: not connected');
    expect(injector.totalEmits).toBe(0);
  });

  it('AC 48.32 — a disconnect failure is reported, not swallowed', async () => {
    // An instrument that hides a fault is the one thing a fault injector must
    // not be. The wrapped sink's error reaches the caller.
    const injector = new CDCFailureInjector(new DisconnectFailingSink(), []);
    await injector.connect();

    await expect(injector.disconnect()).rejects.toThrow('socket already gone');
    expect(injector.connected).toBe(false);
  });
});

describe('CDCFailureInjector — where a drop may fire', () => {
  it('AC 48.33 — a drop on emit leaves the connection alone', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'connection_drop', probability: 1, on: 'emit', maxFailures: 1 },
    ]);

    await injector.connect();
    expect(injector.connected).toBe(true);

    await expect(injector.emit(events(1))).rejects.toThrow('drop during emit');
    expect(injector.connected).toBe(false);
  });

  it('AC 48.34 — a drop on connect fails the handshake and never the writes', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'connection_drop', probability: 1, on: 'connect', maxFailures: 1 },
    ]);

    await expect(injector.connect()).rejects.toThrow('injected connection failure');
    expect(injector.connected).toBe(false);

    // The single budget is spent, so the retry connects and the write lands.
    await injector.connect();
    await injector.emit(events(2));
    expect(sink.getEvents()).toHaveLength(2);
  });

  it('AC 48.35 — an every-N entry never fires the connect it does not count', async () => {
    // `failEveryN` counts `emit()` calls. A deterministic "fail the first write"
    // is therefore expressible, and a deterministic "fail the connect" is not —
    // probability is the only way to say that. Stated here because the two
    // controls look interchangeable and are not.
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [{ type: 'connection_drop', failEveryN: 1, maxFailures: 1 }]);

    await injector.connect();
    expect(injector.connected).toBe(true);
    await expect(injector.emit(events(1))).rejects.toThrow('drop during emit');
  });
});

describe('CDCFailureInjector — configuration it refuses', () => {
  it('AC 48.36 — a nonsensical number is rejected at construction', () => {
    const cases: Array<[Partial<FailureConfig>, RegExp]> = [
      [{ type: 'latency_spike', probability: 1.5 }, /probability must be within/],
      [{ type: 'latency_spike', probability: Number.NaN }, /probability must be within/],
      [{ type: 'latency_spike', failEveryN: -1 }, /failEveryN must be a non-negative integer/],
      [{ type: 'latency_spike', failEveryN: 1.5 }, /failEveryN must be a non-negative integer/],
      [{ type: 'latency_spike', maxFailures: -2 }, /maxFailures must be -1 or greater/],
      [{ type: 'latency_spike', latencyMs: -1 }, /latencyMs must be non-negative/],
    ];

    for (const [config, pattern] of cases) {
      expect(() => new CDCFailureInjector(new InMemoryCDCSink(), [config])).toThrow(pattern);
    }
  });

  it('AC 48.37 — `on` is refused on a type that has no choice of point', () => {
    // Only `connection_drop` can fire before the connection exists. Accepting
    // `on` on the others would be a field that is read by nothing.
    expect(
      () => new CDCFailureInjector(new InMemoryCDCSink(), [{ type: 'latency_spike', on: 'emit' } as never]),
    ).toThrow(/applies to connection_drop only/);
  });
});

describe('CDCFailureInjector — accounting', () => {
  it('AC 48.38 — reset re-arms every budget instead of clearing one counter', async () => {
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'latency_spike', failEveryN: 2, latencyMs: 0, maxFailures: 1 },
      { type: 'duplicate_inject', failEveryN: 3, maxFailures: 1 },
    ]);

    await injector.connect();
    await injector.emit(events(1)); // emit 1: neither
    await injector.emit(events(1)); // emit 2: latency
    await injector.emit(events(1)); // emit 3: duplicate

    expect(injector.injectedBy('latency_spike')).toBe(1);
    expect(injector.injectedBy('duplicate_inject')).toBe(1);
    expect(sink.getEvents()).toHaveLength(1 + 1 + 2);

    injector.reset();
    expect(injector.failureCount).toBe(0);
    expect(injector.totalEmits).toBe(0);

    await injector.emit(events(1));
    await injector.emit(events(1));
    expect(injector.injectedBy('latency_spike')).toBe(1);
  });

  it('AC 48.39 — a fault that could not fire spends no budget', async () => {
    // `partial_emit` and `reorder_inject` need at least two events in the call.
    // The pump emits one change at a time, so neither can fire through it, and
    // the check that decides not to inject must not consume the budget that a
    // later batch-shaped caller would need.
    const sink = new InMemoryCDCSink();
    const injector = new CDCFailureInjector(sink, [
      { type: 'partial_emit', failEveryN: 1, maxFailures: 1 },
      { type: 'reorder_inject', failEveryN: 1, maxFailures: 1 },
    ]);

    await injector.connect();
    await injector.emit(events(1));
    expect(injector.failureCount).toBe(0);
    expect(sink.getEvents().map((e) => e.id)).toEqual(['e0']);

    // A batch of two is what those two faults were for, and both still fire.
    await expect(injector.emit(events(2))).rejects.toThrow('partial emit');
    expect(injector.injectedBy('partial_emit')).toBe(1);
  });
});

describe('CDCFailureInjector — under the pump it instruments', () => {
  it('AC 48.40 — an injected drop is retried and the change lands once', async () => {
    // The instrument's job: make a sink refuse, and check that the delivery
    // rules still hold. One drop on the first write, then a clean sink; the
    // change must arrive exactly once, in LSN order, with the pump counting it.
    const engine = new CDCEngine({ nodeId: 'pump-injector' });
    const registry = new CDCPublicationRegistry({ nodeId: 'pump-injector', engine });
    await registry.createPublication('orders-pub', ['orders']);
    await registry.createSubscription('sub', 'orders-pub', 'memory://injector');

    const sink = new InMemoryCDCSink('injected');
    const injector = new CDCFailureInjector(sink, [
      { type: 'connection_drop', failEveryN: 1, maxFailures: 1, on: 'emit' },
    ]);
    const deliverable = new CDCSinkResolver(injector, {
      maxRetries: 1,
      retryBaseMs: 0,
      retryStrategy: 'none',
      healthCheckIntervalMs: 0,
    });

    const pump = new CDCSubscriptionPump({
      engine,
      registry,
      resolveSink: () => deliverable,
      retryBaseMs: 0,
    });
    await pump.start();

    const first = engine.appendChange({
      tableName: 'orders',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 1 },
    });
    const second = engine.appendChange({
      tableName: 'orders',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 2 },
    });

    for (let i = 0; i < 60 && pump.getStatus().delivered < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(injector.failureCount).toBe(1);
    expect(pump.getStatus()).toMatchObject({ delivered: 2, failed: 0 });
    expect(sink.getEvents().map((e) => e.id)).toEqual([`${first.lsn}:${first.txId}`, `${second.lsn}:${second.txId}`]);

    await pump.stop();
  });
});
