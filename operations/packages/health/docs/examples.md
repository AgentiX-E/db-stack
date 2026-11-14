# Examples

## HTTP Health Check Endpoint (Express/Koa)

```typescript
import { HealthOrchestrator } from '@agentix-e/db-operations-health';
import express from 'express';

const health = new HealthOrchestrator();
const app = express();

// Register probes for each subsystem
health.registerFunctional('database', 'SQLite Engine', {
  liveness: () => ({ ok: true }),
  readiness: async () => {
    try {
      await db.execute('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
});

health.registerFunctional('cache', 'In-Memory Cache', {
  liveness: () => ({ ok: true }),
  readiness: () => {
    const hitRate = cache.getHitRate();
    return { ok: hitRate > 0.1, message: `Hit rate: ${hitRate}` };
  },
});

// K8s-compatible endpoints
app.get('/healthz', (req, res) => {
  const result = health.liveness();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/readyz', (req, res) => {
  const result = health.readiness();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/health', (req, res) => {
  res.json(health.getHealthStatus());
});
```

## Class-Based Probe

```typescript
import { IHealthProbe } from '@agentix-e/db-operations-health';
import { ProbeResult } from '@agentix-e/db-operations-core/types';

class StorageEngineProbe implements IHealthProbe {
  readonly probeId = 'storage-engine';
  readonly componentName = 'Storage Engine';

  private healthy = true;
  private errors: string[] = [];

  liveness(): ProbeResult {
    return { ok: this.healthy };
  }

  readiness(): ProbeResult {
    if (!this.healthy) {
      return { ok: false, message: 'Storage engine is down' };
    }
    if (this.errors.length > 5) {
      return { ok: true, message: 'Degraded', details: { errorCount: this.errors.length } };
    }
    return { ok: true };
  }

  startup(): ProbeResult {
    return { ok: true };
  }

  // Called by the storage engine on error
  reportError(err: Error): void {
    this.errors.push(err.message);
    if (this.errors.length > 10) {
      this.healthy = false;
    }
  }
}

// Usage
const probe = new StorageEngineProbe();
health.registerComponent(probe, { critical: true });
```

## Console Summary

```typescript
// Quick status for CLI / logs
console.log(health.getSummary());
// Example output:
// "Status: degraded | Uptime: 3600s | Components: 3/4 healthy | Failing: 1 component(s) | Last error: [cache] Connection timeout"
```
