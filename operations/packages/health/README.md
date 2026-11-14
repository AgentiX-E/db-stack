# @agentix-e/db-operations-health

**Kubernetes-style health probes, component registration, and health orchestration for database engine components.**

This package provides a K8s-inspired health-check system (liveness, readiness, startup probes) where every engine component implements an `IHealthProbe` interface and registers itself with a central `HealthOrchestrator`. The orchestrator aggregates all probes into a unified `HealthStatus` consumable by monitoring dashboards, HTTP health endpoints, and K8s exec probes.

---

## Features

- **Three probe types** — Liveness (fast, no I/O), Readiness (deeper, dependencies), Startup (initialization check)
- **Functional probe factory** — `componentProbe()` creates probes from simple callbacks without needing a class
- **Aggregate health** — Single `HealthStatus` combining all registered component probes
- **K8s-compatible** — `liveness()`, `readiness()`, `startup()` return `{ ok, errors }` suitable for `httpGet` or `exec` probes
- **Component registration** — Dynamic register/unregister for runtime-sharding components
- **Per-component error tracking** — Last error and uptime tracked individually

---

## Installation

```bash
npm install @agentix-e/db-operations-health
```

---

## Quick Start

```typescript
import { HealthOrchestrator, componentProbe } from '@agentix-e/db-operations-health';

// 1. Create the orchestrator
const health = new HealthOrchestrator();

// 2. Register a component probe (functional style)
health.registerFunctional('disk-monitor', 'Disk Monitor', {
  liveness: () => ({ ok: true }),
  readiness: () => {
    const free = getDiskFreeMB(); // some check
    return { ok: free > 100, message: `Free: ${free}MB` };
  },
});

// 3. Check health
console.log(health.liveness());   // { ok: true, errors: [] }
console.log(health.getSummary()); // "Status: healthy | Uptime: 42s | Components: 1/1 healthy"
```

---

## API Reference

### Interfaces

#### `IHealthProbe`

K8s-style probe interface for a single component.

| Method | Return | Description |
|---|---|---|
| `liveness()` | `ProbeResult` | Is the component alive? Fast (<10ms), no I/O |
| `readiness()` | `ProbeResult` | Can the component serve requests? May do I/O (<100ms) |
| `startup()` | `ProbeResult` | Has the component finished initialization? |

**Properties:**
- `probeId: string` — Unique probe identifier
- `componentName: string` — Human-readable component name

#### `IComponentRegistrar`

Dynamic component registration interface.

| Method | Return | Description |
|---|---|---|
| `registerComponent(probe, options?)` | `void` | Register a probe |
| `unregisterComponent(probeId)` | `void` | Remove a probe |
| `hasComponent(probeId)` | `boolean` | Check registration |
| `getComponentHealth()` | `ComponentHealth[]` | Get all component health |
| `getAggregateStatus()` | `{ status, count }` | Summary status (`'healthy'`, `'degraded'`, `'unhealthy'`) |

#### `IHealthOrchestrator`

Top-level health orchestration (extends `IComponentRegistrar`).

| Method | Return | Description |
|---|---|---|
| `liveness()` | `{ ok, errors }` | K8s-style liveness check |
| `readiness()` | `{ ok, errors }` | K8s-style readiness check |
| `startup()` | `{ ok, errors }` | K8s-style startup check |
| `getHealthStatus()` | `HealthStatus` | Structured health for dashboards |
| `getSummary()` | `string` | One-line summary for logging/CLI |

### Types

#### `ComponentRegistrationOptions`

```typescript
interface ComponentRegistrationOptions {
  metadata?: Record<string, string>;
  critical?: boolean; // default: true
}
```

---

## Implementations

### `HealthOrchestrator`

Concrete implementation of `IHealthOrchestrator`. Manages a registry of `IHealthProbe` instances.

**Constructor:**
```typescript
new HealthOrchestrator()
```

**Additional Methods:**
- `registerFunctional(probeId, componentName, checks, options?)` — Register a probe from function callbacks (convenience wrapper around `componentProbe()`)

**Thread safety:** All reads/writes to the probe map are synchronized (single-threaded Node.js event loop).

### `componentProbe(probeId, componentName, checks): IHealthProbe`

Factory function to create an `IHealthProbe` from callback functions.

**Parameters:**
- `probeId` — Unique identifier
- `componentName` — Display name
- `checks.liveness` — Required, returns `ProbeResult`
- `checks.readiness` — Optional, falls back to `liveness` if not set
- `checks.startup` — Optional, falls back to `readiness` → `liveness`

---

## Usage Examples

### Register a Critical Component

```typescript
import { HealthOrchestrator } from '@agentix-e/db-operations-health';

const health = new HealthOrchestrator();

health.registerFunctional('storage-engine', 'Storage Engine', {
  liveness: () => ({ ok: true }),
  readiness: () => {
    const pagesFree = checkFreePages(); // hypothetical check
    return {
      ok: pagesFree < 95_000,
      message: `Pages free: ${pagesFree}`,
      details: { pagesFree },
    };
  },
  startup: async () => {
    await waitForInit();
    return { ok: true };
  },
}, { critical: true });
```

### Check and Log Health

```typescript
const status = health.getHealthStatus();
console.log(`Overall: ${status.status}, Uptime: ${status.uptimeSeconds}s`);

for (const comp of status.components) {
  console.log(
    `  ${comp.componentName}: liveness=${comp.liveness.ok}, readiness=${comp.readiness.ok}`,
  );
}
```

### Dynamic Component Lifecycle

```typescript
// A shard manager adding/removing shard probes at runtime
class ShardManager {
  private health: IComponentRegistrar;

  addShard(shardId: string) {
    this.health.registerComponent(new ShardProbe(shardId));
  }

  removeShard(shardId: string) {
    this.health.unregisterComponent(`shard.${shardId}`);
  }
}
```

---

## Testing

```bash
cd packages/health
npm test
npm run test:watch  # Watch mode
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Provides `ProbeResult`, `ComponentHealth`, `HealthStatus`, `ComponentRegistrationOptions` types
