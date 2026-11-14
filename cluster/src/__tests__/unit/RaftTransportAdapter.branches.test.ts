/**
 * RaftTransportAdapter — boundary branch coverage
 *
 * Complements RaftTransportAdapter.test.ts with the remaining uncovered
 * branches: null-safe early returns for unregistered peers, pipeline-window
 * `enabled` toggle, ArrayBuffer entry encoding, null message filtering,
 * the `index || '1'` fallback, and the (no-op but required) register().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftTransportAdapter } from '../../consensus/transport/RaftTransportAdapter';

describe('RaftTransportAdapter — branch completion', () => {
  let adapter: RaftTransportAdapter;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined);
    adapter = new RaftTransportAdapter({ send }, 1);
  });

  it('acknowledgeEntry is a no-op for an unregistered peer', () => {
    // `if (!state) return` — peer never registered
    expect(() => adapter.acknowledgeEntry('unknown', 1)).not.toThrow();
    expect(adapter.getInFlightCount('unknown')).toBe(0);
  });

  it('rejectEntry is a no-op for an unregistered peer', () => {
    expect(() => adapter.rejectEntry('unknown', 5)).not.toThrow();
    expect(adapter.getInFlightCount('unknown')).toBe(0);
  });

  it('canSendTo returns true for an unregistered peer', () => {
    expect(adapter.canSendTo('unknown')).toBe(true);
  });

  it('canSendTo ignores window capacity when pipeline is disabled', () => {
    adapter.setPipelineWindowConfig({ enabled: false });
    adapter.registerPeer('2', 1);
    // Fill the window beyond maxInFlight — disabled pipeline always allows send.
    const state = (adapter as any)._peerStates.get('2');
    for (let i = 0; i < 200; i++) state.inFlight.set(i, true);
    expect(adapter.canSendTo('2')).toBe(true);
  });

  it('setPipelineWindowConfig updates enabled flag', () => {
    // `config.enabled !== undefined` false branch (enabled provided)
    adapter.setPipelineWindowConfig({ enabled: false });
    expect(adapter.getPipelineWindowConfig().enabled).toBe(false);
    adapter.setPipelineWindowConfig({ enabled: true });
    expect(adapter.getPipelineWindowConfig().enabled).toBe(true);
  });

  it('send encodes ArrayBuffer entry data as base64', async () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([9, 8, 7]);
    const msg = {
      msgType: 1,
      from: '1',
      to: '2',
      entries: [{ index: '1', term: '1', data: ab }],
    };
    await adapter.send('1', [msg]);
    const sent = send.mock.calls[0][1][0];
    expect(sent.entries[0].data).toBe(Buffer.from([9, 8, 7]).toString('base64'));
  });

  it('send skips null/undefined entries in the message list', async () => {
    const realMsg = { msgType: 1, from: '1', to: '2', term: '1' };
    await adapter.send('1', [null, undefined, realMsg]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual([realMsg]);
  });

  it('send uses the "1" fallback when the first entry index is absent', async () => {
    const msg = {
      msgType: 1,
      from: '1',
      to: '2',
      entries: [{ term: '1', data: new Uint8Array([1]) }], // no index field
    };
    await adapter.send('1', [msg]);
    // `Number(msg.entries[0].index || '1')` -> registerPeer('2', 1)
    const state = adapter.getPeerStates().get('2');
    expect(state).toBeTruthy();
    expect(state!.nextIndex).toBe(1);
  });

  it('register is callable (no-op by design)', () => {
    expect(() => adapter.register({ id: 1 })).not.toThrow();
  });
});
