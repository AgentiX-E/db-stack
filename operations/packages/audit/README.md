# @agentix-e/db-operations-audit

**Audit log storage and export — record, query, prune, and export audit entries for database engine operations.**

This package provides a complete audit trail system. Components can write structured audit entries (operation, actor, resource, result, severity), query them with flexible filters, prune old entries, and export to JSON format for compliance and analysis.

---

## Features

- **Structured audit entries** — Every entry carries ID, timestamp, operation, actor, resource, result, severity, optional details, and trace ID
- **Flexible query filtering** — Filter by time range, operation, actor, result, severity with pagination (limit/offset)
- **Entry-level operations** — Write, get by ID, count, prune older than timestamp
- **JSON export** — Export to file or string, pretty-printed JSON array format
- **In-memory store** — Fast Map-based storage with ordered traversal for testing and development

---

## Installation

```bash
npm install @agentix-e/db-operations-audit
```

---

## Quick Start

```typescript
import { InMemoryAuditStore, JsonAuditExporter } from '@agentix-e/db-operations-audit';

// Create the audit store
const store = new InMemoryAuditStore();

// Write audit entries
const id1 = await store.write({
  operation: 'USER_LOGIN',
  actor: 'alice',
  resource: 'auth/session',
  result: 'success',
  severity: 'info',
  details: { ip: '10.0.0.1' },
});

const id2 = await store.write({
  operation: 'BACKUP_CREATE',
  actor: 'system',
  resource: 'backup/weekly',
  result: 'success',
  severity: 'info',
});

// Query entries
const failedLogins = await store.query({
  operation: 'USER_LOGIN',
  result: 'failure',
});
console.log(`${failedLogins.length} failed logins`);

// Export to JSON string
const exporter = new JsonAuditExporter(store);
const json = await exporter.exportToString({ format: 'json-array' });
console.log(json);
```

---

## API Reference

### Interfaces

#### `IAuditStore`

| Method | Return | Description |
|---|---|---|
| `write(options)` | `Promise<string>` | Write an audit entry, returns entry ID |
| `query(filter)` | `Promise<AuditEntry[]>` | Query entries with filters |
| `get(id)` | `Promise<AuditEntry \| null>` | Get entry by ID |
| `count(filter?)` | `Promise<number>` | Count entries matching filter |
| `pruneOlderThan(timestamp)` | `Promise<number>` | Delete entries older than timestamp, returns count |

#### `IAuditExporter`

| Method | Return | Description |
|---|---|---|
| `exportToFile(outputPath, options)` | `Promise<number>` | Export to file, returns entry count |
| `exportToString(options)` | `Promise<string>` | Export as string |

### Types

#### `WriteAuditEntryOptions`

| Field | Type | Required | Description |
|---|---|---|---|
| `operation` | `string` | Yes | Operation being audited |
| `actor` | `string` | Yes | Who performed the operation |
| `resource` | `string` | Yes | Resource acted upon |
| `result` | `'success' \| 'failure' \| 'denied'` | Yes | Operation result |
| `severity?` | `AuditSeverity` | No | Severity level (default: `'info'`) |
| `details?` | `Record<string, unknown>` | No | Optional details |
| `traceId?` | `string` | No | Trace ID for correlation |

#### `AuditQueryFilter`

| Field | Type | Description |
|---|---|---|
| `startTime?` | `Date` | Filter by start time (inclusive) |
| `endTime?` | `Date` | Filter by end time (inclusive) |
| `operation?` | `string` | Filter by operation name |
| `actor?` | `string` | Filter by actor |
| `result?` | `'success' \| 'failure' \| 'denied'` | Filter by result |
| `severity?` | `AuditSeverity` | Filter by severity level |
| `limit?` | `number` | Max results (default: 100) |
| `offset?` | `number` | Pagination offset |

---

## Implementations

### `InMemoryAuditStore`

Full implementation of `IAuditStore`. Stores entries in a `Map<string, AuditEntry>` with an ordered array for sequential queries.

- **ID generation:** Uses `randomUUID()` from `node:crypto`
- **Query:** Sequential scan with all filter combinators ANDed together
- **Pruning:** Synchronously filters in-memory data
- **No memory limit** — entries accumulate until explicitly pruned

### `FileAuditStore`

The production store: NDJSON segments on disk, rotation by size or age, gzip
archives, retention by segment age, and queries that read across the live segment
and the archives. Reads and writes each have a port, so the trail can live
somewhere other than the local filesystem without losing either.

**A write is durable when it returns.** `write()` appends the line, syncs the file,
and — once per segment, after its first line — syncs the directory that names it.
A file's existence is a directory entry, and syncing the file does not sync the
name, so without the third step a power cut can leave the entries on the medium
and the segment unreachable. If any step fails, `write()` **rejects**: an id means
"this survives a power loss", and a store that acknowledges an entry it could not
make durable is a store that lies about the one thing it exists to record.

There is no temporary file and no `rename`. An append-only trail does not need
whole-file replacement, and it costs the segment's whole size to perform one per
line — measured at 1 000× the payload before this was changed. Because the append
is an `O_APPEND` write, two processes may append to the same trail without losing
each other's lines.

```typescript
import { FileAuditStore } from '@agentix-e/db-operations-audit';

const store = new FileAuditStore({
  dataDir: '/var/lib/db/audit',
  maxFileSize: 50 * 1024 * 1024, // rotate at 50 MB
  retentionDays: 90,             // expire closed segments older than this
});

const id = await store.write({
  operation: 'DROP_TABLE',
  actor: 'alice',
  resource: 'orders',
  result: 'success',
});

await store.query({ actor: 'alice' });   // reads the newest segment first
await store.count({ result: 'failure' }); // a fact, not a page
await store.pruneOlderThan(new Date(Date.now() - 30 * 24 * 3600 * 1000));
await store.close();                     // waits for background compression
```

| Config | Default | Meaning |
|---|---|---|
| `dataDir` | — | Directory the store owns; created if absent |
| `maxFileSize` | 50 MB | Rotate when the live segment reaches this |
| `maxAgeMs` | 24 h | Rotate when the live segment is this old |
| `retentionDays` | 90 | Expire closed segments older than this; `0` disables the sweep |
| `filePrefix` | `audit` | Segment name prefix (`<prefix>-YYYYMMDD-NNNN.ndjson[.gz]`) |
| `maxScanLines` | 10 000 | Bound on what `query()` *reads and returns*; `get()`/`count()` are unbounded |
| `segmentReader` | `readSegmentFromDisk` | Read port: `(path, compressed) => string \| null` |
| `fileSystem` | `nodeDurableFileSystem` | Write port: `append`, `syncFile`, `syncDirectory`, `needsSeparator` |

A custom write port must be durable when each method returns — that is the whole
contract, and it is the caller's to keep:

```typescript
import { FileAuditStore, type DurableFileSystem } from '@agentix-e/db-operations-audit';

const objectStore: DurableFileSystem = {
  append: (path, data) => bucket.appendObject(path, data),
  syncFile: (path) => bucket.commitObject(path),
  syncDirectory: () => {},                        // object stores have no directory entries
  needsSeparator: (path) => bucket.endsWithNewline(path),
};

new FileAuditStore({ dataDir: 'audit/', fileSystem: objectStore });
```

What no test can prove, and what the guarantee therefore does not claim: that a
synced line survives a **power cut** — a killed process leaves the page cache
behind, so `SIGKILL` shows the line is in the file and not that it reached the
medium. Durability is also not free: one `fsync` per entry allows roughly a hundred
acknowledged entries per second per writer on a device with a 10 ms flush.

### `JsonAuditExporter`

Exports entries from an `IAuditStore` to pretty-printed JSON (json-array format). Supports both file and string output.

**Constructor:** `new JsonAuditExporter(store: IAuditStore)`

---

## Usage Examples

### Security Incident Audit Trail

```typescript
import { InMemoryAuditStore } from '@agentix-e/db-operations-audit';

class SecurityAuditor {
  constructor(private audit: InMemoryAuditStore) {}

  async recordLoginAttempt(username: string, ip: string, success: boolean) {
    await this.audit.write({
      operation: 'AUTH_LOGIN',
      actor: username,
      resource: `auth/login`,
      result: success ? 'success' : 'failure',
      severity: success ? 'info' : 'warning',
      details: { ip, userAgent: '...' },
    });
  }

  async detectBruteForce(threshold: number, windowMs: number) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    const failedLogins = await this.audit.query({
      operation: 'AUTH_LOGIN',
      result: 'failure',
      startTime: windowStart,
      endTime: now,
    });

    if (failedLogins.length >= threshold) {
      console.warn(`⚠️  Brute force detected: ${failedLogins.length} failed logins in ${windowMs / 1000}s`);
    }

    return failedLogins;
  }
}
```

### Compliance Export

```typescript
const store = new InMemoryAuditStore();
const exporter = new JsonAuditExporter(store);

// Add some entries
await store.write({ operation: 'DATA_EXPORT', actor: 'admin', resource: 'users.csv', result: 'success', severity: 'info' });
await store.write({ operation: 'USER_DELETE', actor: 'admin', resource: 'users/123', result: 'success', severity: 'warning' });

// Export for compliance
const count = await exporter.exportToFile('/audit/compliance-2026-07-12.json', {
  format: 'json-array',
  filter: { startTime: new Date('2026-07-12'), limit: 1000 },
});
console.log(`Exported ${count} entries`);
```

### Audit Pruning

```typescript
const store = new InMemoryAuditStore();

// Write some entries
await store.write({ operation: 'TEST', actor: 'tester', resource: 'test', result: 'success' });

// Prune entries older than 30 days
const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const pruned = await store.pruneOlderThan(cutoff);

console.log(`Pruned ${pruned} entries`);
console.log(`Remaining: ${await store.count()}`);
```

---

## Testing

```bash
cd packages/audit
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Provides `AuditEntry`, `AuditSeverity`, `ImportExportFormat` types
