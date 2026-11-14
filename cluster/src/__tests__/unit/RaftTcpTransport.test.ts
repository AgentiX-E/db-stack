/**
 * RaftTcpTransport — Unit Tests
 *
 * Strategy: Test ONLY public API surface that doesn't start() the transport.
 * No _processData tests (requires TLS module which hangs the fork).
 * No async Promise-based event tests (vitest fork timer issue).
 *
 * Acceptance Criteria:
 *   AC 32.1: Constructor config / self + peer registration
 *   AC 32.2: register() node management
 *   AC 32.3: getStatus() before start
 *   AC 32.4: getCircuitBreakerMetrics() when pool is null
 *   AC 32.5: sendToPeer() is no-op when stopped
 *   AC 32.6: send() is no-op when stopped
 *   AC 32.10: TLS config validation (start() throws)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RaftTcpTransport, type RaftNodeConfig } from '../../consensus/transport/RaftTcpTransport';
import { MessageCodec } from '../../consensus/transport/MessageCodec';

function validConfig(overrides: any = {}) {
  return {
    node: { id: 1, host: '127.0.0.1', port: 9001 },
    peers: [
      { id: 2, host: '127.0.0.1', port: 9002 },
      { id: 3, host: '127.0.0.1', port: 9003 },
    ],
    tls: {
      cert: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
      key: '-----BEGIN KEY-----\nMOCK\n-----END KEY-----',
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    },
    ...overrides,
  };
}

describe('AC 32.1: Constructor', () => {
  it('stores config and registers self + peers', () => {
    const t = new RaftTcpTransport(validConfig());
    expect(t).toBeInstanceOf(RaftTcpTransport);
    expect(t).toBeInstanceOf(EventEmitter);
    expect(t.getStatus().totalPeers).toBe(2);
    expect(t.getStatus().started).toBe(false);
  });

  it('accepts empty peers', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    expect(t.getStatus().totalPeers).toBe(0);
  });
});

describe('AC 32.2: register()', () => {
  it('adds a node', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    t.register({ id: 5, host: '10.0.0.5', port: 9005 });
    expect(t.getStatus().totalPeers).toBe(1);
  });

  it('updates existing node', () => {
    const t = new RaftTcpTransport(validConfig({ peers: [{ id: 2, host: 'old', port: 9002 }] }));
    t.register({ id: 2, host: 'new', port: 9999 });
    expect(t.getStatus().totalPeers).toBe(1);
  });
});

describe('AC 32.3: getStatus()', () => {
  it('returns correct initial state', () => {
    const t = new RaftTcpTransport(validConfig());
    expect(t.getStatus()).toEqual({
      connectedPeers: [],
      totalPeers: 2,
      started: false,
    });
  });
});

describe('AC 32.4: getCircuitBreakerMetrics()', () => {
  it('returns [] when pool is null', () => {
    expect(new RaftTcpTransport(validConfig()).getCircuitBreakerMetrics()).toEqual([]);
  });
});

describe('AC 32.5: sendToPeer()', () => {
  it('no-op when stopped', () => {
    expect(() => new RaftTcpTransport(validConfig()).sendToPeer(2, Buffer.from('x'))).not.toThrow();
  });

  it('no-op after stop()', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.stop();
    expect(() => t.sendToPeer(2, Buffer.from('x'))).not.toThrow();
  });
});

describe('AC 32.6: send()', () => {
  it('no-op when stopped', async () => {
    await expect(
      new RaftTcpTransport(validConfig()).send(1, [{ msgType: 0, from: '1', to: '2', term: '1' }]),
    ).resolves.toBeUndefined();
  });

  it('skips self messages', async () => {
    const t = new RaftTcpTransport(validConfig());
    await expect(t.send(1, [{ msgType: 0, from: '1', to: '1', term: '1' }])).resolves.toBeUndefined();
  });
});

describe('AC 32.10: TLS config validation', () => {
  it('rejects empty cert', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: '', key: 'k', ca: 'c' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
  it('rejects empty key', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: 'c', key: '', ca: 'c' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
  it('rejects empty ca', async () => {
    await expect(new RaftTcpTransport(validConfig({ tls: { cert: 'c', key: 'k', ca: '' } })).start()).rejects.toThrow(
      /mTLS/,
    );
  });
});
