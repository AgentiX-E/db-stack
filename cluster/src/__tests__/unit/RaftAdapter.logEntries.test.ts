/**
 * RaftAdapter — replicated-log slices.
 *
 * A learner cannot pull what the leader does not expose. `getLogBounds()` and
 * `getLogEntries()` are that exposure, and every branch they have is a
 * boundary: the node has no log, the log is empty, the requested floor was
 * compacted away, the requested ceiling is past the head, the slice is longer
 * than the caller asked for, or compaction moved the floor between reading the
 * bounds and reading the slice.
 *
 * The slice is returned as `ApplyEntry`, the shape the replica already applies,
 * so a learner can feed it straight back through `replica.apply()` — which means
 * `msgId` (the idempotency key) has to survive the round trip, and a payload
 * that is not ours must not crash the read.
 *
 * Acceptance criteria:
 *   AC 58.1  no node → no bounds, no entries
 *   AC 58.2  node without a log manager → no bounds, no entries
 *   AC 58.3  log manager that throws on `getFirstIndex` (not initialised) → no bounds
 *   AC 58.4  empty log (lastIndex 0) → no bounds, no entries
 *   AC 58.5  retained range maps to ApplyEntry: index, term, command name, payload text
 *   AC 58.6  fromIndex below the first retained index is clamped up, not rejected
 *   AC 58.7  fromIndex past the last index returns nothing
 *   AC 58.8  limit truncates the slice from the front
 *   AC 58.9  a non-positive or NaN limit is treated as one entry
 *   AC 58.10 storage failing under a concurrent compaction returns nothing instead of throwing
 *   AC 58.11 a payload that is not a string is serialised rather than becoming "[object Object]"
 *   AC 58.12 `msgId` and `type` reach the caller when the payload carries them, and are absent otherwise
 *   AC 58.13 a log entry without a command reports its entry type instead of inventing one
 */

import { describe, it, expect } from 'vitest';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';

interface FakeLogEntry {
  index: number;
  term: number;
  type: string;
  command?: { type: string; payload: unknown };
}

function config(): RaftConfig {
  return { id: 1, peers: [2, 3], electionTick: 10, heartbeatTick: 3 };
}

interface FakeLog {
  entries: FakeLogEntry[];
  firstIndex: number;
  lastIndex: number;
  lastTerm: number;
  failOnGetFirst?: boolean;
  failOnGetEntries?: boolean;
}

/** Install a fake log manager where `RaftAdapter` looks for raft-core's own. */
function withLog(adapter: RaftAdapter, log: FakeLog | null): void {
  if (log === null) {
    (adapter as unknown as { node: unknown }).node = {};
    return;
  }
  (adapter as unknown as { node: unknown }).node = {
    logManager: {
      getFirstIndex() {
        if (log.failOnGetFirst) throw new Error('LogManager is not initialized');
        return log.firstIndex;
      },
      getLastIndex() {
        return log.lastIndex;
      },
      getLastTerm() {
        return log.lastTerm;
      },
      async getEntries(from: number, to: number) {
        if (log.failOnGetEntries) throw new Error('Invalid index range');
        return log.entries.filter((e) => e.index >= from && e.index <= to);
      },
    },
  };
}

function entry(
  index: number,
  payload: unknown = JSON.stringify({ msgId: `m${index}`, type: 'exec', data: '{}' }),
): FakeLogEntry {
  return { index, term: 2, type: 'COMMAND', command: { type: 'command', payload } };
}

function logOf(entries: FakeLogEntry[], overrides: Partial<FakeLog> = {}): FakeLog {
  const last = entries[entries.length - 1];
  return {
    entries,
    firstIndex: entries[0]?.index ?? 1,
    lastIndex: last?.index ?? 0,
    lastTerm: last?.term ?? 0,
    ...overrides,
  };
}

describe('AC 58.1: an adapter with no node', () => {
  it('reports no bounds and no entries', async () => {
    const adapter = new RaftAdapter(config());

    expect(await adapter.getLogBounds()).toBeNull();
    expect(await adapter.getLogEntries(1)).toEqual([]);
  });
});

describe('AC 58.2: a node without a log manager', () => {
  it('reports no bounds and no entries', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, null);

    expect(await adapter.getLogBounds()).toBeNull();
    expect(await adapter.getLogEntries(1)).toEqual([]);
  });
});

describe('AC 58.3: a log manager that is not initialised', () => {
  it('reports no bounds instead of propagating the storage error', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1)], { failOnGetFirst: true }));

    expect(await adapter.getLogBounds()).toBeNull();
    expect(await adapter.getLogEntries(1)).toEqual([]);
  });
});

describe('AC 58.4: an empty log', () => {
  it('reports no bounds, so a caller can tell "nothing retained" from "range was compacted"', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, { entries: [], firstIndex: 1, lastIndex: 0, lastTerm: 0 });

    expect(await adapter.getLogBounds()).toBeNull();
    expect(await adapter.getLogEntries(1)).toEqual([]);
  });
});

describe('AC 58.5: mapping a retained range', () => {
  it('returns index, term, command name and payload text', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(4), entry(5)]));

    const entries = await adapter.getLogEntries(4);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ index: 4, term: 2, command: 'command' });
    expect(JSON.parse(String(entries[0]!.data))).toEqual({ msgId: 'm4', type: 'exec', data: '{}' });
  });

  it('reports the log bounds from the log itself, not from the current term', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(4), entry(5)], { lastTerm: 9 }));

    expect(await adapter.getLogBounds()).toEqual({ firstIndex: 4, lastIndex: 5, lastTerm: 9 });
  });
});

describe('AC 58.6: a floor below the retained window', () => {
  it('clamps up to the first retained index instead of rejecting the request', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(11), entry(12), entry(13)]));

    const entries = await adapter.getLogEntries(3);

    expect(entries.map((e) => e.index)).toEqual([11, 12, 13]);
  });
});

describe('AC 58.7: a floor past the head', () => {
  it('returns nothing', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1), entry(2)]));

    expect(await adapter.getLogEntries(3)).toEqual([]);
  });
});

describe('AC 58.8: limit', () => {
  it('truncates the slice from the front', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1), entry(2), entry(3), entry(4)]));

    const entries = await adapter.getLogEntries(1, 2);

    expect(entries.map((e) => e.index)).toEqual([1, 2]);
  });
});

describe('AC 58.9: a limit that cannot mean "many"', () => {
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ])('treats a %s limit as one entry', async (_label, limit) => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1), entry(2), entry(3)]));

    expect((await adapter.getLogEntries(1, limit)).map((e) => e.index)).toEqual([1]);
  });
});

describe('AC 58.10: storage failing mid-read', () => {
  it('returns nothing rather than throwing at the caller', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1), entry(2)], { failOnGetEntries: true }));

    await expect(adapter.getLogEntries(1)).resolves.toEqual([]);
  });
});

describe('AC 58.11: a payload that is not a string', () => {
  it('serialises it rather than handing back "[object Object]"', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1, { msgId: 'obj', type: 'exec' })]));

    const [first] = await adapter.getLogEntries(1);

    expect(String(first!.data)).toBe('{"msgId":"obj","type":"exec"}');
  });
});

describe('AC 58.12: idempotency keys survive the round trip', () => {
  it('carries msgId and type when the payload has them', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1)]));

    const [first] = await adapter.getLogEntries(1);

    expect(first).toMatchObject({ msgId: 'm1', type: 'exec' });
  });

  it('omits both when the payload is not an object with string fields', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1, JSON.stringify(['not', 'an', 'object']))]));

    const [first] = await adapter.getLogEntries(1);

    expect(first!.msgId).toBeUndefined();
    expect(first!.type).toBeUndefined();
  });

  it('omits both when the payload is not JSON at all', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1, 'not-json')]));

    const [first] = await adapter.getLogEntries(1);

    expect(first!.msgId).toBeUndefined();
    expect(first!.type).toBeUndefined();
    expect(String(first!.data)).toBe('not-json');
  });

  it('omits both when the fields are not strings', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([entry(1, JSON.stringify({ msgId: 7, type: null }))]));

    const [first] = await adapter.getLogEntries(1);

    expect(first!.msgId).toBeUndefined();
    expect(first!.type).toBeUndefined();
  });
});

describe('AC 58.13: an entry without a command', () => {
  it('reports its entry type instead of inventing a command name', async () => {
    const adapter = new RaftAdapter(config());
    withLog(adapter, logOf([{ index: 1, term: 1, type: 'NOOP' }]));

    const [first] = await adapter.getLogEntries(1);

    expect(first).toMatchObject({ index: 1, term: 1, command: 'noop' });
  });
});
