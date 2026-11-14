import type { IConfigWatcher } from '../interfaces/index.js';
import type { ConfigChangeHandler } from '../interfaces/types.js';

/**
 * InMemoryConfigWatcher — minimal in-process config store with change handlers.
 *
 * Implements the core `IConfigWatcher` contract (watch / unwatch / set / get /
 * snapshot). Schema validation, file watching, reload and rollback live in
 * `ConfigWatcher`, which additionally implements `IConfigWatcherV2`.
 *
 * Handlers receive `(key, oldValue, newValue)` — the core callback shape.
 */
export class InMemoryConfigWatcher implements IConfigWatcher {
  private store: Map<string, unknown> = new Map();
  private handlers: Map<string, Set<ConfigChangeHandler>> = new Map();

  watch(key: string, handler: ConfigChangeHandler): void {
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler);
  }

  unwatch(key: string, handler?: ConfigChangeHandler): void {
    if (!handler) {
      this.handlers.delete(key);
      return;
    }
    const handlers = this.handlers.get(key);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(key);
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const oldValue = this.store.get(key);
    this.store.set(key, value);
    const handlers = this.handlers.get(key);
    if (handlers) {
      for (const handler of handlers) {
        handler(key, oldValue, value);
      }
    }
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.store) {
      result[key] = value;
    }
    return result;
  }
}
