/**
 * EdgeReplica — the connection lifecycle a real TLS socket depends on.
 *
 * IT-91/92 closed the intake and arbitration path, but a real socket exposes
 * three lifecycle gaps the simulated dial could not: bytes that arrive while
 * the dial promise is still in flight, a backoff timer that outlives the dial
 * it was scheduled for, and a socket that cannot be torn down because the
 * engine-agnostic dial returned nothing to close.
 *
 * Every case below is a red test first: it names the wrong observable state
 * before the lifecycle is fixed. No mocks — the dial is a plain callback and
 * the timers are the runner's own clock advanced deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import { EdgeReplica, type EdgeSourceConfig } from './EdgeReplica';

const SOURCE: EdgeSourceConfig = { url: 'tls://edge:9443', protocol: 'websocket' };

describe('EdgeReplica — frames arriving during the dial are not lost', () => {
  it('a frame pushed while connectTransport is in flight is buffered then flushed', async () => {
    const edge = new EdgeReplica({
      connectTransport: async () => {
        // A real TLS socket can deliver the first bytes before the dial
        // promise resolves. The replica must not drop them silently.
        edge.receive(1, 'early');
      },
    });
    await edge.connect(SOURCE);
    expect(edge.getAllData()).toEqual([{ lsn: 1, payload: 'early' }]);
    // The flushed frame ran the full intake path, including the lag=0
    // transition to synced — evidence it was applied, not merely buffered.
    expect(edge.getSyncStatus().state).toBe('synced');
    edge.disconnect();
  });

  it('an error raised while dialing is reported even though a frame was buffered', async () => {
    const errors: string[] = [];
    const edge = new EdgeReplica({
      connectTransport: async () => {
        edge.receive(2, 'early');
        throw new Error('dial-refused');
      },
    });
    edge.onError((e) => errors.push(e.message));
    await edge.connect(SOURCE);
    expect(errors).toContain('dial-refused');
    // A failed dial keeps no data: buffering is not an uncommitted append.
    expect(edge.getAllData()).toEqual([]);
    edge.disconnect();
  });
});

describe('EdgeReplica — backoff timers follow the live dial', () => {
  it('a successful dial disarms the backoff left by an earlier failure', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const edge = new EdgeReplica({
        connectTransport: async () => {
          attempts++;
          if (attempts === 1) throw new Error('first-dial-fails');
        },
      });
      edge.onError(() => {});
      await edge.connect(SOURCE); // fails → schedules T1
      await edge.connect(SOURCE); // succeeds → T1 must be gone
      vi.advanceTimersByTime(60_000);
      expect(attempts).toBe(2);
      edge.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect after concurrent failed dials leaves no timer that reconnects', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const edge = new EdgeReplica({
        connectTransport: async () => {
          attempts++;
          throw new Error('dial-fails');
        },
      });
      edge.onError(() => {});
      await Promise.all([edge.connect(SOURCE), edge.connect(SOURCE)]);
      edge.disconnect();
      vi.advanceTimersByTime(60_000);
      expect(attempts).toBe(2); // only the two initial dials, no timer-driven retry
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EdgeReplica — a real transport can be torn down', () => {
  it('disconnect calls the dispose handle returned by the dial', async () => {
    let disposed = 0;
    const edge = new EdgeReplica({
      connectTransport: async () => ({
        dispose: () => {
          disposed++;
        },
      }),
    });
    await edge.connect(SOURCE);
    expect(disposed).toBe(0);
    await edge.disconnect();
    expect(disposed).toBe(1);
  });

  it('a transport that cannot dispose still disconnects without error', async () => {
    const edge = new EdgeReplica({
      connectTransport: async () => undefined,
    });
    await edge.connect(SOURCE);
    await expect(edge.disconnect()).resolves.toBeUndefined();
  });
});
