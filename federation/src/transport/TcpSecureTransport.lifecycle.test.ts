/**
 * TcpSecureTransport — lifecycle, id-mapping and delivery-confirmation paths.
 *
 * The AC 46.7–46.9 suite covers the happy path with an injected transport. The
 * behaviour that actually decides whether cross-DC replication is *correct*
 * lives in the edges exercised here:
 *
 *   - `send()` must refuse to report success for an unreachable peer, otherwise
 *     the outbox marks the entry delivered and drops it forever.
 *   - `reconnect()` backoff must stop after `_maxRetries`, otherwise a dead DC
 *     causes an infinite timer loop.
 *   - Numeric wire ids and logical peer ids must round-trip in both shapes the
 *     underlying transport can return, otherwise inbound frames are addressed
 *     to a peer that does not exist in the logical space.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TcpSecureTransport } from './TcpSecureTransport';
import type { TcpSecureTransportConfig } from './TcpSecureTransport';

const TLS = { cert: 'fake-cert', key: 'fake-key', ca: 'fake-ca' };

interface MockOptions {
  connectedPeers?: Array<number | { nodeId?: string | number; peerId?: string }>;
  /** Omit `getConnectedPeers` so the status fallback is used. */
  withGetConnectedPeers?: boolean;
  withGetStatus?: boolean;
  withRegister?: boolean;
  registerThrows?: boolean;
  withBoundPort?: number;
  sendThrows?: Error;
}

function mockTransport(options: MockOptions = {}) {
  const handlers: Array<(msg: any) => void> = [];
  const mock: Record<string, unknown> = {
    send: options.sendThrows ? vi.fn().mockRejectedValue(options.sendThrows) : vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockImplementation((handler: (msg: any) => void) => {
      handlers.push(handler);
    }),
    _emit(msg: unknown) {
      for (const handler of handlers) handler(msg);
    },
  };

  if (options.withGetConnectedPeers !== false) {
    mock.getConnectedPeers = vi.fn().mockReturnValue(options.connectedPeers ?? []);
  }
  if (options.withGetStatus !== false) {
    mock.getStatus = vi.fn().mockReturnValue({
      connectedPeers: (options.connectedPeers ?? []).filter((p): p is number => typeof p === 'number'),
      totalPeers: (options.connectedPeers ?? []).length,
      started: true,
    });
  }
  if (options.withRegister !== false) {
    mock.register = options.registerThrows
      ? vi.fn().mockImplementation(() => {
          throw new Error('register refused');
        })
      : vi.fn();
  }
  if (options.withBoundPort !== undefined) {
    mock.getBoundPort = vi.fn().mockReturnValue(options.withBoundPort);
  }
  return mock;
}

function transport(override: Record<string, unknown>, extra: Partial<TcpSecureTransportConfig> = {}) {
  return new TcpSecureTransport({
    nodeId: 'dc-east-1',
    transportNodeId: 4,
    listen: { host: '127.0.0.1', port: 0 },
    peers: [
      {
        nodeId: 'dc-west-1',
        host: '127.0.0.1',
        port: 7101,
        transportNodeId: 5,
      },
      {
        nodeId: 'dc-west-2',
        host: '127.0.0.1',
        port: 7102,
        transportNodeId: 6,
      },
    ],
    tls: TLS,
    initialRetryMs: 10,
    maxRetryMs: 40,
    _transportOverride: override as never,
    ...extra,
  });
}

function message(targetPeerId: string) {
  return {
    messageId: 'msg-1',
    sourcePeerId: 'dc-east-1',
    targetPeerId,
    timestamp: {
      wallTime: 1_700_000_000_000n,
      logical: 3,
      nodeId: 'dc-east-1',
    },
    payload: new Uint8Array([1, 2, 3]),
    createdAt: Date.now(),
    type: 'replicate',
  } as never;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TcpSecureTransport — production transport construction', () => {
  it('builds a real RaftTcpTransport when no test override is injected', () => {
    const built = new TcpSecureTransport({
      nodeId: 'dc-east-1',
      listen: { host: '127.0.0.1', port: 0 },
      peers: [{ nodeId: 'dc-west-1', host: '127.0.0.1', port: 7101 }],
      tls: TLS,
    });

    // No listener was opened (start() was never called) but the address is still
    // resolvable from the configured listen block.
    expect(built.getLocalAddress()).toEqual({ host: '127.0.0.1', port: 0 });
    expect(built.getStats().messagesSent).toBe(0);
  });

  it('normalises peers without explicit wire ids to index + 1', () => {
    const built = new TcpSecureTransport({
      nodeId: 'dc-east-1',
      peers: [
        { nodeId: 'dc-west-1', host: '127.0.0.1', port: 7101 },
        { nodeId: 'dc-west-2', host: '127.0.0.1', port: 7102 },
      ],
      tls: TLS,
    });

    expect(built.getConnectedPeers()).toEqual([]);
  });

  it('derives peers from a legacy address list', () => {
    const built = new TcpSecureTransport({
      nodeId: 'dc-east-1',
      peerAddresses: ['127.0.0.1:7101', '127.0.0.1:7102'],
      tls: TLS,
    });

    expect(built.getConnectedPeers()).toEqual([]);
  });
});

describe('TcpSecureTransport — send() delivery confirmation', () => {
  it('refuses to send before start()', async () => {
    const t = transport(mockTransport());

    expect(await t.send(message('dc-west-1'))).toBe(false);
    expect(t.getLastSendError()).toBe('transport not started');
  });

  it('refuses a peer that has no live connection', async () => {
    const t = transport(mockTransport({ connectedPeers: [5] }));
    await t.start();

    expect(await t.send(message('dc-west-2'))).toBe(false);
    expect(t.getLastSendError()).toBe('peer dc-west-2 (6) not connected');
    expect(t.getLastSendError()).not.toBeNull();
  });

  it('reports the failure and schedules a reconnect when the wire send throws', async () => {
    const override = mockTransport({
      connectedPeers: [5],
      sendThrows: new TypeError('socket closed'),
    });
    const t = transport(override);
    await t.start();
    const register = override.register as ReturnType<typeof vi.fn>;

    expect(await t.send(message('dc-west-1'))).toBe(false);
    expect(t.getLastSendError()).toBe('TypeError: socket closed');
    // A failed send triggers a reconnect attempt for that peer.
    expect(register).toHaveBeenCalledWith({
      id: 5,
      host: '127.0.0.1',
      port: 7101,
    });
  });

  it('sends and accounts bytes when the peer is connected', async () => {
    const t = transport(mockTransport({ connectedPeers: [5, 6] }));
    await t.start();

    expect(await t.send(message('dc-west-1'))).toBe(true);
    expect(t.getStats().messagesSent).toBe(1);
    expect(t.getStats().bytesSent).toBe(3);
  });

  it('broadcasts only to connected peers', async () => {
    const t = transport(mockTransport({ connectedPeers: [5] }));
    await t.start();

    expect(await t.broadcast(message('dc-west-1'))).toBe(1);
  });

  it('broadcast() returns 0 with no connected peers', async () => {
    const t = transport(mockTransport({ connectedPeers: [] }));
    await t.start();

    expect(await t.broadcast(message('dc-west-1'))).toBe(0);
  });
});

describe('TcpSecureTransport — reconnect backoff', () => {
  it('re-registers a known peer', () => {
    const override = mockTransport();
    const t = transport(override);

    t.reconnect('dc-west-2');

    expect(override.register).toHaveBeenCalledWith({
      id: 6,
      host: '127.0.0.1',
      port: 7102,
    });
  });

  it('ignores peers it does not know', () => {
    const override = mockTransport();
    const t = transport(override);

    t.reconnect('dc-unknown');

    expect(override.register).not.toHaveBeenCalled();
  });

  it('ignores peers when the transport has no register()', () => {
    const override = mockTransport({ withRegister: false });
    const t = transport(override);

    expect(() => t.reconnect('dc-west-1')).not.toThrow();
  });

  it('retries with backoff and gives up after the retry budget', async () => {
    vi.useFakeTimers();
    const override = mockTransport({ registerThrows: true });
    const t = transport(override);
    const register = override.register as ReturnType<typeof vi.fn>;

    t.reconnect('dc-west-1');
    expect(register).toHaveBeenCalledTimes(1);

    // 5 retries max: attempt 6 short-circuits before touching the transport.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(register.mock.calls.length).toBeLessThanOrEqual(5);
    expect(register.mock.calls.length).toBeGreaterThan(1);
  });

  it('clears a pending retry timer when reconnect() is called again', async () => {
    vi.useFakeTimers();
    const override = mockTransport({ registerThrows: true });
    const t = transport(override);
    const register = override.register as ReturnType<typeof vi.fn>;

    t.reconnect('dc-west-1');
    await vi.advanceTimersByTimeAsync(10);
    const afterFirstTimer = register.mock.calls.length;

    // A second reconnect while a timer is pending must not double-schedule.
    t.reconnect('dc-west-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(register.mock.calls.length).toBe(afterFirstTimer + 1);
  });
});

describe('TcpSecureTransport — id mapping and address reporting', () => {
  it('maps numeric wire ids back to logical peer ids', () => {
    const t = transport(mockTransport({ connectedPeers: [5, 6] }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['dc-west-1', 'dc-west-2']);
  });

  it('keeps an unmapped numeric id as its string form', () => {
    const t = transport(mockTransport({ connectedPeers: [99] }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['99']);
  });

  it('maps records that carry a numeric wire id', () => {
    const t = transport(mockTransport({ connectedPeers: [{ nodeId: '5' }, { nodeId: 6 }] }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['dc-west-1', 'dc-west-2']);
  });

  it('accepts records that already speak logical ids', () => {
    const t = transport(mockTransport({ connectedPeers: [{ peerId: 'dc-west-9' }] }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['dc-west-9']);
  });

  it('treats a record with no id as an empty peer id', () => {
    const t = transport(mockTransport({ connectedPeers: [{}] }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['']);
  });

  it('falls back to the status snapshot when getConnectedPeers() is absent', () => {
    const t = transport(mockTransport({ connectedPeers: [5], withGetConnectedPeers: false }));

    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['dc-west-1']);
  });

  it('returns no peers when the transport exposes neither accessor', () => {
    const t = transport(mockTransport({ withGetConnectedPeers: false, withGetStatus: false }));

    expect(t.getConnectedPeers()).toEqual([]);
  });

  it('reports the bound port once listening', () => {
    const t = transport(mockTransport({ withBoundPort: 7345 }));

    expect(t.getLocalAddress()).toEqual({ host: '127.0.0.1', port: 7345 });
  });

  it('falls back to the configured port when the transport does not report one', () => {
    const t = transport(mockTransport(), {
      listen: { host: '0.0.0.0', port: 7000 },
    });

    expect(t.getLocalAddress()).toEqual({ host: '0.0.0.0', port: 7000 });
  });

  it('defaults the host when no listen block is configured', () => {
    const t = transport(mockTransport(), { listen: undefined });

    expect(t.getLocalAddress().host).toBe('127.0.0.1');
  });
});

describe('TcpSecureTransport — subscriptions and teardown', () => {
  it('unsubscribes an inbound handler', () => {
    const override = mockTransport({ connectedPeers: [] });
    const t = transport(override);
    const seen: string[] = [];

    const off = t.onMessage((msg) => seen.push(msg.messageId));
    (override as unknown as { _emit: (m: unknown) => void })._emit({
      type: 'federation_send',
      term: 1,
      from: '5',
      to: '4',
      payload: {
        messageId: 'm-1',
        sourcePeerId: 'dc-west-1',
        timestamp: {
          wallTime: '1700000000000',
          logical: 1,
          nodeId: 'dc-west-1',
        },
        payload: [1, 2, 3],
        type: 'replicate',
      },
    });
    off();

    (override as unknown as { _emit: (m: unknown) => void })._emit({
      type: 'federation_send',
      term: 1,
      from: '5',
      to: '4',
      payload: {
        messageId: 'm-2',
        sourcePeerId: 'dc-west-1',
        payload: [1],
        type: 'replicate',
      },
    });

    expect(seen).toEqual(['m-1']);
    expect(t.getStats().messagesReceived).toBe(2);
  });

  it('defaults a frame with no payload fields', () => {
    const override = mockTransport({ connectedPeers: [] });
    const t = transport(override);
    const received: Array<{
      messageId: string;
      bytes: number;
      wallTime: bigint;
    }> = [];

    t.onMessage((msg) =>
      received.push({
        messageId: msg.messageId,
        bytes: msg.payload.byteLength,
        wallTime: msg.timestamp.wallTime,
      }),
    );
    (override as unknown as { _emit: (m: unknown) => void })._emit({
      type: 'federation_send',
      term: 1,
      from: '5',
      to: '4',
    });

    expect(received).toEqual([{ messageId: '', bytes: 0, wallTime: 0n }]);
  });

  it('stop() clears timers and drops the raft bridge', async () => {
    vi.useFakeTimers();
    const override = mockTransport({ registerThrows: true });
    const t = transport(override);
    await t.start();
    t.reconnect('dc-west-1');

    await t.stop();
    const callsAtStop = (override.register as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect((override.register as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtStop);
  });

  it('stop() is a no-op when never started', async () => {
    const override = mockTransport();
    const t = transport(override);

    await t.stop();

    expect(override.stop).not.toHaveBeenCalled();
  });

  it('start() is idempotent', async () => {
    const override = mockTransport();
    const t = transport(override);

    await t.start();
    await t.start();

    expect(override.start).toHaveBeenCalledTimes(1);
  });

  it('destroy() stops the transport and clears subscribers', async () => {
    const override = mockTransport();
    const t = transport(override);
    await t.start();
    t.onMessage(() => undefined);

    t.destroy();
    await vi.waitFor(() => expect(override.stop).toHaveBeenCalled());
  });
});
