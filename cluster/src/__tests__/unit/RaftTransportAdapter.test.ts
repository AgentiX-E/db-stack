/**
 * RaftTransportAdapter Unit Tests
 *
 * Iteration 17 - Pipeline replication, self-message routing, peer state management.
 *
 * RaftTransportAdapter bridges @maboke123/raft-core's transport.send() to RaftTcpTransport
 * and implements pipeline replication (GAP-2) with per-peer in-flight tracking.
 *
 * Acceptance Criteria:
 *   AC 17.1: Constructor accepts TransportLike + selfNodeId
 *   AC 17.2: registerPeer creates pipeline state for new peer
 *   AC 17.3: acknowledgeEntry advances matchIndex contiguously
 *   AC 17.4: acknowledgeEntry handles out-of-order ACKs
 *   AC 17.5: rejectEntry clears in-flight and triggers serial mode after threshold
 *   AC 17.6: canSendTo returns true when window has capacity
 *   AC 17.7: canSendTo returns false when window is full in pipeline mode
 *   AC 17.8: canSendTo returns true only when in-flight=0 in serial mode
 *   AC 17.9: send routes self-messages to selfStep callback
 *   AC 17.10: send routes peer messages to underlying transport.send()
 *   AC 17.11: send converts Uint8Array entry data to base64 string
 *   AC 17.12: reset clears all peer states
 *   AC 17.13: setPipelineWindowConfig updates maxInFlight/rejection config
 *   AC 17.14: getPeerStates returns snapshot of current states
 *   AC 17.15: getInFlightCount returns correct count for peer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftTransportAdapter } from '../../consensus/transport/RaftTransportAdapter';

// Mock TransportLike
let transportSendMock: any;

function createMockTransport() {
  transportSendMock = vi.fn().mockResolvedValue(undefined);
  return { send: transportSendMock };
}

// Mock RaftMessage generators
function makeAppendEntries(to: string, entries: Array<{ index: string }>): any {
  return {
    msgType: 1,
    from: '1',
    to,
    term: '1',
    entries: entries.map((e) => ({
      ...e,
      term: '1',
      type: 0,
      data: new Uint8Array([1, 2, 3]),
    })),
  };
}

describe('RaftTransportAdapter - Unit', () => {
  let adapter: RaftTransportAdapter;
  let transport: { send: any };

  beforeEach(() => {
    transport = createMockTransport();
    adapter = new RaftTransportAdapter(transport, 1);
  });

  //
  // AC 17.1: Constructor
  //
  it('AC 17.1: Constructor accepts TransportLike + selfNodeId', () => {
    const a = new RaftTransportAdapter({ send: vi.fn() }, 5);
    expect(a).toBeInstanceOf(RaftTransportAdapter);
  });

  //
  // AC 17.2: registerPeer creates pipeline state
  //
  it('AC 17.2: registerPeer creates pipeline state', () => {
    adapter.registerPeer('2', 1);
    const states = adapter.getPeerStates();
    expect(states.has('2')).toBe(true);
    const s = states.get('2')!;
    expect(s.nextIndex).toBe(1);
    expect(s.matchIndex).toBe(0);
    expect(s.caughtUp).toBe(true);
    expect(s.serialMode).toBe(false);
    expect(s.rejectionCount).toBe(0);
  });

  //
  // AC 17.3: acknowledgeEntry advances matchIndex
  //
  it('AC 17.3: acknowledgeEntry advances matchIndex contiguously', () => {
    adapter.registerPeer('2', 1);
    adapter.acknowledgeEntry('2', 1);
    const s = adapter.getPeerStates().get('2')!;
    expect(s.matchIndex).toBe(1);
    expect(s.nextIndex).toBeGreaterThanOrEqual(2);
    expect(s.rejectionCount).toBe(0);
  });

  //
  // AC 17.4: acknowledgeEntry handles out-of-order ACKs
  //
  it('AC 17.4: acknowledgeEntry handles out-of-order ACKs', async () => {
    adapter.registerPeer('2', 1);

    const msg1 = makeAppendEntries('2', [{ index: '1' }]);
    const msg2 = makeAppendEntries('2', [{ index: '2' }]);
    const msg3 = makeAppendEntries('2', [{ index: '3' }]);

    transportSendMock.mockResolvedValue(undefined);
    await adapter.send('1', [msg1]);
    await adapter.send('1', [msg2]);
    await adapter.send('1', [msg3]);

    // ACK 3 first - matchIndex stays at 0 (gap before 1)
    adapter.acknowledgeEntry('2', 3);
    expect(adapter.getPeerStates().get('2')!.matchIndex).toBe(0);

    // ACK 1 - advances to 1 (contiguous from 0+1)
    adapter.acknowledgeEntry('2', 1);
    expect(adapter.getPeerStates().get('2')!.matchIndex).toBe(1);

    // ACK 2 - advances into the gap (maxSent bounded by nextIndex+inFlight)
    adapter.acknowledgeEntry('2', 2);
    expect(adapter.getPeerStates().get('2')!.matchIndex).toBe(2);
  });

  //
  // AC 17.5: rejectEntry clears in-flight and triggers serial mode after threshold
  //
  it('AC 17.5: rejectEntry clears in-flight and triggers serial mode', async () => {
    adapter.setPipelineWindowConfig({ maxRejectionsBeforeSerial: 2 });
    adapter.registerPeer('2', 5);

    const msg = makeAppendEntries('2', [{ index: '5' }]);
    transportSendMock.mockResolvedValue(undefined);
    await adapter.send('1', [msg]);

    // First rejection
    adapter.rejectEntry('2', 5);
    const st1 = adapter.getPeerStates().get('2')!;
    expect(st1.serialMode).toBe(false);
    expect(st1.rejectionCount).toBe(1);
    expect(st1.nextIndex).toBe(5);
    expect(st1.inFlight.has(5)).toBe(false);

    // Second send + rejection
    const msg2 = makeAppendEntries('2', [{ index: '5' }]);
    await adapter.send('1', [msg2]);
    adapter.rejectEntry('2', 5);
    const st2 = adapter.getPeerStates().get('2')!;
    expect(st2.rejectionCount).toBe(2);
    expect(st2.serialMode).toBe(true);
  });

  //
  // AC 17.6: canSendTo returns true when window has capacity
  //
  it('AC 17.6: canSendTo returns true with capacity', () => {
    adapter.registerPeer('2', 1);
    expect(adapter.canSendTo('2')).toBe(true);
  });

  //
  // AC 17.7: canSendTo returns false when window is full
  //
  it('AC 17.7: canSendTo returns false when window full', async () => {
    adapter.setPipelineWindowConfig({ maxInFlight: 2 });
    adapter.registerPeer('2', 1);

    const fillMsg = makeAppendEntries('2', [{ index: '1' }, { index: '2' }]);
    transportSendMock.mockResolvedValue(undefined);
    await adapter.send('1', [fillMsg]);
    expect(adapter.canSendTo('2')).toBe(false);
  });

  //
  // AC 17.8: canSendTo in serial mode requires inFlight=0
  //
  it('AC 17.8: canSendTo in serial mode requires inFlight=0', async () => {
    adapter.registerPeer('2', 1);

    // Mark serialMode = true by reaching rejection threshold
    adapter.setPipelineWindowConfig({ maxRejectionsBeforeSerial: 1 });
    const msg = makeAppendEntries('2', [{ index: '5' }]);
    transportSendMock.mockResolvedValue(undefined);
    await adapter.send('1', [msg]);
    adapter.rejectEntry('2', 5);

    const st = adapter.getPeerStates().get('2')!;
    expect(st.serialMode).toBe(true);
    expect(st.inFlight.size).toBe(0);

    // Serial mode, no in-flight -> can send
    expect(adapter.canSendTo('2')).toBe(true);

    // Send while in serial mode
    const msg2 = makeAppendEntries('2', [{ index: '5' }]);
    await adapter.send('1', [msg2]);
    expect(adapter.getPeerStates().get('2')!.inFlight.size).toBe(1);
    expect(adapter.canSendTo('2')).toBe(false);

    // Acknowledge -> can send again
    adapter.acknowledgeEntry('2', 5);
    const st2 = adapter.getPeerStates().get('2')!;
    expect(st2.inFlight.size).toBe(0);
    expect(adapter.canSendTo('2')).toBe(true);
  });

  //
  // AC 17.9: send routes self-messages to selfStep
  //
  it('AC 17.9: send routes self-messages to selfStep', async () => {
    const selfStep = vi.fn();
    adapter.selfStep = selfStep;
    const selfMsg = { msgType: 18, from: '1', to: '1', term: '1' };
    await adapter.send('1', [selfMsg]);
    expect(selfStep).toHaveBeenCalledWith(selfMsg);
    expect(transportSendMock).not.toHaveBeenCalled();
  });

  //
  // AC 17.10: send routes peer messages to transport.send()
  //
  it('AC 17.10: send routes peer messages to transport.send()', async () => {
    const peerMsg = { msgType: 1, from: '1', to: '2', term: '1' };
    await adapter.send('1', [peerMsg]);
    expect(transportSendMock).toHaveBeenCalledWith(1, [peerMsg]);
  });

  //
  // AC 17.11: send converts Uint8Array entry data to base64
  //
  it('AC 17.11: send converts Uint8Array entry data to base64', async () => {
    const msg = makeAppendEntries('2', [{ index: '5' }]);
    await adapter.send('1', [msg]);
    const sentMsg = transportSendMock.mock.calls[0][1][0];
    expect(sentMsg.entries[0].data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(sentMsg.entries[0].data).not.toBeInstanceOf(Uint8Array);
  });

  //
  // AC 17.12: reset clears all peer states
  //
  it('AC 17.12: reset clears all peer states', () => {
    adapter.registerPeer('2', 1);
    adapter.registerPeer('3', 1);
    expect(adapter.getPeerStates().size).toBe(2);
    adapter.reset();
    expect(adapter.getPeerStates().size).toBe(0);
  });

  //
  // AC 17.13: setPipelineWindowConfig updates maxInFlight/rejection config
  //
  it('AC 17.13: setPipelineWindowConfig updates config', () => {
    adapter.setPipelineWindowConfig({ maxInFlight: 128, maxRejectionsBeforeSerial: 5 });
    const config = adapter.getPipelineWindowConfig();
    expect(config.maxInFlight).toBe(128);
    expect(config.maxRejectionsBeforeSerial).toBe(5);
    // Clamping: min values
    adapter.setPipelineWindowConfig({ maxInFlight: 0 });
    expect(adapter.getPipelineWindowConfig().maxInFlight).toBe(1);
  });

  //
  // AC 17.14: getPeerStates returns snapshot
  //
  it('AC 17.14: getPeerStates returns snapshot', () => {
    adapter.registerPeer('2', 5);
    const snap = adapter.getPeerStates();
    expect(snap.get('2')!.nextIndex).toBe(5);
    // Modifying the snapshot should not affect original
    snap.get('2')!.nextIndex = 999;
    expect(adapter.getPeerStates().get('2')!.nextIndex).toBe(5);
  });

  //
  // AC 17.15: getInFlightCount returns count
  //
  it('AC 17.15: getInFlightCount returns inflight count', async () => {
    expect(adapter.getInFlightCount('not-registered')).toBe(0);
    adapter.registerPeer('2', 1);
    expect(adapter.getInFlightCount('2')).toBe(0);
    const msg = makeAppendEntries('2', [{ index: '1' }]);
    transportSendMock.mockResolvedValue(undefined);
    await adapter.send('1', [msg]);
    expect(adapter.getInFlightCount('2')).toBe(1);
  });
});
