/**
 * ExactlyOnceCDCPipeline — branch-completion tests.
 *
 * Targets the remaining uncovered decision branches and delegated CDC-control
 * methods not exercised by the main AC 47.x suite:
 *   - CDC control delegation (watch/unwatch/getWatchedTables)
 *   - processInbound invalid-payload decode failure
 *   - getLastConfirmedLSN nullish fallback for an unknown table
 *   - startPump idempotence, pumpCycle re-entrancy guard
 *   - targetPeerId `remoteNodeId ?? ''` fallback
 *   - checkpoint-advance skip on undecodable payload
 *   - non-Error rejection → String(err) on the inner and outer pump catch
 *   - outer pumpCycle catch (fetchOldestPending rejection)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { ExactlyOnceCDCPipeline, type ExactlyOnceCDCPipelineConfig } from '../../replication/ExactlyOnceCDCPipeline';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ITransport } from '../../interfaces/transport/ITransport';
import type { TransportMessage } from '../../interfaces/transport/TransportMessage';
import { HLC } from '../../hlc/HLC';

// Scoped to this process so a concurrent run on the same machine cannot delete
// this run's LMDB files. See the note in ExactlyOnceCDCPipeline.test.ts.
const TEST_DIR = path.join(tmpdir(), `db-federation-cdc-branches-${process.pid}`);

function cleanDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<ExactlyOnceCDCPipelineConfig>): ExactlyOnceCDCPipelineConfig {
  return {
    nodeId: 'n1',
    cdcConfig: { nodeId: 'n1' },
    outboxConfig: { dataDir: path.join(TEST_DIR, 'outbox') },
    pumpIntervalMs: 50,
    pumpBatchSize: 100,
    maxPending: 1000,
    dedupTtlMs: 300_000,
    ...overrides,
  };
}

function fakeTransport(overrides?: Partial<ITransport>): ITransport {
  return {
    send: vi.fn(async () => true),
    broadcast: vi.fn(async () => 1),
    onMessage: vi.fn(() => vi.fn()),
    getConnectedPeers: vi.fn(() => []),
    getStats: vi.fn(() => ({
      peersConnected: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    })),
    ...overrides,
  };
}

describe('ExactlyOnceCDCPipeline — CDC control delegation', () => {
  let p: ExactlyOnceCDCPipeline;

  beforeEach(() => {
    cleanDir();
    p = new ExactlyOnceCDCPipeline(makeConfig());
  });
  afterEach(async () => {
    try {
      await p.cleanup();
    } catch {
      /* checkpoint file may not exist if never started */
    }
  });

  it('unwatchTable delegates to the CDC engine', () => {
    p.watchTable('users');
    expect(p.getWatchedTables()).toContain('users');
    p.unwatchTable('users');
    expect(p.getWatchedTables()).not.toContain('users');
  });
});

describe('ExactlyOnceCDCPipeline — inbound decode failure', () => {
  let p: ExactlyOnceCDCPipeline;

  beforeEach(() => {
    cleanDir();
    p = new ExactlyOnceCDCPipeline(makeConfig());
  });
  afterEach(async () => {
    try {
      await p.cleanup();
    } catch {
      /* checkpoint file may not exist if never started */
    }
  });

  it('rejects a payload that is not valid JSON (event_failed path)', () => {
    const msg: TransportMessage = {
      messageId: 'bad-1',
      sourcePeerId: 'n1',
      targetPeerId: 'n1',
      payload: new TextEncoder().encode('not-json{{{'),
      timestamp: new HLC('n1', 0n, 0),
      createdAt: Date.now(),
      type: 'cdc_event:users',
    };

    const failures: string[] = [];
    p.onEvent((e) => {
      if (e.type === 'event_failed') failures.push(e.error ?? '');
    });

    const result = p.processInbound(msg);
    expect(result.accepted).toBe(false);
    expect(result.event).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Failed to decode/);
  });
});

describe('ExactlyOnceCDCPipeline — checkpoint & pump edge branches', () => {
  let p: ExactlyOnceCDCPipeline;

  beforeEach(() => {
    cleanDir();
    p = new ExactlyOnceCDCPipeline(makeConfig());
  });
  afterEach(async () => {
    try {
      await p.cleanup();
    } catch {
      /* checkpoint file may not exist if never started */
    }
  });

  it('getLastConfirmedLSN returns null for an unknown table (?? null)', async () => {
    await p.start();
    expect(p.getLastConfirmedLSN('unknown-table')).toBeNull();
  });

  it('startPump is idempotent (second call early-returns)', async () => {
    p['startPump']();
    const firstTimer = p['pumpTimer'];
    p['startPump'](); // should no-op
    expect(p['pumpTimer']).toBe(firstTimer);
  });

  it("builds targetPeerId `remoteNodeId ?? ''` when remoteNodeId is absent", async () => {
    // No remoteNodeId configured → the pump fills targetPeerId with ''
    const transport = fakeTransport({
      send: vi.fn(async (msg: TransportMessage) => {
        expect(msg.targetPeerId).toBe('');
        return true;
      }),
    });
    const cfg = makeConfig({ transport });
    const pl = new ExactlyOnceCDCPipeline(cfg);
    await pl.start();

    // Produce an event then force a pump cycle.
    pl.appendChange({
      tableName: 't',
      operation: 'insert',
      oldValues: null,
      newValues: { a: 1 },
    });
    await pl['pumpCycle']();

    expect(transport.send).toHaveBeenCalled();
    await pl.cleanup();
  });

  it('pumpCycle re-entrancy guard returns early when already pumping', async () => {
    p['pumpActive'] = true;
    await p['pumpCycle'](); // should return immediately, resetting nothing
    expect(p['pumpActive']).toBe(true);
    p['pumpActive'] = false;
  });

  it('transport.send rejecting with a non-Error → String(err) fallback', async () => {
    const transport = fakeTransport({
      // A non-Error rejection is the fixture: the pump must stringify it.
      send: vi.fn(() => Promise.reject('string-failure')),
    });
    const cfg = makeConfig({ transport });
    const pl = new ExactlyOnceCDCPipeline(cfg);
    await pl.start();

    const pumpErrors: string[] = [];
    pl.onEvent((e) => {
      if (e.type === 'pump_error') pumpErrors.push(e.error ?? '');
    });

    pl.appendChange({
      tableName: 't',
      operation: 'insert',
      oldValues: null,
      newValues: { a: 1 },
    });
    await pl['pumpCycle']();

    expect(pumpErrors.some((m) => m === 'string-failure')).toBe(true);
    await pl.cleanup();
  });

  it('fetchOldestPending rejecting → outer catch emits pump_error', async () => {
    const transport = fakeTransport();
    const cfg = makeConfig({ transport });
    const pl = new ExactlyOnceCDCPipeline(cfg);
    await pl.start();

    const outboxErrors: string[] = [];
    pl.onEvent((e) => {
      if (e.type === 'pump_error') outboxErrors.push(e.error ?? '');
    });

    // Force getPendingCount / fetchOldestPending to reject (non-Error).
    vi.spyOn(pl['outbox'], 'getPendingCount').mockRejectedValue('outbox-boom');

    await pl['pumpCycle']();

    expect(outboxErrors).toContain('outbox-boom');
    await pl.cleanup();
  });

  it('checkpoint-advance skip when payload is undecodable (inner catch)', async () => {
    const transport = fakeTransport({
      send: vi.fn(async () => true),
    });
    const cfg = makeConfig({ transport });
    const pl = new ExactlyOnceCDCPipeline(cfg);
    await pl.start();

    // Inject a pending outbox entry whose payload is not valid JSON so that
    // the checkpoint-advance inner try/catch skips silently.
    vi.spyOn(pl['outbox'], 'getPendingCount').mockResolvedValue(1);
    vi.spyOn(pl['outbox'], 'fetchOldestPending').mockResolvedValue([
      {
        id: 'lsn0:tx0',
        msgId: 'lsn0:tx0',
        targetPeerIds: ['n1'],
        payload: new TextEncoder().encode('not-json!!!'),
        timestamp: new HLC('n1', 0n, 0),
        type: 'cdc_event:users',
        status: 'pending',
        createdAt: Date.now(),
        lastAttemptAt: null,
        attemptCount: 0,
        lastError: null,
      },
    ]);

    await pl['pumpCycle']();

    // send succeeded, markDelivered was reached; no throw on undecodable payload
    expect(transport.send).toHaveBeenCalled();
    await pl.cleanup();
  });
});
