# Configuration watching

A database config file changes, a flag flips in an API, and the process either
picks it up safely or does not pick it up at all. This package is the "safely"
part: schema validation, diffing, atomic reload, checkpoints and rollback.

| Class | What it is |
|---|---|
| `InMemoryConfigWatcher` | The v1 surface: `watch`/`unwatch`/`set`/`get`/`snapshot`, no schema, no files, no reload |
| `ConfigWatcher` | The full engine: schema, file watch with debounce, deep diff, atomic reload, checkpoints |

```ts
import { ConfigWatcher } from "@agentix-e/db-operations-configwatcher";

const config = new ConfigWatcher();
config.registerSchema({
  "pool.size": { type: "integer", min: 1, max: 200, required: true },
  "pool.timeoutMs": { type: "integer", min: 100, default: 5_000 },
});

const result = config.reload(JSON.parse(await readFile("db.json", "utf8")), true); // dry run
if (!result.success) throw new Error(`reload would fail: ${result.failedKeys.join(", ")}`);

config.reload(JSON.parse(await readFile("db.json", "utf8")));
```

## `ConfigWatcher`

| Member | Contract |
|---|---|
| `watch(key, handler)` / `unwatch(key, handler?)` | Per-key subscribers. Omitting the handler removes every subscriber for that key |
| `set(key, value)` | Writes one key and notifies. The value is **validated but not refused**: the event carries the `ValidationResult` and the subscriber decides. `reload` is the path where a failure blocks the write |
| `get<T>(key)` / `snapshot()` | Read one value / the whole config as a plain object |
| `registerSchema(schema)` | Adds fields. Registering a key twice replaces its definition |
| `validateAll()` / `validateKey(key, value)` | Validate the snapshot / one candidate value |
| `startFileWatch(options)` / `stopFileWatch()` | Poll-based watching with a debounce window |
| `diff(a, b)` | `KeyDiff[]` with `op`, nested `changes`, and full snapshots for object values |
| `reload(values, dryRun?)` | Atomic replace. Every key is validated before any is applied |
| `rollback()` | Restore the previous checkpoint. Returns the same `ReloadResult` shape |
| `getCheckpoints()` / `getLatestCheckpoint()` | The checkpoint stack |
| `addNotificationFilter(filter)` | Suppress notifications by prefix, key, glob, minimum severity or source |

### `set` records, `reload` decides

The two write paths differ on purpose, and the difference is the reason both exist:

- **`set`** writes one key. It validates the value and puts the result in the
  `ConfigChangeEvent` that subscribers receive, but it applies the write either
  way. A single-key writer is usually code that knows what it is doing — a feature
  flag flipping, a migration step — and refusing it would mean that a schema
  registered for `reload`'s benefit silently breaks a `set` that was already
  reviewed.
- **`reload`** replaces the configuration as a unit. Every key is validated, and if
  any fails, **nothing is applied** — no key is written, no listener is notified.
  A half-applied configuration file is the state that produces an outage nobody can
  explain afterwards.

A caller that wants `reload`'s strictness for a single key calls
`reload({ [key]: value })`, which is the same operation with one entry.

### Reload is atomic, including the notifications

`reload` validates every key, computes the diff, and only then applies and
notifies. `ReloadResult` reports `success`, `changedKeys`, `failedKeys`,
per-key `validationResults`, the `previousSnapshot` (which is what `rollback`
restores) and `dryRun`.

A dry run returns the same structure with `success: false` when validation fails —
so a caller can gate a deployment on it without a second code path.

### The schema

`ConfigSchema` is a flat map of key → `SchemaField`:

| Field | Meaning |
|---|---|
| `type` | `string`, `number`, `boolean`, `integer`, `array`, `object` |
| `required` | Value must be present |
| `nullable` | `null`/`undefined` is acceptable |
| `enum` | Allowed values, for strings |
| `min` / `max` | Bounds for numbers and integers |
| `pattern` | Regex a string must match |
| `default` | Value used when the key is absent |
| `properties` / `items` | Nested schema for objects / arrays |

Validation produces **errors** and **warnings** separately. A warning is a value
that is legal but suspicious (an integer given as a string, a key not in the
schema); it does not block a reload, because a config that cannot be reloaded for a
cosmetic reason is a config nobody reloads.

### File watching

`FileWatchOptions` is `{ paths, mode?, pollIntervalMs?, formats?, debounceMs?, maxChangesPerWindow? }`.
`mode` is `'poll'`, `'inotify'` or `'none'`; the poll implementation is the one that
works everywhere, and `debounceMs` exists because an editor writing a file is
usually three writes — truncate, write, rename — and applying the config after the
first one applies a half-written file.

### Notification filters

`NotificationFilter` is `{ keyPrefixes?, keys?, globPatterns?, minSeverity?, excludeSources? }`.
Filters compose: an event must match every field that is present. `excludeSources`
is the one that matters in practice — a subscriber that reacts to `file_watch` but
not to its own `set` calls needs `excludeSources: ['set', 'programmatic']`, or it
will loop.

## What this does not do

No encryption, no remote config store, no distributed consistency. Two processes
watching the same file see the same change and each apply it independently; a
deployment that needs one decision maker needs a coordinator above this, not a
different watcher.
