/**
 * EdgeReplica — branch-completion tests.
 *
 * Targets the decision branches the existing suite leaves implicit:
 *   - connect() failure → _emitError + _scheduleReconnect (catch path)
 *   - _scheduleReconnect max-attempts exhaustion (recursive cap)
 *   - receive() event-handler exception isolation when connected (try/catch)
 *   - onEvent unsubscribe splice path (idx >= 0)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EdgeReplica, type EdgeSourceConfig } from './EdgeReplica';

const SRC: EdgeSourceConfig = {
  url: 'ws://localhost:1',
  protocol: 'websocket',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('EdgeReplica — connect failure and reconnection', () => {
  it('schedules a reconnect and emits error when connect fails', async () => {
    vi.useFakeTimers();
    const edge = new EdgeReplica();
    const onError = vi.fn();
    edge.onError(onError);

    // Force _simulateConnect to reject.
    vi.spyOn(edge as any, '_simulateConnect').mockRejectedValue(new Error('boom'));

    await edge.connect(SRC);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((edge as any)._reconnectAttempts).toBe(1);
    // A reconnect timer should be scheduled (exponential backoff).
    expect((edge as any)._reconnectTimer).not.toBeNull();
  });

  it('wraps a non-Error rejection in a new Error', async () => {
    vi.useFakeTimers();
    const edge = new EdgeReplica();
    const onError = vi.fn();
    edge.onError(onError);

    // Reject with a non-Error value to hit the `: new Error(String(err))` branch.
    vi.spyOn(edge as any, '_simulateConnect').mockRejectedValue('raw string failure');

    await edge.connect(SRC);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe('raw string failure');
  });

  it('stops reconnecting after max attempts and emits final error', async () => {
    vi.useFakeTimers();
    const edge = new EdgeReplica();
    // Set attempts to the cap so the next _scheduleReconnect hits the guard.
    (edge as any)._reconnectAttempts = 10;
    const onError = vi.fn();
    edge.onError(onError);

    (edge as any)._scheduleReconnect();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/Max reconnect attempts/);
  });

  it('reconnect timer re-runs connect against the remembered source', async () => {
    vi.useFakeTimers();
    const edge = new EdgeReplica();
    const connectSpy = vi.spyOn(edge, 'connect');

    // Establish a source and schedule a reconnect with minimal delay.
    (edge as any)._source = SRC;
    (edge as any)._reconnectAttempts = 0;
    (edge as any)._scheduleReconnect();

    // Advance past the backoff delay (2^0 * 1000 = 1000ms).
    await vi.advanceTimersByTimeAsync(1500);

    expect(connectSpy).toHaveBeenCalled();
  });
});

describe('EdgeReplica — event handler isolation when connected', () => {
  it('swallows a throwing event handler while connected', async () => {
    const edge = new EdgeReplica();
    await edge.connect(SRC);

    edge.onEvent(() => {
      throw new Error('handler crash');
    });
    let secondCalled = false;
    edge.onEvent(() => {
      secondCalled = true;
    });

    // Must not throw, and the second handler still fires.
    expect(() => edge.receive(1, 'x')).not.toThrow();
    expect(secondCalled).toBe(true);

    await edge.disconnect();
  });

  it('swallows a throwing sync-complete handler while connected', async () => {
    const edge = new EdgeReplica();
    await edge.connect(SRC);

    edge.onSyncComplete(() => {
      throw new Error('sync crash');
    });
    let secondCalled = false;
    edge.onSyncComplete(() => {
      secondCalled = true;
    });

    expect(() => edge.receive(1, 'x')).not.toThrow();
    expect(secondCalled).toBe(true);

    await edge.disconnect();
  });
});

describe('EdgeReplica — unsubscribe splice path', () => {
  it('removes a matching handler from the middle of the list', async () => {
    const edge = new EdgeReplica();
    await edge.connect(SRC);

    const a = vi.fn();
    const b = vi.fn();
    const unsubA = edge.onEvent(a);
    edge.onEvent(b);

    unsubA(); // splices handler at idx 0

    edge.receive(1, 'x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    await edge.disconnect();
  });

  it('unsubscribes an error handler', () => {
    const edge = new EdgeReplica();
    const handler = vi.fn();
    const unsub = edge.onError(handler);
    unsub(); // splices error handler at idx 0

    (edge as any)._emitError(new Error('x'));
    expect(handler).not.toHaveBeenCalled();
  });
});
