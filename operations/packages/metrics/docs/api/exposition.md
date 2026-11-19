# Exporting metrics

`MetricsRegistry` records. Something has to leave the process.

## `PrometheusPushExporter`

Converts any `IMetricsRegistry` to the Prometheus text exposition format and
`PUT`s it to a PushGateway. Pull-based scraping needs an HTTP listener in the
database process, which is a listener an operator did not ask for; a push needs
egress and nothing else, which is why this is the shape a database ships.

```ts
import { MetricsRegistry, PrometheusPushExporter } from "@agentix-e/db-operations-metrics";

const registry = new MetricsRegistry();
const exporter = new PrometheusPushExporter(registry, {
  pushGatewayUrl: "http://pushgateway.monitoring:9091",
  job: "db-operations",
  instance: process.env.HOSTNAME!,
  pushIntervalMs: 15_000,
});

exporter.start();   // pushes every 15 s; `pushIntervalMs: 0` means manual only
```

| Member | Contract |
|---|---|
| `constructor(registry, config)` | Takes the registry by interface, so a registry that is not `MetricsRegistry` works |
| `start()` | Starts the interval when `pushIntervalMs > 0`. **The first push happens one interval from now**, not at start |
| `stop()` | Stops the interval. An in-flight push is not cancelled |
| `push()` | One `PUT`. Rejects on a non-2xx answer, on timeout, and on a transport failure |

`PrometheusPushExporterConfig`:

| Field | Default | Meaning |
|---|---|---|
| `pushGatewayUrl` | — | Required. `http://pushgateway:9091`, without a trailing path |
| `job` | — | Required. The `job` grouping key |
| `instance` | — | Required. The `instance` grouping key |
| `groupingLabels` | — | Extra grouping keys, e.g. `{ cluster: "prod-eu" }` |
| `pushIntervalMs` | — | `0` or omitted: manual only |
| `timeoutMs` | — | HTTP timeout |

Grouping keys are what make the push idempotent. A PushGateway replaces the group
a push names; two processes pushing the same job and instance overwrite each
other's metrics, and the survivor is whichever pushed last. `instance` is required
for that reason — omitting it would make a three-replica deployment report one
replica's numbers.

## Format

One `# TYPE` line per family, then one line per series:

```
# TYPE db_connections_total counter
db_connections_total{db="orders"} 42
# TYPE db_replication_lag_seconds gauge
db_replication_lag_seconds{db="orders",replica="eu-1"} 0.318
```

Counters, gauges and histograms are grouped by name so that a family with two
label sets is one family with two series, not two families.

## What is not exported

Nothing reads the exporter's own state: there is no counter for pushes attempted,
pushes failed or bytes sent. In `pushIntervalMs` mode the loop catches its own
rejection and writes it to `console.error`, so a failing pipeline leaves no metric
behind — the only evidence is a gap in the gateway. Calling `push()` yourself is
the path that surfaces the error to code that can act on it.
