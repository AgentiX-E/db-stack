# Examples

## Full Application Startup

```typescript
import { ProviderRegistry } from '@agentix-e/db-operations-core';
import { IHealthProbe, HealthOrchestrator } from '@agentix-e/db-operations-health';
import { IMetricsRegistry, MetricsRegistry } from '@agentix-e/db-operations-metrics';
import { ILogger, InMemoryLogger } from '@agentix-e/db-operations-logger';
import { IBackupManager, InMemoryBackupManager } from '@agentix-e/db-operations-backup';

async function startup() {
  const registry = new ProviderRegistry();

  // Register core services
  registry.register(ILogger, new InMemoryLogger('app', 1000), {
    priority: 100,
    engineType: 'custom',
    name: 'main-logger',
  });

  registry.register(IMetricsRegistry, new MetricsRegistry(), {
    priority: 100,
    engineType: 'custom',
    name: 'metrics',
  });

  // Register health probes
  const health = new HealthOrchestrator();
  registry.register(IHealthProbe, health, {
    priority: 100,
    engineType: 'custom',
    name: 'health-orch',
  });

  // Start all
  await registry.start();
  console.log('System started, phase:', registry.phase);
  return registry;
}

startup().then((registry) => {
  console.log(registry.getSummary());
});
```

## Multi-Engine Registration

```typescript
const registry = new ProviderRegistry();

// sqlvec engine — high priority
registry.register(IRepository, new SqlvecRepository(), {
  engineType: 'sqlvec',
  priority: 50,
});

// graphvec engine — lower priority (fallback)
registry.register(IRepository, new GraphvecRepository(), {
  engineType: 'graphvec',
  priority: 30,
});

// sqlvec wins for default lookup
const repo = registry.get(IRepository); // returns SqlvecRepository
```

## Token Namespace Convention

Use reverse-domain or hierarchical namespaces for interface tokens:

```typescript
const IHealthProbe = token<IHealthProbe>('db-ops.health.probe');
const IMetricsRegistry = token<IMetricsRegistry>('db-ops.metrics.registry');
const ILogger = token<ILogger>('db-ops.logger');
const IBackupManager = token<IBackupManager>('db-ops.backup.manager');
```

## Error Recovery Flow

```typescript
const registry = new ProviderRegistry();

try {
  await registry.start();
} catch (err) {
  if (err instanceof ProviderStartError) {
    console.error('Failed to start providers:', err.failures);
    // Inspect individual failures
    for (const f of err.failures) {
      console.error(`  ${f.name}: ${f.error.message}`);
    }
    // Attempt graceful shutdown of already-started providers
    await registry.stop().catch(() => {});
  }
}
```
