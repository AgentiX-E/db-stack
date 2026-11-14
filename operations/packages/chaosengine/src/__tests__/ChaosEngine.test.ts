import { describe, it, expect } from 'vitest';
import { InMemoryChaosEngine } from '../impl/InMemoryChaosEngine.js';

describe('InMemoryChaosEngine', () => {
  it('starts with empty active faults', () => {
    const engine = new InMemoryChaosEngine();
    expect(engine.getActiveFaults()).toEqual([]);
  });

  it('starts with empty history', () => {
    const engine = new InMemoryChaosEngine();
    expect(engine.getHistory()).toEqual([]);
  });

  it('injects a latency fault', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'latency', target: 'db-1', durationMs: 1000 });
    expect(engine.getActiveFaults()).toHaveLength(1);
    expect(engine.getActiveFaults()[0].type).toBe('latency');
    expect(engine.getActiveFaults()[0].target).toBe('db-1');
  });

  it('adds fault to history after injection', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'error', target: 'write-endpoint', durationMs: 500 });
    expect(engine.getHistory()).toHaveLength(1);
  });

  it('injects multiple fault types', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'latency', target: 'db-1', durationMs: 100 });
    await engine.inject({ type: 'crash', target: 'node-3', durationMs: 0 });
    await engine.inject({ type: 'partition', target: 'replica-2', durationMs: 5000 });
    expect(engine.getActiveFaults()).toHaveLength(3);
  });

  it('resolves a fault by ID', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'latency', target: 'db-1', durationMs: 100 });
    await engine.inject({ type: 'error', target: 'db-2', durationMs: 200 });
    const faultId = 'fault-1';
    await engine.resolve(faultId);
    expect(engine.getActiveFaults()).toHaveLength(2);
  });

  it('resolve with non-existent ID does nothing', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'latency', target: 'db-1', durationMs: 100 });
    await engine.resolve('non-existent');
    expect(engine.getActiveFaults()).toHaveLength(1);
  });

  it('preserves config in active faults', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({
      type: 'resource_exhaustion',
      target: 'memory-pool',
      durationMs: 30000,
      config: { limit: '2GB' },
    });
    expect(engine.getActiveFaults()[0].config).toEqual({ limit: '2GB' });
  });

  it('does not mutate original config in history', async () => {
    const engine = new InMemoryChaosEngine();
    const fault = { type: 'error' as const, target: 'svc', durationMs: 100 };
    await engine.inject(fault);
    fault.target = 'modified';
    expect(engine.getHistory()[0].target).toBe('svc');
  });

  it('injects fault with zero duration', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'crash', target: 'node-1', durationMs: 0 });
    expect(engine.getActiveFaults()[0].durationMs).toBe(0);
  });

  it('handles resource_exhaustion fault type', async () => {
    const engine = new InMemoryChaosEngine();
    await engine.inject({ type: 'resource_exhaustion', target: 'disk', durationMs: 60000 });
    expect(engine.getActiveFaults()).toHaveLength(1);
  });
});
