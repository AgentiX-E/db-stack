import { describe, it, expect, vi } from 'vitest';
import { InMemoryConfigWatcher } from '../impl/InMemoryConfigWatcher.js';

describe('InMemoryConfigWatcher', () => {
  it('returns undefined for unset key', () => {
    const watcher = new InMemoryConfigWatcher();
    expect(watcher.get('nonexistent')).toBeUndefined();
  });

  it('sets and gets a value', async () => {
    const watcher = new InMemoryConfigWatcher();
    await watcher.set('db.host', 'localhost');
    expect(watcher.get('db.host')).toBe('localhost');
  });

  it('updates existing value', async () => {
    const watcher = new InMemoryConfigWatcher();
    await watcher.set('port', 3000);
    await watcher.set('port', 4000);
    expect(watcher.get('port')).toBe(4000);
  });

  it('snapshot returns all config', async () => {
    const watcher = new InMemoryConfigWatcher();
    await watcher.set('a', 1);
    await watcher.set('b', 'two');
    await watcher.set('c', true);
    const snap = watcher.snapshot();
    expect(snap).toEqual({ a: 1, b: 'two', c: true });
  });

  it('notifies handler on watch', async () => {
    const watcher = new InMemoryConfigWatcher();
    const handler = vi.fn();
    watcher.watch('key1', handler);
    await watcher.set('key1', 'value1');
    expect(handler).toHaveBeenCalledWith('key1', undefined, 'value1');
  });

  it('notifies handler with old and new values on update', async () => {
    const watcher = new InMemoryConfigWatcher();
    await watcher.set('key1', 'old');
    const handler = vi.fn();
    watcher.watch('key1', handler);
    await watcher.set('key1', 'new');
    expect(handler).toHaveBeenCalledWith('key1', 'old', 'new');
  });

  it('stops notifying after unwatch with specific handler', async () => {
    const watcher = new InMemoryConfigWatcher();
    const handler = vi.fn();
    watcher.watch('key1', handler);
    watcher.unwatch('key1', handler);
    await watcher.set('key1', 'value');
    expect(handler).not.toHaveBeenCalled();
  });

  it('removes all handlers on unwatch without handler', async () => {
    const watcher = new InMemoryConfigWatcher();
    const h1 = vi.fn();
    const h2 = vi.fn();
    watcher.watch('key1', h1);
    watcher.watch('key1', h2);
    watcher.unwatch('key1');
    await watcher.set('key1', 'value');
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('handles multiple watchers for same key', async () => {
    const watcher = new InMemoryConfigWatcher();
    const h1 = vi.fn();
    const h2 = vi.fn();
    watcher.watch('shared', h1);
    watcher.watch('shared', h2);
    await watcher.set('shared', 'updated');
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('supports complex object values', async () => {
    const watcher = new InMemoryConfigWatcher();
    const config = { pool: { min: 1, max: 10 } };
    await watcher.set('pool.config', config);
    expect(watcher.get('pool.config')).toEqual(config);
  });

  it('empty snapshot from fresh watcher', () => {
    const watcher = new InMemoryConfigWatcher();
    expect(watcher.snapshot()).toEqual({});
  });

  it('stops only one handler on unwatch with specific handler', async () => {
    const watcher = new InMemoryConfigWatcher();
    const h1 = vi.fn();
    const h2 = vi.fn();
    watcher.watch('key1', h1);
    watcher.watch('key1', h2);
    watcher.unwatch('key1', h1);
    await watcher.set('key1', 'val');
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });
});
