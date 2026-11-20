# ProviderRegistry — API Reference

## Constructor

```typescript
new ProviderRegistry()
```

Creates an empty provider registry with lifecycle phase `'created'`.

---

## Registration

### `register<T>(iface: InterfaceToken<T>, instance: T, options?: ProviderRegistrationOptions): void`

Register a provider instance under an interface token.

**Parameters:**
- `iface` — Typed interface token (created via `token<T>(namespace)`)
- `instance` — Concrete implementation of T
- `options` — Optional `{ engineType?: EngineType; priority?: number; name?: string }`

**Behavior:**
- If a higher-priority registration already exists for the same token, the new registration is stored but `get()` still returns the highest-priority instance
- Priority defaults to `0`
- Provider is not started automatically

### `registerAll<T>(registrations: Array<{ iface: InterfaceToken<T>; instance: T; options?: ProviderRegistrationOptions }>): void`

Register multiple providers in one call.

### `unregister<T>(iface: InterfaceToken<T>): void`

Remove all registrations for a given interface token.

### `clear(): void`

Remove all registrations from the registry. Active providers are not stopped.

---

## Lookup

### `has<T>(iface: InterfaceToken<T>): boolean`

Check if at least one provider is registered for the interface token.

### `get<T>(iface: InterfaceToken<T>): T`

Get the highest-priority registered instance.

**Throws:** `ProviderNotFoundError` if no registration exists for the token.

### `getAll<T>(iface: InterfaceToken<T>): T[]`

Get all registered instances for a token, sorted by priority descending.

---

## Lifecycle

### `async start(): Promise<void>`

Start all registered providers that implement `IProviderLifecycle`. Providers are started in priority order (highest first).

**Throws:** `ProviderStartError` with a `failures` array if any provider fails to start.

### `async stop(): Promise<void>`

Stop all registered providers that implement `IProviderLifecycle`. Providers are stopped in reverse priority order (lowest first).

**Throws:** `ProviderStopError` with a `failures` array if any provider fails to stop.

### `phase: LifecyclePhase` (property)

Get the current lifecycle phase: `'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'failed'`.

### `getSummary(): string`

Get a human-readable summary of all registered providers and current lifecycle phase.

---

## Error Classes

### `ProviderNotFoundError`

Thrown when `get()` is called for a token that has no registered providers.

```typescript
class ProviderNotFoundError extends Error {
  iface: InterfaceToken<unknown>;
}
```

### `ProviderStartError`

Thrown when one or more providers fail to start.

```typescript
class ProviderStartError extends Error {
  failures: Array<{ name: string; error: Error }>;
}
```

### `ProviderStopError`

Thrown when one or more providers fail to stop.

```typescript
class ProviderStopError extends Error {
  failures: Array<{ name: string; error: Error }>;
}
```

---

## InterfaceToken

### `token<T>(namespace: string): InterfaceToken<T>`

Create a typed interface token.

**Parameters:**
- `namespace` — Human-readable identifier string (e.g., `'db-ops.health.probe'`)

**Returns:** An `InterfaceToken<T>` instance with a `namespace` property.

```typescript
interface InterfaceToken<T> {
  namespace: string;
  toString(): string;
}
```

---

## IProviderLifecycle

Optional lifecycle interface that providers can implement.

```typescript
interface IProviderLifecycle {
  /** Initialize and start the provider. Idempotent. */
  start(): Promise<void>;

  /** Gracefully shut down the provider. Idempotent. */
  stop(): Promise<void>;

  /** Return health info, or null if healthy. */
  getHealth(): { ok: boolean; message?: string } | null;
}
```
