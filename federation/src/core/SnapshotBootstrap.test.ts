/**
 * SnapshotBootstrap — bringing a datacenter up to date with a peer.
 *
 * Every case runs two real instances over a real `InProcessTransport`, with a real
 * in-memory change log behind each. Nothing is simulated except the socket, and the
 * socket is not what these tests are about.
 *
 * Where a case needs to observe a transfer *in flight* — a gap, a duplicate, a
 * restart — the transport is given a latency, because a synchronous link delivers
 * a whole three-chunk snapshot inside one `await` and leaves no window to look at.
 * That latency is the test's, not the protocol's: it is how a runner reproduces
 * "the second chunk has not arrived yet" without a race.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProcessTransport } from '../transport/InProcessTransport';
import { HLC } from '../hlc/HLC';
import { AntiEntropy, type DataEntry, type DataProvider } from '../replication/AntiEntropy';
import { SnapshotBootstrap, type BootstrapSource } from './SnapshotBootstrap';
import { BOOTSTRAP_CHUNK_TYPE, HANDOFF_TYPE } from '../replication/bootstrapFrames';

// ── Fixtures ──

class MapProvider implements DataProvider {
  readonly data = new Map<string, DataEntry>();

  async getRange(start: string, end: string): Promise<DataEntry[]> {
    return [...this.data.values()]
      .filter((entry) => entry.key >= start && entry.key <= end)
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  async getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]> {
    return [...this.data.values()]
      .filter((entry) => entry.key > afterKey)
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
  }
  async apply(key: string, value: string, origin?: { hlc: DataEntry['hlc']; nodeId: string }): Promise<void> {
    this.data.set(key, {
      key,
      value,
      hlc: origin?.hlc ?? { wallTime: 1, logical: 0, nodeId: 'local' },
      nodeId: origin?.nodeId ?? 'local',
    });
  }
  async get(key: string): Promise<DataEntry | null> {
    return this.data.get(key) ?? null;
  }

  put(key: string, value: string, wallTime = 1): void {
    this.data.set(key, { key, value, hlc: { wallTime, logical: 0, nodeId: 'seed' }, nodeId: 'seed' });
  }
}

/** An ordered change log, standing in for whatever owns durability. */
class MemoryLog implements BootstrapSource {
  private readonly records: Array<{ lsn: number; entry: DataEntry }> = [];

  append(key: string, value: string, wallTime = 1): number {
    const lsn = this.records.length + 1;
    this.records.push({ lsn, entry: { key, value, hlc: { wallTime, logical: 0, nodeId: 'seed' }, nodeId: 'seed' } });
    return lsn;
  }

  async currentLsn(): Promise<number> {
    return this.records.length;
  }

  async entriesAfter(lsn: number, limit: number): Promise<Array<{ lsn: number; entry: DataEntry }>> {
    return this.records.filter((record) => record.lsn > lsn).slice(0, limit);
  }
}

/**
 * A log whose position is behind its content.
 *
 * This is what a live sender looks like: the snapshot is taken at position N,
 * writes keep landing, and the handoff covers N+1 onward. Reproducing it with a
 * lagging `currentLsn` is the only deterministic way to test the handoff — a real
 * concurrent writer would make the case a race.
 */
class ScriptedLog implements BootstrapSource {
  constructor(
    private readonly position: number,
    private readonly records: Array<{ lsn: number; entry: DataEntry }>,
  ) {}

  async currentLsn(): Promise<number> {
    return this.position;
  }

  async entriesAfter(lsn: number, limit: number): Promise<Array<{ lsn: number; entry: DataEntry }>> {
    return this.records.filter((record) => record.lsn > lsn).slice(0, limit);
  }
}

/** A log that has forgotten everything before `floor`. */
class CompactedLog extends MemoryLog {
  constructor(private readonly floor: number) {
    super();
  }

  override async entriesAfter(lsn: number, limit: number): Promise<Array<{ lsn: number; entry: DataEntry }>> {
    if (lsn < this.floor) {
      throw new Error(`log starts at ${this.floor}, past the requested position ${lsn}`);
    }
    return super.entriesAfter(lsn, limit);
  }
}

/**
 * A log that rejects with a bare string.
 *
 * Storage layers written outside this package do exactly this — a `throw 'gone'`
 * survives a refactor in a way a typed error does not — and the reason still has
 * to reach the operator's status page verbatim.
 */
class ReclaimingLog implements BootstrapSource {
  async currentLsn(): Promise<number> {
    return 0;
  }

  async entriesAfter(): Promise<Array<{ lsn: number; entry: DataEntry }>> {
    // eslint-disable-next-line no-throw-literal -- the case under test is a store that rejects with a value rather than an Error
    throw 'the log was reclaimed by another process';
  }
}

function record(lsn: number, key: string, value: string): { lsn: number; entry: DataEntry } {
  return { lsn, entry: { key, value, hlc: { wallTime: lsn, logical: 0, nodeId: 'seed' }, nodeId: 'seed' } };
}

interface Peer {
  transport: InProcessTransport;
  provider: MapProvider;
  antiEntropy: AntiEntropy;
  bootstrap: SnapshotBootstrap;
  unsubscribe: () => void;
}

interface PeerOptions {
  chunkSize?: number;
  /**
   * Omit the chunk size entirely, so the constructor's default is observable.
   *
   * A separate switch rather than `chunkSize: undefined`, because the default is
   * 200 and a case that wants it must not be expressible as "whatever `??` says".
   */
  defaultChunkSize?: boolean;
  resumeStatePath?: string;
  /**
   * Say that the provider's store outlives the process, so a cursor written by
   * another one may be honoured. The in-memory provider every case here uses does
   * not, which is the default and is what most of these cases rely on.
   */
  resumeAcrossRestarts?: boolean;
  latencyMs?: number;
}

function peer(id: string, registryKey: string, source: BootstrapSource, options: PeerOptions = {}): Peer {
  const transport = new InProcessTransport({ nodeId: id, registryKey, latencyMs: options.latencyMs });
  const provider = new MapProvider();
  const antiEntropy = new AntiEntropy({ nodeId: id, intervalMs: 60_000, merkleDepth: 4 }, provider);
  const bootstrap = new SnapshotBootstrap(transport, new HLC(id), antiEntropy, source, {
    nodeId: id,
    ...(options.defaultChunkSize ? {} : { chunkSize: options.chunkSize ?? 2 }),
    resumeStatePath: options.resumeStatePath,
    resumeAcrossRestarts: options.resumeAcrossRestarts,
  });
  const unsubscribe = transport.onMessage((msg) => {
    void bootstrap.handle(msg).catch(() => undefined);
  });
  return { transport, provider, antiEntropy, bootstrap, unsubscribe };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function frame(type: string, from: string, to: string, body: Record<string, unknown>) {
  return {
    messageId: `${type}-${Math.random().toString(36).slice(2)}`,
    sourcePeerId: from,
    targetPeerId: to,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp: new HLC(from).now(),
    createdAt: Date.now(),
    receivedAt: Date.now(),
    type,
  };
}

// ── Convergence ──

describe('SnapshotBootstrap — convergence', () => {
  let key: string;
  const open: Peer[] = [];

  beforeEach(() => {
    key = `bs-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    for (const p of open) p.unsubscribe();
    open.length = 0;
  });

  const keep = (p: Peer): Peer => {
    open.push(p);
    return p;
  };

  it('moves a whole dataset into an empty datacenter', async () => {
    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 2 }));
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 2 }));
    for (let i = 0; i < 5; i += 1) source.provider.put(`k${i}`, `v${i}`);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer to finish');

    expect([...receiver.provider.data.keys()].sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(await receiver.antiEntropy.getMerkleRoot('default')).toBe(await source.antiEntropy.getMerkleRoot('default'));

    const status = receiver.bootstrap.getStatus();
    expect(status.chunksReceived).toBe(3);
    // Counted on the sender, which is a different instance: the receiver's own
    // `chunksSent` is zero by definition and asserting otherwise would be
    // asserting that one side's counter describes the other's work.
    expect(source.bootstrap.getStatus().chunksSent).toBe(3);
    expect(status.completed[0]).toMatchObject({ peerId: 'dc-a', chunks: 3, entriesApplied: 5 });
  });

  it('completes an empty source with one empty chunk', async () => {
    keep(peer('dc-a', key, new MemoryLog()));
    const receiver = keep(peer('dc-b', key, new MemoryLog()));

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer to finish');

    // Skipping the transfer would leave the receiver waiting for a completion that
    // never comes.
    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(1);
    expect(receiver.provider.data.size).toBe(0);
  });

  it('hands off the changes that landed after the snapshot was taken', async () => {
    // The sender's snapshot is at position 1; positions 2 and 3 arrived after it.
    // A receiver that only got the snapshot would be missing both, which is the
    // hole this half of the protocol exists to close.
    const log = new ScriptedLog(1, [
      record(1, 'in-snapshot', 'v1'),
      record(2, 'after-1', 'v2'),
      record(3, 'after-2', 'v3'),
    ]);
    const source = keep(peer('dc-a', key, log, { chunkSize: 10 }));
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 10 }));
    source.provider.put('in-snapshot', 'v1');

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer to finish');

    expect(receiver.bootstrap.getStatus().handoffApplied).toBe(2);
    expect([...receiver.provider.data.keys()].sort()).toEqual(['after-1', 'after-2', 'in-snapshot']);
  });

  it('chunks at two hundred entries when nothing says otherwise', async () => {
    // The one number a caller has to be able to predict without configuring it: a
    // snapshot of 201 entries is two chunks, so the default is 200 and not
    // "whatever is left". Omitting the knob is the only way to observe it.
    const source = keep(peer('dc-a', key, new MemoryLog(), { defaultChunkSize: true }));
    for (let i = 0; i < 201; i += 1) source.provider.put(`k${String(i).padStart(3, '0')}`, `v${i}`);
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { defaultChunkSize: true }));

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 10_000, 'the transfer');

    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(2);
    expect(receiver.provider.data.size).toBe(201);
  });

  it('skips a handoff change at or below the floor', async () => {
    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1, latencyMs: 20 }));
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 1, latencyMs: 20 }));
    source.provider.put('k0', 'v1');
    source.provider.put('k1', 'v2');

    const transferId = await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().chunksReceived >= 1, 3_000, 'the first chunk');
    const floor = receiver.bootstrap.getInboundTransfer(transferId)!.highWaterMark;

    // A change at the floor is one the snapshot already contains. Delivering it
    // again is what an at-least-once transport does; applying it would be replaying
    // history and inflating the count that says how far behind the peer was.
    await receiver.bootstrap.handle(
      frame(HANDOFF_TYPE, 'dc-a', 'dc-b', {
        transferId,
        shardId: 'default',
        lsn: floor,
        entry: { key: 'k0', value: 'stale', hlc: { wallTime: 1, logical: 0, nodeId: 'seed' }, nodeId: 'seed' },
      }),
    );
    await waitFor(() => receiver.bootstrap.getStatus().handoffSkipped >= 1, 3_000, 'the floor to be applied');

    expect(receiver.provider.data.get('k0')!.value).toBe('v1');
  });
});

// ── Resumability ──

describe('SnapshotBootstrap — resuming an interrupted transfer', () => {
  let key: string;
  let dir: string;
  const open: Peer[] = [];

  beforeEach(() => {
    key = `bs-${Math.random().toString(36).slice(2)}`;
    dir = mkdtempSync(join(tmpdir(), 'dbstack-bootstrap-'));
  });

  afterEach(() => {
    for (const p of open) p.unsubscribe();
    open.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  const keep = (p: Peer): Peer => {
    open.push(p);
    return p;
  };

  it('resumes at the chunk the cursor names, not at zero', async () => {
    const resumePath = join(dir, 'bootstrap.json');
    // The state a restart finds: a transfer that had accepted chunks 0 and 1.
    writeFileSync(resumePath, JSON.stringify({ 'dc-a': { transferId: 'resumed-transfer', nextChunk: 2 } }));

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1 }));
    for (let i = 0; i < 6; i += 1) source.provider.put(`k${i}`, `v${i}`);
    // `resumeAcrossRestarts`: this case is about what a cursor *says*, and the
    // store is asserted to back the claim. Without it the cursor is a stranger's,
    // which the next case covers.
    const receiver = keep(
      peer('dc-b', key, new MemoryLog(), { chunkSize: 1, resumeStatePath: resumePath, resumeAcrossRestarts: true }),
    );

    const transferId = await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the resumed transfer');

    // The same transfer id, and four chunks rather than six: the sender served from
    // the index the request named.
    expect(transferId).toBe('resumed-transfer');
    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(4);
    // Four applied entries, not six: the first two chunks are state the restart
    // already had on disk, which is exactly what resuming means.
    expect(receiver.provider.data.size).toBe(4);
    expect(source.bootstrap.getStatus().chunksSent).toBe(4);
  });

  it('goes straight to the handoff when the cursor has every chunk', async () => {
    const resumePath = join(dir, 'complete.json');
    // A restart after the last chunk but before the acknowledgement: the receiver
    // holds everything, and waiting for a completion that only a chunk provokes
    // would deadlock at 100 %.
    writeFileSync(resumePath, JSON.stringify({ 'dc-a': { transferId: 'finished-snapshot', nextChunk: 2 } }));

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1 }));
    source.provider.put('k0', 'v0');
    source.provider.put('k1', 'v1');
    const receiver = keep(
      peer('dc-b', key, new MemoryLog(), { chunkSize: 1, resumeStatePath: resumePath, resumeAcrossRestarts: true }),
    );

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer to finish');

    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(0);
    expect(receiver.bootstrap.getStatus().completed[0]).toMatchObject({ chunks: 2 });
  });

  it('refuses a cursor another process wrote, and says so', async () => {
    const resumePath = join(dir, 'foreign.json');
    // Exactly what a restart finds after a process died mid-transfer. The cursor is
    // true about the process that wrote it and false about this one: the store it
    // counted chunks into did not survive, so resuming at chunk 2 leaves the first
    // two chunks missing and still reports the transfer complete.
    writeFileSync(
      resumePath,
      JSON.stringify({ 'dc-a': { transferId: 'other-process', nextChunk: 2, instanceId: 'dead-instance' } }),
    );

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1 }));
    for (let i = 0; i < 3; i += 1) source.provider.put(`k${i}`, `v${i}`);
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 1, resumeStatePath: resumePath }));

    const transferId = await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    expect(transferId).not.toBe('other-process');
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/written by another process/);
    // All three, not just the one after the stranger's cursor.
    expect(receiver.provider.data.size).toBe(3);
    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(3);
  });

  it('starts from zero when there is no cursor yet', async () => {
    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 2 }));
    source.provider.put('k0', 'v0');
    source.provider.put('k1', 'v1');
    const receiver = keep(
      peer('dc-b', key, new MemoryLog(), { chunkSize: 2, resumeStatePath: join(dir, 'none.json') }),
    );

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    expect(receiver.provider.data.size).toBe(2);
  });

  it('ignores a cursor it cannot parse', async () => {
    const resumePath = join(dir, 'corrupt.json');
    writeFileSync(resumePath, 'not json at all');

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 2 }));
    source.provider.put('k0', 'v0');
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 2, resumeStatePath: resumePath }));

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    expect(receiver.provider.data.size).toBe(1);
  });

  it('ignores a cursor whose shape it does not recognise', async () => {
    const resumePath = join(dir, 'odd.json');
    writeFileSync(resumePath, JSON.stringify({ 'dc-a': { transferId: 't', nextChunk: -3 } }));

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 2 }));
    source.provider.put('k0', 'v0');
    const receiver = keep(peer('dc-b', key, new MemoryLog(), { chunkSize: 2, resumeStatePath: resumePath }));

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    expect(receiver.provider.data.size).toBe(1);
  });

  it('does not resume from a cursor that would mean something else', async () => {
    // Every shape below parses as JSON and none of them names a chunk this side
    // could have applied. Reading any of them as "resume here" would skip part of
    // the snapshot — the one failure mode a cursor has — so each has to be
    // discarded, and the only visible consequence of discarding it is that the
    // transfer starts from zero and still completes.
    const shapes = [
      // An array is an object: spreading it would produce `{'0': …}` and the next
      // read would look for a peer named `0`.
      ['an array', '[]'],
      ['a bare number', '42'],
      ['a peer entry that is not an object', '{"dc-a":5}'],
      ['an entry with no transfer id', '{"dc-a":{"nextChunk":2}}'],
      ['a fractional chunk index', '{"dc-a":{"transferId":"t","nextChunk":1.5}}'],
    ] as const;

    for (const [label, contents] of shapes) {
      const shapeKey = `bs-${Math.random().toString(36).slice(2)}`;
      const resumePath = join(dir, `${label.replace(/\s+/g, '-')}.json`);
      writeFileSync(resumePath, contents);

      const source = keep(peer('dc-a', shapeKey, new MemoryLog(), { chunkSize: 2 }));
      source.provider.put('k0', 'v0');
      source.provider.put('k1', 'v1');
      const receiver = keep(peer('dc-b', shapeKey, new MemoryLog(), { chunkSize: 2, resumeStatePath: resumePath }));

      await receiver.bootstrap.begin('dc-a');
      await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, `the transfer with ${label}`);

      expect(receiver.provider.data.size, label).toBe(2);
      expect(receiver.bootstrap.getStatus().chunksReceived, label).toBe(1);
    }
  });

  it('reports a transfer id it has no record of as absent rather than zero', async () => {
    const receiver = keep(peer('dc-b', key, new MemoryLog()));

    // `null`, not a default-shaped record: a caller that read `expected: 0` off an
    // unknown transfer would conclude the transfer had not started, which is a
    // different statement from "I have never heard of it".
    expect(receiver.bootstrap.getInboundTransfer('never-started')).toBeNull();
  });
});

// ── Gaps and duplicates ──

describe('SnapshotBootstrap — gaps and duplicates', () => {
  let key: string;
  const open: Peer[] = [];

  beforeEach(() => {
    key = `bs-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    for (const p of open) p.unsubscribe();
    open.length = 0;
  });

  it('asks for the chunk it is missing when one arrives out of order', async () => {
    // No reachable source: the transfer stays open, which is the state a gap can
    // occur in. A real source would have finished it before the assertion ran.
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 1 });
    open.push(receiver);
    new InProcessTransport({ nodeId: 'dc-a', registryKey: key });

    const transferId = await receiver.bootstrap.begin('dc-a');

    await receiver.bootstrap.handle(
      frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {
        transferId,
        shardId: 'default',
        chunkIndex: 2,
        totalChunks: 3,
        snapshotLsn: 10,
        entries: [],
      }),
    );
    await waitFor(() => receiver.bootstrap.getStatus().gapRequests >= 1, 3_000, 'the gap to be noticed');

    // Still waiting for chunk 0: a gap is not progress.
    expect(receiver.bootstrap.getInboundTransfer(transferId)!.expected).toBe(0);
  });

  it('ignores a chunk it has already applied', async () => {
    const source = peer('dc-a', key, new MemoryLog(), { chunkSize: 1, latencyMs: 20 });
    open.push(source);
    source.provider.put('k0', 'v0');
    source.provider.put('k1', 'v1');
    source.provider.put('k2', 'v2');
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 1, latencyMs: 20 });
    open.push(receiver);

    const transferId = await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().chunksReceived >= 1, 3_000, 'the first chunk');

    // Re-deliver the chunk that already landed — what an at-least-once link does.
    await receiver.bootstrap.handle(
      frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {
        transferId,
        shardId: 'default',
        chunkIndex: 0,
        totalChunks: 3,
        snapshotLsn: 3,
        entries: [{ key: 'k0', value: 'v0', hlc: { wallTime: 1, logical: 0, nodeId: 'seed' }, nodeId: 'seed' }],
      }),
    );
    await waitFor(() => receiver.bootstrap.getStatus().duplicateChunks >= 1, 3_000, 'the duplicate to be counted');
  });

  it('counts a chunk for a transfer it has no record of', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    await receiver.bootstrap.handle(
      frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {
        transferId: 'never-started',
        shardId: 'default',
        chunkIndex: 0,
        totalChunks: 1,
        snapshotLsn: 1,
        entries: [],
      }),
    );

    expect(receiver.bootstrap.getStatus().unknownTransfers).toBe(1);
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/unknown transfer/);
  });

  it('counts a handoff entry for a transfer it has no record of', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    await receiver.bootstrap.handle(
      frame(HANDOFF_TYPE, 'dc-a', 'dc-b', {
        transferId: 'never-started',
        shardId: 'default',
        lsn: 4,
        entry: { key: 'k', value: 'v', hlc: { wallTime: 1, logical: 0, nodeId: 'a' }, nodeId: 'a' },
      }),
    );

    expect(receiver.bootstrap.getStatus().unknownTransfers).toBe(1);
  });

  it('counts a handoff end for a transfer it has no record of', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    await receiver.bootstrap.handle(
      frame('handoff_end', 'dc-a', 'dc-b', {
        transferId: 'never-started',
        shardId: 'default',
        lastLsn: 9,
        complete: true,
      }),
    );

    expect(receiver.bootstrap.getStatus().unknownTransfers).toBe(1);
  });
});

// ── Refusals ──

describe('SnapshotBootstrap — refusals', () => {
  let key: string;
  const open: Peer[] = [];

  beforeEach(() => {
    key = `bs-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    for (const p of open) p.unsubscribe();
    open.length = 0;
  });

  it('declines a frame of another family', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    expect(await receiver.bootstrap.handle(frame('fed_heartbeat', 'dc-a', 'dc-b', {}))).toBe(false);
  });

  it('counts a frame it cannot read', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    const undecodable = {
      ...frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {}),
      payload: new TextEncoder().encode('{"transferId":"t"}'),
    };

    expect(await receiver.bootstrap.handle(undecodable)).toBe(true);
    expect(receiver.bootstrap.getStatus().malformed).toBe(1);
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/not a decodable/);
  });

  it('reports a log that rejects with a bare string, verbatim', async () => {
    const source = peer('dc-a', key, new ReclaimingLog(), { chunkSize: 10 });
    open.push(source);
    source.provider.put('k', 'v');
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10 });
    open.push(receiver);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().lastError !== null, 3_000, 'the refusal');

    // The sender's reason is carried through unchanged. A message that read
    // `[object Object]` here would be a status line that tells an operator
    // nothing about why the handoff failed.
    expect(source.bootstrap.getStatus().lastError).toMatch(/the log was reclaimed by another process/);
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/incomplete/);
  });

  it('reports a handoff the sender could not complete, and forgets the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbstack-bootstrap-'));
    const resumePath = join(dir, 'bootstrap.json');
    const compacted = new CompactedLog(50);
    const source = peer('dc-a', key, compacted, { chunkSize: 10 });
    open.push(source);
    source.provider.put('k', 'v');
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10, resumeStatePath: resumePath });
    open.push(receiver);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().lastError !== null, 3_000, 'the incomplete handoff');

    // The sender could not reach back to the floor, so the state has a hole. The
    // cursor is dropped so the next attempt starts from a fresh snapshot instead of
    // resuming into the same gap.
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/incomplete|past the requested position/);
    expect(receiver.bootstrap.getStatus().completed).toHaveLength(0);
    expect(receiver.bootstrap.getStatus().transfers.inbound).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a transport that refuses the snapshot request', async () => {
    const receiver = peer('dc-b', key, new MemoryLog());
    open.push(receiver);

    await receiver.bootstrap.begin('nobody');
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/refused a bootstrap request/);
  });
});

// ── Transports that stop carrying frames ──

describe('SnapshotBootstrap — a link that goes away mid-transfer', () => {
  let key: string;
  const open: Peer[] = [];

  beforeEach(() => {
    key = `bs-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    for (const p of open) p.unsubscribe();
    open.length = 0;
  });

  const keep = (p: Peer): Peer => {
    open.push(p);
    return p;
  };

  it('stops sending chunks when the transport refuses one', async () => {
    const sender = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1 }));
    for (let i = 0; i < 3; i += 1) sender.provider.put(`k${i}`, `v${i}`);
    // A peer that was reachable and then left. The registry is global and keyed
    // by node id, so merely constructing one would still answer `send()` with
    // `true`; removing it is what makes the transport refuse, which is the
    // condition under test.
    const gone = new InProcessTransport({ nodeId: 'gone', registryKey: key });
    gone.destroy();

    // A request from a peer that is no longer in the registry: the first chunk is
    // refused, and pushing the other two into the same void would only produce two
    // more refusals.
    await sender.bootstrap.handle(
      frame('bootstrap_request', 'gone', 'dc-a', {
        transferId: 'orphan',
        shardId: 'default',
        nextChunk: 0,
        fromLsn: 0,
      }),
    );
    await waitFor(() => sender.bootstrap.getStatus().lastError !== null, 3_000, 'the refusal');

    expect(sender.bootstrap.getStatus().lastError).toMatch(/refused chunk 0/);
    expect(sender.bootstrap.getStatus().chunksSent).toBe(0);
  });

  it('stops the handoff when the transport refuses an entry', async () => {
    const log = new ScriptedLog(0, [record(1, 'a', 'v1'), record(2, 'b', 'v2')]);
    const sender = keep(peer('dc-a', key, log, { chunkSize: 10 }));
    const gone = new InProcessTransport({ nodeId: 'gone', registryKey: key });
    gone.destroy();

    await sender.bootstrap.handle(
      frame('bootstrap_done', 'gone', 'dc-a', { transferId: 'orphan', shardId: 'default', highWaterMark: 0 }),
    );
    await waitFor(() => sender.bootstrap.getStatus().lastError !== null, 3_000, 'the refusal');

    expect(sender.bootstrap.getStatus().lastError).toMatch(/refused handoff entry 1/);
  });

  it('reports a handoff end it could not deliver', async () => {
    const sender = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 10 }));
    const gone = new InProcessTransport({ nodeId: 'gone', registryKey: key });
    gone.destroy();

    // Nothing to hand off, so the only frame is the end — and it is refused.
    await sender.bootstrap.handle(
      frame('bootstrap_done', 'gone', 'dc-a', { transferId: 'orphan', shardId: 'default', highWaterMark: 0 }),
    );
    await waitFor(() => sender.bootstrap.getStatus().lastError !== null, 3_000, 'the refusal');

    expect(sender.bootstrap.getStatus().lastError).toMatch(/refused the handoff end/);
  });

  it('reports a completion it could not deliver', async () => {
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10 });
    open.push(receiver);
    // Registered for the request, then removed: `begin` reaches the peer and the
    // acknowledgement has nowhere to go, which is the asymmetry a peer crash in
    // the middle of a transfer actually produces.
    const source = new InProcessTransport({ nodeId: 'gone-source', registryKey: key });

    const transferId = await receiver.bootstrap.begin('gone-source');
    expect(receiver.bootstrap.getStatus().lastError).toBeNull();
    source.destroy();

    // The last chunk, from a sender that has left the registry: applying it works,
    // and the acknowledgement has nowhere to go.
    await receiver.bootstrap.handle(
      frame(BOOTSTRAP_CHUNK_TYPE, 'gone-source', 'dc-b', {
        transferId,
        shardId: 'default',
        chunkIndex: 0,
        totalChunks: 1,
        snapshotLsn: 1,
        entries: [],
      }),
    );
    await waitFor(() => receiver.bootstrap.getStatus().lastError !== null, 3_000, 'the refusal');

    expect(receiver.bootstrap.getStatus().lastError).toMatch(/refused the bootstrap completion/);
  });

  it('records a store that refuses an entry rather than losing the transfer silently', async () => {
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10 });
    open.push(receiver);
    new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    receiver.antiEntropy.applyRemote = async () => {
      throw new Error('store is read-only');
    };

    const transferId = await receiver.bootstrap.begin('dc-a');
    await receiver.bootstrap.handle(
      frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {
        transferId,
        shardId: 'default',
        chunkIndex: 0,
        totalChunks: 1,
        snapshotLsn: 1,
        entries: [{ key: 'k', value: 'v', hlc: { wallTime: 1, logical: 0, nodeId: 'a' }, nodeId: 'a' }],
      }),
    );
    await waitFor(() => receiver.bootstrap.getStatus().lastError !== null, 3_000, 'the failure');

    expect(receiver.bootstrap.getStatus().lastError).toMatch(/store is read-only/);
    // The chunk was not counted: an entry that did not land is not a chunk received.
    expect(receiver.bootstrap.getStatus().chunksReceived).toBe(0);
  });

  it('reports a cursor it cannot write, and keeps transferring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbstack-bootstrap-'));
    // A directory where a file is expected: the rename fails. `mkdirSync`, not
    // `mkdtempSync` — the latter appends six random characters and would leave
    // `resumePath` free, which is the opposite of the case under test.
    const resumePath = join(dir, 'cursor-dir');
    mkdirSync(resumePath);

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 10 }));
    source.provider.put('k', 'v');
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10, resumeStatePath: resumePath });
    open.push(receiver);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    // The cursor is an optimisation: losing it costs a slower resume, not a
    // transfer, and the entry still landed.
    expect(receiver.bootstrap.getStatus().lastError).toMatch(/could not persist the bootstrap cursor/);
    expect(receiver.provider.data.size).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a cursor file it cannot parse when writing the next one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbstack-bootstrap-'));
    const resumePath = join(dir, 'cursor.json');
    writeFileSync(resumePath, 'this is not json');

    const source = keep(peer('dc-a', key, new MemoryLog(), { chunkSize: 1 }));
    source.provider.put('k0', 'v0');
    source.provider.put('k1', 'v1');
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 1, resumeStatePath: resumePath });
    open.push(receiver);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    // The unreadable file was replaced rather than merged into, and the transfer
    // completed regardless.
    expect(receiver.provider.data.size).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── What a position means ──

describe('SnapshotBootstrap — positions, and the snapshot they are positions in', () => {
  const spares: InProcessTransport[] = [];
  const peers: Peer[] = [];

  afterEach(() => {
    for (const opened of peers) opened.unsubscribe();
    peers.length = 0;
    for (const transport of spares) transport.destroy();
    spares.length = 0;
  });

  it('restarts the transfer from zero when a chunk belongs to another snapshot', async () => {
    const key = `bs-moved-${Math.random().toString(36).slice(2)}`;
    // Somebody at the peer's address with nothing behind it: the receiver's
    // requests are accepted by the transport and answered by nobody, so the order
    // of chunks is the suite's rather than the sender's.
    const silent = new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    spares.push(silent);
    const receiver = peer('dc-b', key, new MemoryLog(), { chunkSize: 10 });
    peers.push(receiver);

    const transferId = await receiver.bootstrap.begin('dc-a');
    const chunk = (chunkIndex: number, snapshotLsn: number, entryKey: string) =>
      frame(BOOTSTRAP_CHUNK_TYPE, 'dc-a', 'dc-b', {
        transferId,
        shardId: 'default',
        chunkIndex,
        totalChunks: 4,
        snapshotLsn,
        entries: [record(chunkIndex + 1, entryKey, `v-${entryKey}`).entry],
      });

    await receiver.bootstrap.handle(chunk(0, 5, 'a'));
    await waitFor(() => receiver.bootstrap.getStatus().chunksReceived === 1, 3_000, 'the first chunk');
    await receiver.bootstrap.handle(chunk(1, 5, 'b'));
    await waitFor(() => receiver.bootstrap.getStatus().chunksReceived === 2, 3_000, 'the second chunk');

    const halfway = receiver.bootstrap.getStatus();
    expect(halfway.chunksReceived).toBe(2);
    expect(halfway.transfers.inbound[0]?.expected).toBe(2);

    // A third chunk of a snapshot taken four writes later. The index is a position
    // in a dataset, and this is not that dataset: splicing it on would skip
    // exactly the entries whose insertion shifted every boundary after them — and
    // the transfer would still finish and report `complete`.
    await receiver.bootstrap.handle(chunk(2, 9, 'c'));
    await waitFor(() => receiver.bootstrap.getStatus().snapshotMoved === 1, 3_000, 'the restart');

    const reset = receiver.bootstrap.getStatus();
    expect(reset.snapshotMoved).toBe(1);
    expect(reset.lastError).toMatch(/restarting from chunk 0/);
    expect(reset.chunksReceived).toBe(2);
    expect(reset.transfers.inbound[0]?.expected).toBe(0);
    // The chunk of the other snapshot was never applied: half of a dataset with a
    // hole in it is worse than none of it.
    expect(receiver.provider.data.has('c')).toBe(false);

    // And the new snapshot is transferable in full, from the position the transfer
    // was reset to.
    for (let index = 0; index < 4; index += 1) {
      await receiver.bootstrap.handle(chunk(index, 9, `n${index}`));
    }
    await waitFor(() => receiver.bootstrap.getStatus().chunksReceived === 6, 3_000, 'the whole new snapshot');

    const done = receiver.bootstrap.getStatus();
    expect(done.chunksReceived).toBe(6);
    expect(done.transfers.inbound[0]?.phase).toBe('handoff');
    // The two entries of the abandoned snapshot stay: they were applied with their
    // own clocks and a re-application is idempotent, so the restart costs work and
    // not correctness. What must not happen is a hole, and there is none — the
    // complete new snapshot is here as well.
    expect(receiver.provider.data.size).toBe(6);
    expect(receiver.provider.data.has('n3')).toBe(true);
  });
});

describe('SnapshotBootstrap — the floor belongs to the sender', () => {
  const peers: Peer[] = [];

  afterEach(() => {
    for (const opened of peers) opened.unsubscribe();
    peers.length = 0;
  });

  it('asks for the handoff from the sender’s snapshot position, not its own', async () => {
    const key = `bs-floor-${Math.random().toString(36).slice(2)}`;
    // The sender's log is at position 1 and has one more change behind the
    // snapshot; the receiver has written five changes of its own, so its own
    // position is 5.
    const source = peer('dc-a', key, new ScriptedLog(1, [record(2, 'after', 'v2')]), { chunkSize: 10 });
    peers.push(source);
    source.provider.put('in-snapshot', 'v1');

    const receiverLog = new MemoryLog();
    for (let i = 0; i < 5; i += 1) receiverLog.append(`local-${i}`, `v${i}`);
    const receiver = peer('dc-b', key, receiverLog, { chunkSize: 10 });
    peers.push(receiver);

    await receiver.bootstrap.begin('dc-a');
    await waitFor(() => receiver.bootstrap.getStatus().completed.length === 1, 3_000, 'the transfer');

    // Two independent counters have never met: 5 here and 1 there are not ordered.
    // Taking the larger asks the sender for changes after a position its log never
    // reached, and the answer is nothing — a handoff that "completed" while
    // dropping the one change the snapshot did not cover.
    expect(receiver.bootstrap.getStatus().handoffApplied).toBe(1);
    expect(receiver.provider.data.get('after')?.value).toBe('v2');
  });
});
