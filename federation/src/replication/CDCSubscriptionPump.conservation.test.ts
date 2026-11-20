/**
 * CDCSubscriptionPump — the ledger, under every way a change can end.
 *
 * `AC 48.19` asserted that the status reports a queue depth; nothing asserted
 * that the numbers added up, so a change accepted and then lost between routing
 * and delivery left no trace. These cases check the identity from
 * `pumpConservation()` in the four states a change can reach, each produced by
 * the pump itself rather than by a hand-built status object:
 *
 *   AC 97.1  everything delivered: accepted equals delivered
 *   AC 97.2  an overflowing queue drops the newest, and the drop is counted
 *   AC 97.3  a sink that always refuses spends the budget and is counted
 *   AC 97.4  a throwing projection is counted apart from a delivery failure
 *   AC 97.5  stop() abandons queued changes and counts them as dropped
 *   AC 97.6  the rendered exposition reports a zero unaccounted gauge
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CDCEngine } from './CDCEngine';
import { CDCPublicationRegistry } from './CDCPublicationRegistry';
import { CDCSubscriptionPump } from './CDCSubscriptionPump';
import type { CDCSubscriptionPumpConfig } from './CDCSubscriptionPump';
import { InMemoryCDCSink } from './InMemoryCDCSink';
import { pumpConservation, renderPumpMetrics } from '../monitoring/cdc-metrics';
import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

const pumps: CDCSubscriptionPump[] = [];

afterEach(async () => {
  while (pumps.length > 0) await pumps.pop()!.stop();
});

/** Accepts nothing, immediately. */
class RefusingSink implements ICDCSink {
  readonly name = 'refusing';
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async emit(_events: CDCSinkEvent[]): Promise<void> {
    throw new Error('the receiver is down');
  }
}

/** Blocks every emit until released, so a queue can be observed mid-flight. */
class BlockingSink implements ICDCSink {
  readonly name = 'blocking';
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  started = false;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async emit(_events: CDCSinkEvent[]): Promise<void> {
    this.started = true;
    await this.gate;
  }
  open(): void {
    this.release();
  }
}

async function settle(rounds = 24): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Harness {
  engine: CDCEngine;
  pump: CDCSubscriptionPump;
  sink: ICDCSink;
}

async function harness(
  makeSink: () => ICDCSink,
  options: {
    maxPendingPerSubscription?: number;
    maxEmitAttempts?: number;
    retryBaseMs?: number;
    project?: CDCSubscriptionPumpConfig['project'];
  } = {},
): Promise<Harness> {
  const engine = new CDCEngine({ nodeId: 'pump-node' });
  const registry = new CDCPublicationRegistry({ nodeId: 'pump-node', engine });
  await registry.createPublication('pub', ['orders']);
  await registry.createSubscription('sub', 'pub', 'test://sink');

  const sink = makeSink();
  const pump = new CDCSubscriptionPump({
    engine,
    registry,
    resolveSink: () => sink,
    maxPendingPerSubscription: options.maxPendingPerSubscription,
    maxEmitAttempts: options.maxEmitAttempts,
    retryBaseMs: options.retryBaseMs ?? 1,
    project: options.project,
  });
  pumps.push(pump);
  await pump.start();
  return { engine, pump, sink };
}

const change = () => ({
  tableName: 'orders',
  operation: 'insert' as const,
  oldValues: null,
  newValues: { id: 1 },
});

describe('CDCSubscriptionPump — the ledger', () => {
  it('AC 97.1: everything delivered, accepted equals delivered', async () => {
    const h = await harness(() => new InMemoryCDCSink());
    for (let i = 0; i < 25; i++) h.engine.appendChange(change());
    await settle();

    const status = h.pump.getStatus();
    expect(status.accepted).toBe(25);
    expect(status.delivered).toBe(25);
    expect(pumpConservation(status)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 97.2: an overflowing queue drops the newest, and the drop is counted', async () => {
    // A sink that never finishes, with room for two: the third change has
    // nowhere to go, and the identity is what proves it was not silently lost.
    const sink = new BlockingSink();
    const h = await harness(() => sink, { maxPendingPerSubscription: 2 });

    h.engine.appendChange(change());
    await settle(4);
    expect(sink.started).toBe(true);

    for (let i = 0; i < 4; i++) h.engine.appendChange(change());
    await settle(4);

    const midFlight = h.pump.getStatus();
    expect(midFlight.accepted).toBe(5);
    expect(midFlight.dropped).toBe(3);
    expect(pumpConservation(midFlight)).toMatchObject({ unaccounted: 0, balanced: true });

    sink.open();
    await settle(16);
    const settled = h.pump.getStatus();
    expect(settled.delivered).toBe(2);
    expect(pumpConservation(settled)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 97.3: a sink that always refuses spends the budget and is counted', async () => {
    const h = await harness(() => new RefusingSink(), { maxEmitAttempts: 2 });

    h.engine.appendChange(change());
    h.engine.appendChange(change());
    await settle(32);

    const status = h.pump.getStatus();
    expect(status.accepted).toBe(2);
    expect(status.failed).toBe(2);
    expect(status.delivered).toBe(0);
    expect(pumpConservation(status)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 97.4: a throwing projection is counted apart from a delivery failure', async () => {
    const h = await harness(() => new InMemoryCDCSink(), {
      project: () => {
        throw new Error('the caller projected a field that is not there');
      },
    });

    h.engine.appendChange(change());
    await settle();

    const status = h.pump.getStatus();
    // The change never reached a subscription — there was nothing to route —
    // so `accepted` must not move, and `failed` must not either.
    expect(status.projectionFailed).toBe(1);
    expect(status.failed).toBe(0);
    expect(status.accepted).toBe(0);
    expect(pumpConservation(status)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 97.5: stop() abandons queued changes and counts them as dropped', async () => {
    const sink = new BlockingSink();
    const h = await harness(() => sink, { maxPendingPerSubscription: 10 });

    h.engine.appendChange(change());
    await settle(4);
    for (let i = 0; i < 3; i++) h.engine.appendChange(change());
    await settle(4);

    await h.pump.stop();
    sink.open();
    await settle(8);

    const status = h.pump.getStatus();
    expect(status.accepted).toBe(4);
    // All four, including the one whose emit was still in flight: it is still
    // in the queue — the head is only shifted once its outcome is known — so
    // `close()` abandons it with the rest, and the ledger balances without an
    // in-flight bucket that could be counted twice.
    expect(status.dropped).toBe(4);
    expect(status.delivered).toBe(0);
    expect(status.pending).toEqual({});
    expect(pumpConservation(status)).toMatchObject({ unaccounted: 0, balanced: true });
  });

  it('AC 97.6: the rendered exposition reports a zero unaccounted gauge', async () => {
    const h = await harness(() => new InMemoryCDCSink());
    for (let i = 0; i < 3; i++) h.engine.appendChange(change());
    await settle();

    const rendered = renderPumpMetrics(h.pump.getStatus(), { node: 'dc-east' });
    expect(rendered).toContain('db_federation_cdc_pump_accepted_total{node="dc-east"} 3');
    expect(rendered).toContain('db_federation_cdc_pump_delivered_total{node="dc-east"} 3');
    expect(rendered).toContain('db_federation_cdc_pump_unaccounted{node="dc-east"} 0');
  });
});
