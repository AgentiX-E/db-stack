/**
 * provider.ts — Provider registry and lifecycle management.
 *
 * The Provider pattern is the central wiring mechanism for db-operations.
 * Each interface category registers an implementation under a named key.
 * Consumers look up providers by interface token, not by import.
 *
 * This enables:
 *   1. Runtime-switchable implementations (e.g., SqlVecHealth ↔ GraphVecHealth)
 *   2. Test injection (Noop implementations registered in test setup)
 *   3. Lazy initialization (providers are created on first get())
 *   4. Lifecycle management (start/stop is orchestrated by the registry)
 *
 * @module @agentix-e/db-operations-core/provider
 */

import type { EngineType, LifecyclePhase } from './types.js';

// ══════════════════════════════════════════════════════════════════════
//  Interface Tokens
// ══════════════════════════════════════════════════════════════════════

/**
 * Unique symbol-based token for looking up a provider by interface type.
 *
 * Usage:
 * ```ts
 * const IHealthProbe = token<IHealthProbe>('health.probe');
 * const probe = registry.get(IHealthProbe);
 * ```
 */
export class InterfaceToken<T> {
  /** Human-readable namespace for debugging (e.g., 'health.probe'). */
  public readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  toString(): string {
    return `InterfaceToken(${this.namespace})`;
  }
}

/** Helper to create a typed interface token. */
export const token = <T>(namespace: string): InterfaceToken<T> =>
  new InterfaceToken<T>(namespace);

// ══════════════════════════════════════════════════════════════════════
//  Provider Lifecycle
// ══════════════════════════════════════════════════════════════════════

/**
 * Provider lifecycle contract.
 *
 * Every provider registered in the registry optionally implements this
 * to allow the registry to orchestrate start/stop across all providers.
 */
export interface IProviderLifecycle {
  /** Unique provider identifier (e.g., 'health.graphvec'). */
  readonly providerId: string;

  /** Current lifecycle phase. */
  readonly phase: LifecyclePhase;

  /**
   * Start the provider. Called during registry.start().
   * Must be idempotent — safe to call multiple times.
   */
  start(): Promise<void>;

  /**
   * Stop the provider. Called during registry.stop().
   * Must be idempotent — safe to call multiple times.
   */
  stop(): Promise<void>;

  /**
   * Health check specific to this provider.
   * Returns null if everything is healthy.
   */
  getHealth(): { ok: boolean; message?: string } | null;
}

// ══════════════════════════════════════════════════════════════════════
//  Registration Entry
// ══════════════════════════════════════════════════════════════════════

interface RegistrationEntry<T> {
  /** The registered instance. */
  instance: T;
  /** Engine type this provider is for. */
  engineType: EngineType;
  /** Priority for conflict resolution (higher wins, default = 0). */
  priority: number;
  /** Provider name for diagnostics. */
  name: string;
}

// ══════════════════════════════════════════════════════════════════════
//  Registry
// ══════════════════════════════════════════════════════════════════════

/**
 * Central provider registry for db-operations.
 *
 * Manages lifecycle and lookup for all operation providers.
 * Follows the Service Locator pattern — but with typed tokens and
 * explicit lifecycle management rather than global mutable state.
 */
export class ProviderRegistry {
  /** Map of token → sorted registrations. */
  private _registrations = new Map<
    string,                   // token.namespace
    RegistrationEntry<unknown>[]
  >();

  /** Track lifecycle-managed providers for start/stop orchestration. */
  private _lifecycleProviders = new Map<string, IProviderLifecycle>();

  /** Current registry lifecycle phase. */
  private _phase: LifecyclePhase = 'created';

  // ── Registration ──────────────────────────────────────────────────

  /**
   * Register a provider instance for the given interface token.
   *
   * @param iface - Interface token to register under.
   * @param instance - The provider implementation.
   * @param options - Registration options.
   */
  register<T>(
    iface: InterfaceToken<T>,
    instance: T,
    options?: {
      /** Engine type this provider belongs to (default: 'custom'). */
      engineType?: EngineType;
      /** Priority for conflict resolution (default: 0, higher wins). */
      priority?: number;
      /** Human-readable name for diagnostics. */
      name?: string;
    },
  ): this {
    const namespace = iface.namespace;
    if (!this._registrations.has(namespace)) {
      this._registrations.set(namespace, []);
    }

    const entries = this._registrations.get(namespace)!;
    const entry: RegistrationEntry<T> = {
      instance,
      engineType: options?.engineType ?? 'custom',
      priority: options?.priority ?? 0,
      name: options?.name ?? namespace,
    };

    // Maintain descending priority order.
    entries.push(entry as RegistrationEntry<unknown>);
    entries.sort((a, b) => b.priority - a.priority);

    // If the instance is lifecycle-managed, track it.
    if (this._isLifecycleManaged(instance)) {
      const lifecycle = instance as unknown as IProviderLifecycle;
      this._lifecycleProviders.set(lifecycle.providerId, lifecycle);
    }

    return this;
  }

  /**
   * Check if a registration exists for a given token.
   */
  has<T>(iface: InterfaceToken<T>): boolean {
    const entries = this._registrations.get(iface.namespace);
    return entries !== undefined && entries.length > 0;
  }

  /**
   * Get the highest-priority registered instance for the token.
   *
   * @throws {ProviderNotFoundError} if no registration exists.
   */
  get<T>(iface: InterfaceToken<T>): T {
    const entries = this._registrations.get(iface.namespace);
    if (!entries || entries.length === 0) {
      throw new ProviderNotFoundError(iface.namespace);
    }
    // Highest priority is first (sorted descending).
    return entries[0]!.instance as T;
  }

  /**
   * Get all registered instances for a token, ordered by priority (desc).
   *
   * Returns an empty array if none are registered (no throw).
   */
  getAll<T>(iface: InterfaceToken<T>): T[] {
    const entries = this._registrations.get(iface.namespace);
    if (!entries) return [];
    return entries.map(e => e.instance as T);
  }

  /**
   * Remove all registrations for a given interface token.
   */
  unregister<T>(iface: InterfaceToken<T>): void {
    this._registrations.delete(iface.namespace);
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this._registrations.clear();
    this._lifecycleProviders.clear();
  }

  // ── Registration helpers ──────────────────────────────────────────

  /**
   * Register multiple providers in a single call.
   * Useful for the engine bootstrap to register all its providers at once.
   */
  registerAll(registrations: Array<{
    token: InterfaceToken<unknown>;
    instance: unknown;
    engineType?: EngineType;
    priority?: number;
    name?: string;
  }>): this {
    for (const reg of registrations) {
      this.register(reg.token, reg.instance, {
        engineType: reg.engineType,
        priority: reg.priority,
        name: reg.name,
      });
    }
    return this;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start all lifecycle-managed providers.
   * Providers are started in registration order.
   */
  async start(): Promise<void> {
    if (this._phase === 'started' || this._phase === 'starting') return;
    this._phase = 'starting';

    const errors: Array<{ id: string; error: Error }> = [];
    for (const [id, provider] of this._lifecycleProviders) {
      try {
        await provider.start();
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }

    if (errors.length > 0) {
      // Still mark as started (partial failure) so other providers can be stopped.
      this._phase = 'started';
      throw new ProviderStartError(errors);
    }

    this._phase = 'started';
  }

  /**
   * Stop all lifecycle-managed providers.
   * Providers are stopped in reverse registration order.
   */
  async stop(): Promise<void> {
    if (this._phase === 'stopped' || this._phase === 'stopping') return;
    this._phase = 'stopping';

    const providers = Array.from(this._lifecycleProviders.entries()).reverse();
    const errors: Array<{ id: string; error: Error }> = [];
    for (const [id, provider] of providers) {
      try {
        await provider.stop();
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }

    this._phase = 'stopped';

    if (errors.length > 0) {
      throw new ProviderStopError(errors);
    }
  }

  /**
   * Get the current lifecycle phase.
   */
  get phase(): LifecyclePhase {
    return this._phase;
  }

  /**
   * Get a summary of all registered providers.
   */
  getSummary(): Array<{ token: string; name: string; engineType: EngineType }> {
    const result: Array<{ token: string; name: string; engineType: EngineType }> = [];
    for (const [namespace, entries] of this._registrations) {
      for (const entry of entries) {
        result.push({
          token: namespace,
          name: entry.name,
          engineType: entry.engineType,
        });
      }
    }
    return result;
  }

  // ── Private ───────────────────────────────────────────────────────

  private _isLifecycleManaged(instance: unknown): instance is IProviderLifecycle {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'providerId' in instance &&
      'start' in instance &&
      'stop' in instance
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Errors
// ══════════════════════════════════════════════════════════════════════

/** Thrown when get() is called for an unregistered token. */
export class ProviderNotFoundError extends Error {
  constructor(namespace: string) {
    super(`No provider registered for token: ${namespace}`);
    this.name = 'ProviderNotFoundError';
  }
}

/** Thrown when provider.start() fails for one or more providers. */
export class ProviderStartError extends Error {
  public readonly failures: Array<{ id: string; error: Error }>;

  constructor(failures: Array<{ id: string; error: Error }>) {
    const msg = failures.map(f => `[${f.id}] ${f.error.message}`).join('; ');
    super(`Provider start failed: ${msg}`);
    this.name = 'ProviderStartError';
    this.failures = failures;
  }
}

/** Thrown when provider.stop() fails for one or more providers. */
export class ProviderStopError extends Error {
  public readonly failures: Array<{ id: string; error: Error }>;

  constructor(failures: Array<{ id: string; error: Error }>) {
    const msg = failures.map(f => `[${f.id}] ${f.error.message}`).join('; ');
    super(`Provider stop failed: ${msg}`);
    this.name = 'ProviderStopError';
    this.failures = failures;
  }
}
