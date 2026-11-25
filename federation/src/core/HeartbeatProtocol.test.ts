/**
 * HeartbeatProtocol — the beat on the wire, and what a lost, duplicated or late
 * one means.
 *
 * The three cases below are the reason the sequence number exists. A local
 * emission could not be lost, duplicated or reordered, so none of them had a
 * meaning; a frame can be all three, and each has to be distinguished from the
 * others before the detector is allowed to draw a conclusion:
 *
 *   - lost → nothing arrives, the detector's expiry scan reports it once;
 *   - duplicated → the same interval twice, dropped, because three copies of one
 *     beat would otherwise look like three beats;
 *   - late → dropped, because the detector measures divergence by whether two
 *     datacenters' HLC chains both advance, and a frame that inserts a past clock
 *     into the present manufactures exactly that pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InProcessTransport } from '../transport/InProcessTransport';
import { HLC } from '../hlc/HLC';
import { DCSplitBrainDetector } from './DCSplitBrainDetector';
import { HeartbeatProtocol } from './HeartbeatProtocol';
import { HEARTBEAT_TYPE, buildHeartbeatFrame } from './heartbeatFrame';
import type { HeartbeatBody } from './heartbeatFrame';

const INTERVAL = 20;

interface BeatNode {
  transport: InProcessTransport;
  detector: DCSplitBrainDetector;
  protocol: HeartbeatProtocol;
  unsubscribe: () => void;
}

function beatNode(nodeId: string, dcId: string, registryKey: string, targets: string[]): BeatNode {
  const transport = new InProcessTransport({ nodeId, registryKey });
  const detector = new DCSplitBrainDetector({ nodeId, dcId, hlc: new HLC(nodeId), heartbeatIntervalMs: INTERVAL });
  detector.start();
  const protocol = new HeartbeatProtocol(transport, new HLC(nodeId), detector, {
    nodeId,
    dcId,
    targets,
    intervalMs: INTERVAL,
  });
  const unsubscribe = transport.onMessage((msg) => {
    protocol.handle(msg);
  });
  return { transport, detector, protocol, unsubscribe };
}

function frame(from: string, to: string, body: HeartbeatBody) {
  return buildHeartbeatFrame(`hb-${body.seq}-${from}`, from, to, body, new HLC(from).now());
}

function body(overrides: Partial<HeartbeatBody> = {}): HeartbeatBody {
  return {
    dcId: 'dc-b',
    nodeId: 'node-b',
    seq: 1,
    sentAt: Date.now(),
    hlc: { wallTime: Date.now(), logical: 1, nodeId: 'node-b' },
    appliedCount: 0,
    ...overrides,
  };
}

describe('HeartbeatProtocol — sending', () => {
  it('advances the sequence once per beat, not once per target', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    new InProcessTransport({ nodeId: 'node-b', registryKey: key });
    new InProcessTransport({ nodeId: 'node-c', registryKey: key });
    const node = beatNode('node-a', 'dc-a', key, ['node-b', 'node-c']);

    const delivered = await node.protocol.beat();

    expect(delivered).toBe(2);
    expect(node.protocol.getStatus().selfSeq).toBe(1);
    expect(node.protocol.getStatus().sent).toBe(2);

    await node.protocol.beat();
    expect(node.protocol.getStatus().selfSeq).toBe(2);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });

  it('reports a transport that refuses the frame', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, ['nobody']);

    const delivered = await node.protocol.beat();

    expect(delivered).toBe(0);
    expect(node.protocol.getStatus().lastError).toMatch(/refused a heartbeat/);
    expect(node.protocol.getStatus().sent).toBe(0);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });

  it('does not beat on start', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, ['node-b']);
    node.protocol.start();

    expect(node.protocol.getStatus().sent).toBe(0);
    expect(node.protocol.getStatus().selfSeq).toBe(0);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });

  it('beats on its interval when started', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    new InProcessTransport({ nodeId: 'node-b', registryKey: key });
    const node = beatNode('node-a', 'dc-a', key, ['node-b']);
    node.protocol.start();

    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
    node.protocol.stop();

    expect(node.protocol.getStatus().selfSeq).toBeGreaterThanOrEqual(1);

    node.unsubscribe();
    node.detector.stop();
  });

  it('does not start a second timer when started twice', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    new InProcessTransport({ nodeId: 'node-b', registryKey: key });
    const node = beatNode('node-a', 'dc-a', key, ['node-b']);

    node.protocol.start();
    // A supervisor that calls `start()` twice must not leave two timers beating:
    // the peer would then see two intervals per interval, and the detector's
    // missed-beat arithmetic would describe a schedule nobody is running.
    node.protocol.start();
    await node.protocol.beat();
    node.protocol.stop();

    expect(node.protocol.getStatus().selfSeq).toBe(1);

    node.unsubscribe();
    node.detector.stop();
  });

  it('beats on demand when no interval is configured', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const transport = new InProcessTransport({ nodeId: 'node-a', registryKey: key });
    const detector = new DCSplitBrainDetector({
      nodeId: 'node-a',
      dcId: 'dc-a',
      hlc: new HLC('node-a'),
      heartbeatIntervalMs: INTERVAL,
    });
    detector.start();
    // No `intervalMs`: 1 000 by default, and a manual beat still works — the
    // default is a schedule, not a precondition.
    const protocol = new HeartbeatProtocol(transport, new HLC('node-a'), detector, {
      nodeId: 'node-a',
      dcId: 'dc-a',
      targets: [],
    });

    expect(await protocol.beat()).toBe(0);
    expect(protocol.getStatus().selfSeq).toBe(1);

    protocol.stop();
    detector.stop();
  });

  it('records a socket that rejected the frame', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, ['node-b']);
    node.transport.send = async () => {
      throw new Error('socket exploded');
    };

    const delivered = await node.protocol.beat();

    // A rejection is not a refusal: the frame did not leave, and the operator's
    // status line has to say which. Neither stops the sequence from advancing —
    // this interval happened whether or not anybody heard it.
    expect(delivered).toBe(0);
    expect(node.protocol.getStatus().lastError).toMatch(/socket exploded/);
    expect(node.protocol.getStatus().selfSeq).toBe(1);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });

  it('records a detector that cannot produce a heartbeat', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, []);
    node.detector.generateHeartbeat = () => {
      // eslint-disable-next-line no-throw-literal -- the case under test is a detector that fails with a value rather than an Error
      throw 'detector is stopped';
    };

    // On a timer there is nobody to receive a rejection, so the failure is
    // recorded and the beat returns. The reason is kept verbatim, because a
    // detector that throws a string is a detector whose failure would otherwise
    // read as `[object Object]`.
    expect(await node.protocol.beat()).toBe(0);
    expect(node.protocol.getStatus().lastError).toBe('detector is stopped');
    expect(node.protocol.getStatus().selfSeq).toBe(0);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });
});

describe('HeartbeatProtocol — receiving', () => {
  let key: string;
  let receiver: BeatNode;

  beforeEach(() => {
    key = `hb-${Math.random().toString(36).slice(2)}`;
    receiver = beatNode('node-a', 'dc-a', key, []);
  });

  afterEach(() => {
    receiver.protocol.stop();
    receiver.unsubscribe();
    receiver.detector.stop();
  });

  it('feeds a fresh beat to the detector', () => {
    const accepted = receiver.protocol.handle({
      ...frame('node-b', 'node-a', body({ seq: 1 })),
      receivedAt: Date.now(),
    });

    expect(accepted).toBe(true);
    expect(receiver.protocol.getStatus().received).toBe(1);
    expect(receiver.protocol.getStatus().peers['node-b']).toMatchObject({ seq: 1 });
  });

  it('drops a duplicate beat instead of counting the same instant twice', () => {
    const beat = body({ seq: 3 });
    receiver.protocol.handle({ ...frame('node-b', 'node-a', beat), receivedAt: Date.now() });
    receiver.protocol.handle({ ...frame('node-b', 'node-a', beat), receivedAt: Date.now() });

    expect(receiver.protocol.getStatus().outOfOrder).toBe(1);
    expect(receiver.protocol.getStatus().received).toBe(1);
  });

  it('drops a reordered beat so the HLC chain cannot run backwards', () => {
    const older = body({ seq: 2, sentAt: Date.now() - 1_000, hlc: { wallTime: 1, logical: 1, nodeId: 'node-b' } });
    receiver.protocol.handle({ ...frame('node-b', 'node-a', body({ seq: 5 })), receivedAt: Date.now() });
    receiver.protocol.handle({ ...frame('node-b', 'node-a', older), receivedAt: Date.now() });

    expect(receiver.protocol.getStatus().outOfOrder).toBe(1);
    expect(receiver.protocol.getStatus().received).toBe(1);
    // The accepted sequence is still the newer one.
    expect(receiver.protocol.getStatus().peers['node-b']!.seq).toBe(5);
  });

  it('accepts a higher sequence whose send time went backwards, and says why', () => {
    const first = body({ seq: 1, sentAt: 2_000 });
    const second = body({ seq: 2, sentAt: 1_000 });

    receiver.protocol.handle({ ...frame('node-b', 'node-a', first), receivedAt: Date.now() });
    receiver.protocol.handle({ ...frame('node-b', 'node-a', second), receivedAt: Date.now() });

    // Accepted: refusing it would freeze the peer's liveness on an older beat.
    // Recorded: a clock that stepped back is why the detector's chain will look
    // strange on the next tick.
    expect(receiver.protocol.getStatus().received).toBe(2);
    expect(receiver.protocol.getStatus().lastError).toMatch(/out of order by sentAt/);
  });

  it('counts a frame it cannot read and does not feed it to the detector', () => {
    receiver.protocol.handle({
      messageId: 'garbage',
      sourcePeerId: 'node-b',
      targetPeerId: 'node-a',
      payload: new TextEncoder().encode('{"seq":1}'),
      timestamp: new HLC('node-b').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: HEARTBEAT_TYPE,
    });

    expect(receiver.protocol.getStatus().malformed).toBe(1);
    expect(receiver.protocol.getStatus().received).toBe(0);
    expect(receiver.protocol.getStatus().lastError).toMatch(/not a decodable heartbeat/);
  });

  it('declines a frame of another family', () => {
    expect(
      receiver.protocol.handle({
        messageId: 'x',
        sourcePeerId: 'node-b',
        targetPeerId: 'node-a',
        payload: new Uint8Array(),
        timestamp: new HLC('node-b').now(),
        createdAt: Date.now(),
        receivedAt: Date.now(),
        type: 'ae_push',
      }),
    ).toBe(false);
  });
});

describe('HeartbeatProtocol — silence', () => {
  it('counts the silence the detector reports, once', async () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, []);
    node.protocol.start();

    // A datacenter heard from once, then never again.
    node.detector.receiveHeartbeat({
      dcId: 'dc-b',
      nodeId: 'node-b',
      hlc: { wallTime: 1, logical: 0, nodeId: 'node-b' },
      appliedCount: 0,
      timestamp: Date.now() - 10_000,
    });

    const reported: string[] = [];
    node.detector.onHeartbeatExpired((event) => reported.push(event.dcId));

    // Two ticks of the detector's own scan: the event must be reported once, not
    // once per tick — a counter that grows while nothing changes is not a
    // measurement.
    node.detector['broadcastHeartbeat']();
    node.detector['broadcastHeartbeat']();

    expect(reported).toEqual(['dc-b']);
    expect(node.protocol.getStatus().expired).toBe(1);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });

  it('reports a datacenter that speaks again as a new silence later', () => {
    const key = `hb-${Math.random().toString(36).slice(2)}`;
    const node = beatNode('node-a', 'dc-a', key, []);
    node.protocol.start();

    const reported: string[] = [];
    node.detector.onHeartbeatExpired((event) => reported.push(event.dcId));

    node.detector.receiveHeartbeat({
      dcId: 'dc-b',
      nodeId: 'node-b',
      hlc: { wallTime: 1, logical: 0, nodeId: 'node-b' },
      appliedCount: 0,
      timestamp: Date.now() - 10_000,
    });
    node.detector['broadcastHeartbeat']();

    // It speaks: the silence is over.
    node.detector.receiveHeartbeat({
      dcId: 'dc-b',
      nodeId: 'node-b',
      hlc: { wallTime: 2, logical: 0, nodeId: 'node-b' },
      appliedCount: 1,
      timestamp: Date.now(),
    });
    node.detector['broadcastHeartbeat']();

    // And goes quiet again — a second silence, reported as a second event.
    node.detector['remoteHeartbeats'].set('dc-b', {
      dcId: 'dc-b',
      nodeId: 'node-b',
      hlc: { wallTime: 2, logical: 0, nodeId: 'node-b' },
      appliedCount: 1,
      timestamp: Date.now() - 10_000,
    });
    node.detector['broadcastHeartbeat']();

    expect(reported).toEqual(['dc-b', 'dc-b']);

    node.protocol.stop();
    node.unsubscribe();
    node.detector.stop();
  });
});
