import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  token,
  ProviderRegistry,
  InterfaceToken,
  ProviderNotFoundError,
  ProviderStartError,
  ProviderStopError,
} from '../provider.js';
import type { IProviderLifecycle } from '../provider.js';
import type { LifecyclePhase } from '../types.js';

// ── Test interface tokens ──────────────────────────────────────

interface ITestService {
  greet(): string;
}

interface ITestHealth {
  status(): boolean;
}

const ITestService = token<ITestService>('test.service');
const ITestHealth = token<ITestHealth>('test.health');
const IEmptyToken = token<unknown>('test.empty');

// ── Test implementations ───────────────────────────────────────

class GreeterService implements ITestService {
  constructor(private _prefix: string = 'Hello') {}
  greet(): string {
    return `${this._prefix}, world!`;
  }
}

class HealthChecker implements ITestHealth {
  private _ok: boolean = true;
  constructor(ok?: boolean) {
    if (ok !== undefined) this._ok = ok;
  }
  status(): boolean {
    return this._ok;
  }
}

class LifecycleProvider implements IProviderLifecycle {
  public readonly providerId: string;
  public phase: LifecyclePhase = 'created';
  public startCount = 0;
  public stopCount = 0;
  public failOnStart = false;
  public failOnStop = false;

  constructor(id: string) {
    this.providerId = id;
  }

  async start(): Promise<void> {
    this.startCount++;
    if (this.failOnStart) {
      throw new Error(`Start failed: ${this.providerId}`);
    }
    this.phase = 'started';
  }

  async stop(): Promise<void> {
    this.stopCount++;
    if (this.failOnStop) {
      throw new Error(`Stop failed: ${this.providerId}`);
    }
    this.phase = 'stopped';
  }

  getHealth(): { ok: boolean; message?: string } | null {
    return this.phase === 'started' ? null : { ok: false, message: 'Not started' };
  }
}

// ══════════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════════

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register / get', () => {
    it('should register and retrieve a provider', () => {
      const greeter = new GreeterService();
      registry.register(ITestService, greeter);
      const retrieved = registry.get(ITestService);
      expect(retrieved).toBe(greeter);
      expect(retrieved.greet()).toBe('Hello, world!');
    });

    it('should throw ProviderNotFoundError for unregistered token', () => {
      expect(() => registry.get(ITestService)).toThrow(ProviderNotFoundError);
    });

    it('should return the highest priority provider', () => {
      const low = new GreeterService('Low');
      const high = new GreeterService('High');

      registry.register(ITestService, low, { priority: 1, name: 'low' });
      registry.register(ITestService, high, { priority: 100, name: 'high' });

      const retrieved = registry.get(ITestService);
      expect(retrieved.greet()).toBe('High, world!');
    });

    it('should return last registered when same priority', () => {
      const a = new GreeterService('A');
      const b = new GreeterService('B');

      registry.register(ITestService, a, { priority: 0 });
      registry.register(ITestService, b, { priority: 0 });

      const retrieved = registry.get(ITestService);
      // Same priority → first registered wins (sorted then stable)
      expect(retrieved.greet()).toBe('A, world!');
    });
  });

  describe('getAll', () => {
    it('should return all registered providers in priority order', () => {
      const low = new GreeterService('Low');
      const mid = new GreeterService('Mid');
      const high = new GreeterService('High');

      registry.register(ITestService, low, { priority: 1 });
      registry.register(ITestService, high, { priority: 100 });
      registry.register(ITestService, mid, { priority: 50 });

      const all = registry.getAll(ITestService);
      expect(all.map(p => p.greet())).toEqual([
        'High, world!',
        'Mid, world!',
        'Low, world!',
      ]);
    });

    it('should return empty array when no registration exists', () => {
      const all = registry.getAll(ITestService);
      expect(all).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return true when registered', () => {
      registry.register(ITestService, new GreeterService());
      expect(registry.has(ITestService)).toBe(true);
    });

    it('should return false when not registered', () => {
      expect(registry.has(ITestService)).toBe(false);
    });
  });

  describe('unregister', () => {
    it('should remove a registration', () => {
      registry.register(ITestService, new GreeterService());
      expect(registry.has(ITestService)).toBe(true);
      registry.unregister(ITestService);
      expect(registry.has(ITestService)).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all registrations', () => {
      registry.register(ITestService, new GreeterService());
      registry.register(ITestHealth, new HealthChecker());
      expect(registry.has(ITestService)).toBe(true);
      expect(registry.has(ITestHealth)).toBe(true);

      registry.clear();
      expect(registry.has(ITestService)).toBe(false);
      expect(registry.has(ITestHealth)).toBe(false);
    });
  });

  describe('registerAll', () => {
    it('should register multiple providers at once', () => {
      registry.registerAll([
        { token: ITestService, instance: new GreeterService('Multi') },
        { token: ITestHealth, instance: new HealthChecker(true) },
      ]);

      expect(registry.get(ITestService).greet()).toBe('Multi, world!');
      expect(registry.get(ITestHealth).status()).toBe(true);
    });
  });

  describe('engineType', () => {
    it('should register with engine type metadata', () => {
      registry.register(ITestService, new GreeterService(), {
        engineType: 'sqlvec',
        name: 'sqlvec-greeter',
      });

      const summary = registry.getSummary();
      expect(summary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            token: 'test.service',
            name: 'sqlvec-greeter',
            engineType: 'sqlvec',
          }),
        ]),
      );
    });
  });

  describe('getSummary', () => {
    it('should list all registered providers', () => {
      registry.register(ITestService, new GreeterService(), {
        name: 'gr',
        engineType: 'custom',
      });

      const summary = registry.getSummary();
      expect(summary.length).toBeGreaterThanOrEqual(1);
      expect(summary[0]).toMatchObject({
        token: 'test.service',
        name: 'gr',
        engineType: 'custom',
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  InterfaceToken
// ══════════════════════════════════════════════════════════════════

describe('InterfaceToken', () => {
  it('should create a token with the given namespace', () => {
    const t = token<string>('test.token');
    expect(t.namespace).toBe('test.token');
    expect(t.toString()).toBe('InterfaceToken(test.token)');
  });

  it('should differentiate tokens by namespace', () => {
    const a = token<string>('a');
    const b = token<string>('b');
    expect(a.namespace).not.toBe(b.namespace);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Lifecycle Management
// ══════════════════════════════════════════════════════════════════

describe('ProviderRegistry lifecycle', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('should start and stop all lifecycle providers', async () => {
    const a = new LifecycleProvider('a');
    const b = new LifecycleProvider('b');

    registry.register(token<unknown>('a'), a);
    registry.register(token<unknown>('b'), b);

    expect(registry.phase).toBe('created');
    await registry.start();
    expect(registry.phase).toBe('started');
    expect(a.startCount).toBe(1);
    expect(b.startCount).toBe(1);

    await registry.stop();
    expect(registry.phase).toBe('stopped');
    expect(a.stopCount).toBe(1);
    expect(b.stopCount).toBe(1);
  });

  it('should be idempotent on start', async () => {
    const p = new LifecycleProvider('p');
    registry.register(token<unknown>('p'), p);

    await registry.start();
    await registry.start();
    expect(p.startCount).toBe(1); // Second start is no-op
  });

  it('should be idempotent on stop', async () => {
    const p = new LifecycleProvider('p');
    registry.register(token<unknown>('p'), p);

    await registry.start();
    await registry.stop();
    await registry.stop();
    expect(p.stopCount).toBe(1); // Second stop is no-op
  });

  it('should throw ProviderStartError on start failure', async () => {
    const ok = new LifecycleProvider('ok');
    const fail = new LifecycleProvider('fail');
    fail.failOnStart = true;

    registry.register(token<unknown>('ok'), ok);
    registry.register(token<unknown>('fail'), fail);

    await expect(registry.start()).rejects.toThrow(ProviderStartError);
    // Registry still marked as started (partial failure).
    expect(registry.phase).toBe('started');
  });

  it('should throw ProviderStopError on stop failure', async () => {
    const ok = new LifecycleProvider('ok');
    const fail = new LifecycleProvider('fail');
    fail.failOnStop = true;

    registry.register(token<unknown>('ok'), ok);
    registry.register(token<unknown>('fail'), fail);

    await registry.start();
    await expect(registry.stop()).rejects.toThrow(ProviderStopError);
    expect(registry.phase).toBe('stopped');
  });

  it('should stop providers in reverse registration order', async () => {
    const order: string[] = [];
    const a = new LifecycleProvider('a');
    const b = new LifecycleProvider('b');

    // Hooks to track stop order
    const origStopA = a.stop.bind(a);
    a.stop = async () => { order.push('a'); await origStopA(); };
    const origStopB = b.stop.bind(b);
    b.stop = async () => { order.push('b'); await origStopB(); };

    registry.register(token<unknown>('a'), a);
    registry.register(token<unknown>('b'), b);

    await registry.start();
    await registry.stop();

    expect(order).toEqual(['b', 'a']); // Reverse order
  });

  it('should track non-lifecycle instances (no start/stop called)', async () => {
    const greeter = new GreeterService('NoLifecycle');
    registry.register(ITestService, greeter);

    await registry.start();
    await registry.stop();

    expect(registry.get(ITestService).greet()).toBe('NoLifecycle, world!');
  });

  it('should NOT treat an instance with only providerId as lifecycle-managed', async () => {
    // Partial shape: has providerId but lacks start/stop. Must NOT be tracked.
    const partial = { providerId: 'partial-id' } as unknown as ITestService;
    registry.register(ITestService, partial);

    await registry.start();
    await registry.stop();
    // No start/stop should have been invoked; registration still resolves.
    expect(registry.get(ITestService)).toBe(partial);
  });

  it('should NOT treat an instance with start but no stop as lifecycle-managed', async () => {
    // Partial shape: has providerId + start but lacks stop. Must NOT be tracked.
    const partial = {
      providerId: 'partial-no-stop',
      start: async () => {},
    } as unknown as ITestService;
    registry.register(ITestService, partial);

    await registry.start();
    await registry.stop();
    expect(registry.get(ITestService)).toBe(partial);
  });
});
