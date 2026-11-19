/**
 * InMemoryCDCSink Tests — In-memory CDC sink.
 *
 * Coverage:
 *   - single event emit
 *   - multiple events, retrieved in order via getEvents
 *   - connect/disconnect lifecycle
 *   - emit on disconnected sink throws
 *   - clear() empties store
 *   - emit empty array = no-op
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCDCSink } from './InMemoryCDCSink';
import type { CDCSinkEvent } from '../interfaces/replication/ICDCSink';

function makeEvent(overrides: Partial<CDCSinkEvent> = {}): CDCSinkEvent {
  return {
    id: overrides.id ?? 'evt-1',
    type: overrides.type ?? 'insert',
    table: overrides.table ?? 'users',
    key: overrides.key ?? '42',
    data: overrides.data ?? { name: 'Alice' },
    timestamp: overrides.timestamp ?? 1000n,
  };
}

describe('InMemoryCDCSink', () => {
  let sink: InMemoryCDCSink;

  beforeEach(() => {
    sink = new InMemoryCDCSink();
  });

  describe('emit', () => {
    it('should store a single event', async () => {
      await sink.connect();
      const event = makeEvent({ id: 'evt-1' });
      await sink.emit([event]);

      const events = sink.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('evt-1');
    });

    it('should store multiple events in order', async () => {
      await sink.connect();
      await sink.emit([
        makeEvent({ id: 'evt-1', timestamp: 1n }),
        makeEvent({ id: 'evt-2', timestamp: 2n }),
        makeEvent({ id: 'evt-3', timestamp: 3n }),
      ]);

      const events = sink.getEvents();
      expect(events).toHaveLength(3);
      expect(events[0]!.id).toBe('evt-1');
      expect(events[1]!.id).toBe('evt-2');
      expect(events[2]!.id).toBe('evt-3');
    });

    it('should be a no-op when emitting an empty array', async () => {
      await sink.connect();
      await sink.emit([]);
      expect(sink.getEvents()).toHaveLength(0);
    });
  });

  describe('lifecycle', () => {
    it('should start disconnected and become connected after connect()', async () => {
      expect(sink.connected).toBe(false);
      await sink.connect();
      expect(sink.connected).toBe(true);
    });

    it('should become disconnected after disconnect()', async () => {
      await sink.connect();
      expect(sink.connected).toBe(true);
      await sink.disconnect();
      expect(sink.connected).toBe(false);
    });

    it('should throw when emitting while disconnected', async () => {
      await expect(sink.emit([makeEvent()])).rejects.toThrow('disconnected');
    });

    it('should support connect → emit → disconnect lifecycle', async () => {
      await sink.connect();
      await sink.emit([makeEvent({ id: 'lifecycle-test' })]);
      expect(sink.getEvents()).toHaveLength(1);
      await sink.disconnect();
      expect(sink.connected).toBe(false);
    });

    it('should support custom sink name', () => {
      const named = new InMemoryCDCSink('my-test-sink');
      expect(named.name).toBe('my-test-sink');
    });
  });

  describe('clear', () => {
    it('should clear all stored events', async () => {
      await sink.connect();
      await sink.emit([makeEvent({ id: 'evt-1' }), makeEvent({ id: 'evt-2' })]);
      expect(sink.getEvents()).toHaveLength(2);

      sink.clear();
      expect(sink.getEvents()).toHaveLength(0);
    });
  });
});
