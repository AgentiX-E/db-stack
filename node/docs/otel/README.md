# @agentix-e/db-node/otel

**One in-process collector for the three OpenTelemetry signals — spans, metrics and logs — behind a three-method interface.**

The seam a deployment uses to *produce* telemetry without depending on an SDK, and the place a bridge to a real SDK attaches so that nothing else in the framework does.

---

## Features

- **Three signals, one object** — `startSpan`, `recordMetric`, `exportLog`
- **Narrow interface** — `IOTELBridge` is three methods wide, so an SDK adapter maps one-to-one
- **Truncation is visible** — a span whose `end()` was never called has no `endTime` in `getSpans()`
- **Shutdown means shutdown** — after `shutdown()`, new signals are refused rather than buffered

---

## Installation

```bash
npm install @agentix-e/db-node
```

---

## Quick Start

```typescript
import { InMemoryOTELBridge } from '@agentix-e/db-node/otel';

const otel = new InMemoryOTELBridge();
const { spanId, end } = otel.startSpan('vacuum', { attributes: { table: 'orders' } });

otel.recordMetric('vacuum_rows', 12_004, { table: 'orders' });
otel.exportLog({ severity: 'info', message: 'vacuum finished', attributes: { spanId } });
end('ok');

const spans = otel.getSpans();
await otel.shutdown();
```

---

## API Reference

### `IOTELBridge`

| Member | Return | Description |
|---|---|---|
| `startSpan(name, options?)` | `{ spanId, end }` | Records a span; `end(status?)` finishes it |
| `recordMetric(name, value, labels?)` | `void` | Appends one point |
| `exportLog(log)` | `void` | Appends one record; the timestamp is added here |
| `getSpans()` / `getMetrics()` / `getLogs()` | arrays | The recorded buffers |
| `shutdown()` | `Promise<void>` | Marks the bridge shut; later writes throw |
| `isShutdown()` | `boolean` | Whether it has been shut down |

### `OTSpan`

| Field | Type |
|---|---|
| `spanId` / `traceId` | `string` |
| `parentSpanId` | `string \| undefined` |
| `name` | `string` |
| `startTime` / `endTime` | `number` (epoch ms; `endTime` absent while running) |
| `attributes` | `Record<string, string \| number \| boolean>` |
| `status` | `'ok' \| 'error'` |

---

## Documentation

- [`docs/api/otel-bridge.md`](docs/api/otel-bridge.md) — bridging to a real SDK, and why the buffers are unbounded

---

## License

MIT
