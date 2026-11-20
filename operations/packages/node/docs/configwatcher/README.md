# @agentix-e/db-operations-node/configwatcher

**Watch a configuration, validate it against a schema, and reload it atomically — or not at all.**

A config file changes, a flag flips in an API, and the process either picks the change up safely or does not pick it up. This package is the "safely" part.

---

## Features

- **Schema validation** — type, required, nullable, enum, range, pattern, nested object and array
- **Deep diff** — `KeyDiff[]` with per-field changes for object values
- **Atomic reload** — every key validated before any is applied; a dry run returns the same structure
- **Checkpoints and rollback** — restore the previous configuration as one operation
- **Notification filters** — by prefix, key, glob, minimum severity or source
- **File watching** — poll-based, debounced, JSON / YAML / TOML / env

---

## Installation

```bash
npm install @agentix-e/db-operations-node
```

---

## Quick Start

```typescript
import { ConfigWatcher } from '@agentix-e/db-operations-node/configwatcher';

const config = new ConfigWatcher();
config.registerSchema({
  'pool.size': { type: 'integer', min: 1, max: 200, required: true },
  'pool.timeoutMs': { type: 'integer', min: 100, default: 5_000 },
});

const dryRun = config.reload(next, true);
if (!dryRun.success) throw new Error(`reload would fail: ${dryRun.failedKeys.join(', ')}`);

config.reload(next);
```

---

## API Reference

### `ConfigWatcher`

| Member | Return | Description |
|---|---|---|
| `watch(key, handler)` / `unwatch(key, handler?)` | `void` | Per-key subscribers |
| `set(key, value)` | `Promise<void>` | Writes one key; validated but not refused (see below) |
| `get<T>(key)` / `snapshot()` | `T \| undefined` / `Record<string, unknown>` | Read one / all |
| `registerSchema(schema)` | `void` | Adds fields to the schema |
| `validateAll()` / `validateKey(key, value)` | `ValidationResult` | Validate the snapshot / one candidate |
| `startFileWatch(options)` / `stopFileWatch()` | `void` | Debounced poll watching |
| `diff(a, b)` | `KeyDiff[]` | Deep diff |
| `reload(values, dryRun?)` | `ReloadResult` | Atomic replace |
| `rollback()` | `ReloadResult` | Restore the previous checkpoint |
| `getCheckpoints()` / `getLatestCheckpoint()` | `ConfigCheckpoint[]` / `ConfigCheckpoint \| null` | Checkpoint stack |
| `addNotificationFilter(filter)` | `void` | Suppression rules |

### `set` records, `reload` decides

`set` writes one key and puts the validation result in the `ConfigChangeEvent` subscribers receive. `reload` validates the whole set and applies **nothing** if any key fails. See [`docs/api/config-watching.md`](docs/api/config-watching.md) for why both exist.

### `SchemaField`

| Field | Meaning |
|---|---|
| `type` | `string`, `number`, `boolean`, `integer`, `array`, `object` |
| `required` / `nullable` | Presence rules |
| `enum` / `min` / `max` / `pattern` | Value constraints |
| `default` | Used when the key is absent |
| `properties` / `items` | Nested schema |

---

## Documentation

- [`docs/api/config-watching.md`](docs/api/config-watching.md) — the two write paths, notification filters, and why an editor's three writes need a debounce

---

## License

MIT
