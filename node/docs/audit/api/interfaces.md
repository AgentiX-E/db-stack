# Audit Package API

## Interfaces

### `IAuditStore`

| Method | Return | Description |
|---|---|---|
| `write(options)` | `Promise<string>` | Write entry, returns UUID |
| `query(filter)` | `Promise<AuditEntry[]>` | Query with filters, paginated |
| `get(id)` | `Promise<AuditEntry \| null>` | Get by ID |
| `count(filter?)` | `Promise<number>` | Count matching entries |
| `pruneOlderThan(timestamp)` | `Promise<number>` | Delete old entries, returns count |

### `IAuditExporter`

| Method | Return |
|---|---|
| `exportToFile(outputPath, options)` | `Promise<number>` |
| `exportToString(options)` | `Promise<string>` |

## Types

### `WriteAuditEntryOptions`

| Field | Type | Required |
|---|---|---|
| `operation` | `string` | Yes |
| `actor` | `string` | Yes |
| `resource` | `string` | Yes |
| `result` | `'success' \| 'failure' \| 'denied'` | Yes |
| `severity` | `AuditSeverity` | No (default: 'info') |
| `details` | `Record<string, unknown>` | No |
| `traceId` | `string` | No |

### `AuditQueryFilter`

| Field | Type |
|---|---|
| `startTime?` | `Date` |
| `endTime?` | `Date` |
| `operation?` | `string` |
| `actor?` | `string` |
| `result?` | `'success' | 'failure' | 'denied'` |
| `severity?` | `AuditSeverity` |
| `limit?` | `number` |
| `offset?` | `number` |

## Implementations

- **`InMemoryAuditStore`** — Map-based storage with ordered array for queries. Uses `randomUUID()`.
- **`JsonAuditExporter`** — Pretty-printed JSON array. Requires an `IAuditStore` instance.
