/**
 * Composition root — the guard a deployment cannot step around.
 *
 * `ExactlyOnceCDCPipeline` deliberately still accepts a default simulator: 54
 * unit tests drive its CDC logic with `appendChange` and should not need a real
 * WAL. That permissiveness is correct for a unit under test and wrong at the
 * point a product starts. This suite is the boundary between the two: a caller
 * that assembles a pipeline through the composition root either names a real
 * engine or explicitly admits it is running the simulator, and the refusal
 * names the component rather than failing later as a silent no-op.
 *
 * AC 99.1  the default configuration is refused by name, before start().
 * AC 99.2  an explicit `allowSimulated` admits the simulator (the receive-only
 *          side, which produces no changes and only dedups inbound ones).
 * AC 99.3  a real log-tail engine is accepted unchanged.
 * AC 99.4  the test is capability-based, not `instanceof`: a foreign engine
 *          that exposes the `appendChange` hook is refused too — the guard is
 *          engine-agnostic and binds to no concrete class.
 * AC 99.5  a foreign engine with no simulator hook is accepted — the guard
 *          does not require a specific implementation, only the absence of the
 *          one capability that makes a source a test double.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCDCPipeline, isSimulatedCapability, SimulatedEngineError } from './createCDCPipeline';
import { FileChangeLogReader, FileChangeLogWriter } from '../replication/FileChangeLog';
import { WalTailCDCEngine } from '../replication/WalTailCDCEngine';
import { CDCEngine } from '../replication/CDCEngine';
import type { ICDCEngine, CDCChangeEvent } from '../interfaces/replication/ICDCManager';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportStats } from '../interfaces/types';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseConfig(dir: string) {
  return {
    nodeId: 'n1',
    cdcConfig: { nodeId: 'n1' },
    outboxConfig: { dataDir: join(dir, 'outbox') },
    checkpointDir: join(dir, 'outbox'),
  };
}

function noopTransport(): ITransport {
  return {
    async send() {
      return true;
    },
    async broadcast() {
      return 1;
    },
    onMessage() {
      return () => undefined;
    },
    getConnectedPeers() {
      return [];
    },
    getStats(): TransportStats {
      return {
        peersConnected: 0,
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        uptimeMs: 0,
      };
    },
  };
}

/** An engine from no known class that nonetheless carries the test hook. */
function foreignSimulatedEngine(): ICDCEngine & { appendChange(e: never): CDCChangeEvent } {
  return {
    async start() {},
    async stop() {},
    watchTable() {},
    unwatchTable() {},
    getWatchedTables() {
      return [];
    },
    onChange() {
      return () => undefined;
    },
    appendChange(_e: never): CDCChangeEvent {
      throw new Error('not used');
    },
  };
}

/** A real-shaped engine with no simulator hook, from no known class. */
function foreignRealEngine(): ICDCEngine {
  return {
    async start() {},
    async stop() {},
    watchTable() {},
    unwatchTable() {},
    getWatchedTables() {
      return [];
    },
    onChange() {
      return () => undefined;
    },
  };
}

describe('createCDCPipeline — composition-root refusal', () => {
  it('AC 99.1 refuses the default configuration by name, before start()', () => {
    const dir = makeDir('db-fed-composition-default-');
    expect(() => createCDCPipeline(baseConfig(dir))).toThrow(SimulatedEngineError);
    expect(() => createCDCPipeline(baseConfig(dir))).toThrow(/ExactlyOnceCDCPipeline/);
    expect(() => createCDCPipeline(baseConfig(dir))).toThrow(/CDCEngine/);
  });

  it('AC 99.2 admits the simulator when the caller says so explicitly', () => {
    const dir = makeDir('db-fed-composition-admit-');
    const pipeline = createCDCPipeline({
      ...baseConfig(dir),
      allowSimulated: true,
      transport: noopTransport(),
    });
    expect(pipeline).toBeDefined();
  });

  it('AC 99.3 accepts a real log-tail engine unchanged', async () => {
    const dir = makeDir('db-fed-composition-real-');
    const logDir = makeDir('db-fed-composition-log-');
    const writer = await FileChangeLogWriter.open({ dir: logDir });
    await writer.close();
    const reader = await FileChangeLogReader.open({ dir: logDir });
    const engine = new WalTailCDCEngine({ reader, nodeId: 'n1' });
    const pipeline = createCDCPipeline({
      ...baseConfig(dir),
      engine,
      transport: noopTransport(),
    });
    expect(pipeline).toBeDefined();
  });

  it('AC 99.4 refuses a foreign engine that exposes the simulator hook', () => {
    const dir = makeDir('db-fed-composition-foreign-sim-');
    expect(() =>
      createCDCPipeline({
        ...baseConfig(dir),
        engine: foreignSimulatedEngine(),
      }),
    ).toThrow(SimulatedEngineError);
  });

  it('AC 99.4b names a hook-carrying engine that has no constructor name', () => {
    const dir = makeDir('db-fed-composition-anon-sim-');
    // A null-prototype object carries the hook but no constructor to name; the
    // error must still say something rather than print undefined.
    const anonymous = Object.assign(Object.create(null), {
      start: async () => {},
      stop: async () => {},
      watchTable: () => {},
      unwatchTable: () => {},
      getWatchedTables: () => [],
      onChange: () => () => {},
      appendChange: () => {
        throw new Error('not used');
      },
    });
    let caught: unknown;
    try {
      createCDCPipeline({ ...baseConfig(dir), engine: anonymous });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SimulatedEngineError);
    expect((caught as SimulatedEngineError).engineName).toContain('[object Object]');
    expect((caught as Error).message).toContain('ExactlyOnceCDCPipeline');
  });

  it('AC 99.5 accepts a foreign engine with no simulator hook', () => {
    const dir = makeDir('db-fed-composition-foreign-real-');
    const pipeline = createCDCPipeline({
      ...baseConfig(dir),
      engine: foreignRealEngine(),
      transport: noopTransport(),
    });
    expect(pipeline).toBeDefined();
  });
});

describe('isSimulatedCapability — the engine-agnostic predicate', () => {
  it('flags the concrete simulator by capability', () => {
    expect(isSimulatedCapability(new CDCEngine({ nodeId: 'n1' }))).toBe(true);
  });

  it('flags a foreign object with the hook', () => {
    expect(isSimulatedCapability(foreignSimulatedEngine())).toBe(true);
  });

  it('clears a foreign object without the hook', () => {
    expect(isSimulatedCapability(foreignRealEngine())).toBe(false);
  });

  it('clears a null-ish engine without throwing', () => {
    expect(isSimulatedCapability(undefined)).toBe(false);
    expect(isSimulatedCapability(null)).toBe(false);
  });
});
