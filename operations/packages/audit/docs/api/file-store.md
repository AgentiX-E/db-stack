# The durable file store

`InMemoryAuditStore` is a fixture. `FileAuditStore` is the store a deployment
runs: it writes NDJSON to segment files, rotates them by size and age, compresses
what it rotated, and acknowledges a line only once the line — and, for a new
segment, the directory entry that names it — is on the medium.

This page is the reference for that store and for the two ports it is built on.
The user guide's section on audit retention is the narrative version; this is the
page you keep open while wiring it.

## `FileAuditStore`

```ts
import { FileAuditStore } from "@agentix-e/db-operations-audit";

const store = new FileAuditStore({ dataDir: "/var/lib/db/audit" });
await store.write({ operation: "DROP TABLE", actor: "alice", resource: "orders", result: "success" });
await store.close();
```

| Member | Return | Contract |
|---|---|---|
| `constructor(config)` | — | Creates `dataDir` if absent, reaps half-written archives, repairs segments whose archive and plain file disagree, and adopts the newest open segment instead of naming a new one |
| `write(options)` | `Promise<string>` | Returns the entry id. Resolves when the line is durable, not when it is appended |
| `query(filter)` | `Promise<AuditEntry[]>` | Newest-first within the scan budget; `limit` defaults to `100`, `offset` defaults to `0`. A query is a page |
| `get(id)` | `Promise<AuditEntry \| null>` | Scans the whole trail. Unbounded on purpose: a lookup has one answer, and "not found because it is past a budget" is a lie |
| `count(filter?)` | `Promise<number>` | Every match, whatever the page size. `offset` and `limit` are paging, not selection |
| `pruneOlderThan(timestamp)` | `Promise<number>` | Deletes closed segments last written before `timestamp`; returns how many went. Never deletes the live segment |
| `close()` | `Promise<void>` | Waits for pending compressions and the in-flight flush, then stops |

Three of those rows are the same rule from three directions: **the budget bounds
what a read returns, not what it looks up.** An audit store that cannot find an
entry it holds, or that reports one hundred matches for any filter because the
page size defaults to one hundred, is wrong in the one place wrongness is not
recoverable.

### Acknowledged means durable

`write()` appends immediately and hands its acknowledgement to a group commit.
One file sync covers everything appended to that file *before* the call, so one
sync acknowledges every line written in the same turn — that is what
`DurableFileSystem.syncFile` promises, and it is the only reason batching is
sound.

Two consequences a caller should know:

- A line's bytes may be on disk while its promise is still pending. Closing the
  store waits for the flush.
- A **failed** sync is at-least-once, never at-most-once. The bytes of a rejected
  line stay in the segment — truncating after a failed `fsync` is a second write
  with its own failure mode — so a caller retries with a fresh id.

## `FileAuditStoreConfig`

Only `dataDir` is required. The rest are ports and limits.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dataDir` | `string` | — | Where segments live |
| `maxFileSize` | `number` | 50 MB | Rotate when the active segment reaches this |
| `maxAgeMs` | `number` | 24 h | Rotate when the active segment is this old |
| `retentionDays` | `number` | 90 | Delete rotated segments older than this, swept on rotation |
| `filePrefix` | `string` | `"audit"` | Base name. Quoted before it is used as a pattern, so `billing.v2` does not also match `billingXv2` |
| `maxScanLines` | `number` | 10000 | Lines a `query()` scan reads. Does not bound `get()` or `count()` |
| `segmentReader` | `(path, compressed) => string \| null` | reads and gunzips the local file | Where segment text comes from |
| `fileSystem` | `DurableFileSystem` | `nodeDurableFileSystem` | Where lines go, and what "durable" means there |
| `claim` | `(path) => void` | `O_CREAT \| O_EXCL` | How a segment name is taken exclusively |

The two ports exist for one reason each, and both are about being answerable
rather than convenient:

- `segmentReader` lets a deployment keep segments on another medium (an object
  store, a cold tier) without giving up queries, and lets a caller account for the
  I/O a scan performs — which is the promise `maxScanLines` makes. A reader that
  returns `null` or throws contributes no entries and does not stop the scan.
- `claim` is injectable because the interesting answers are "somebody else has
  that name" and "the name could not be created", and a test runner cannot produce
  either on demand. A store that reports a taken name as a failed disk stops
  rotating under load; a store that reports a failed disk as a taken name spins
  eight times and then accuses its peers.

## `DurableFileSystem`

A durable append is a recipe, not a call: the bytes have to reach the file, the
file's data has to reach the medium, and — for a file that was just created — the
directory entry that names it has to reach the medium too. Any of the three can
fail, and two of them are invisible to every test that only reads the file back
afterwards, because the page cache answers the read either way.

```ts
interface DurableFileSystem {
  append(path: string, data: string): void;
  syncFile(path: string): void;
  syncDirectory(path: string): void;
  needsSeparator(path: string): boolean;
}
```

| Method | Contract |
|---|---|
| `append` | Places all of `data` at the end of `path`, creating it if absent, or throws. Need not be durable when it returns |
| `syncFile` | Returns only once `path`'s data is on the medium, or throws. The data is **everything appended before the call**, not one line — an implementation that synced only the most recent append would make every batch except the last a false claim |
| `syncDirectory` | Returns only once the entries naming files in `path` are on the medium, or throws. Called once per segment, after its first line |
| `needsSeparator` | Whether an append must begin with a newline because the file ends mid-line. One byte read, asked once per segment |

An implementation that returns without doing the work has moved the durability
claim into its own documentation, which is the whole reason this is an interface:
the claim is worth what the caller can assert.

### The default implementation

| Export | Kind | Purpose |
|---|---|---|
| `nodeDurableFileSystem` | `DurableFileSystem` | `createNodeDurableFileSystem()` over the real syscalls. What a deployment uses |
| `createNodeDurableFileSystem(calls?)` | `(NodeFileCalls?) => DurableFileSystem` | The same recipe over a supplied set of syscalls |
| `nodeFileCalls` | `NodeFileCalls` | The six syscalls, named one by one rather than typed as `typeof fs` |
| `NodeFileCalls` | interface | `appendFileSync`, `openSync`, `fsyncSync`, `closeSync`, `fstatSync`, `readSync` |
| `isDirectorySyncUnsupported(error)` | `boolean` | Whether an errno means "this platform cannot sync a directory" (`EISDIR`, `EPERM`, `EINVAL`, `ENOTSUP`) rather than "the sync failed" |

The syscalls are a parameter, and not for the deployment's benefit: the branches
that decide whether a platform limitation is tolerated live in code no Linux
runner can reach. Passing an `ENOTSUP` is how a test asserts that the limitation
is tolerated; passing an `EIO` is how it asserts that a real error propagates.

`nodeFileCalls` is published so that replacing one syscall does not mean
reimplementing the other five. `isDirectorySyncUnsupported` is published so that a
custom implementation classifies the same errno the default one does, instead of
guessing at the difference between "not here" and "your data is at risk".

One deliberate choice worth stating: `syncFile` opens the file for reading **and
writing**. POSIX leaves `fsync` on a descriptor that is not open for writing
implementation-defined — Linux happens to flush, other systems may answer
`EBADF` — and "it works on the machine we tested" is not a durability argument.

## Asserting the order

The order is the only part of crash-safety a test can observe without a crash, so
it is assertable by supplying a recording port:

```ts
const steps: string[] = [];
const recording: DurableFileSystem = {
  append: (path, data) => { steps.push(`append:${data.length}`); },
  syncFile: (path) => { steps.push("syncFile"); },
  syncDirectory: (path) => { steps.push("syncDirectory"); },
  needsSeparator: () => false,
};

const store = new FileAuditStore({ dataDir, fileSystem: recording });
await store.write({ operation: "A", actor: "alice", resource: "t", result: "success" });

// The data reaches the file before the file reaches the medium, and the name
// reaches the medium only once per segment.
expect(steps).toEqual(["append:151", "syncFile", "syncDirectory"]);
```

A port that recorded the calls but was never asked to fail would prove the order
of the happy path and nothing else; the failure cases — a `syncFile` that throws,
a `syncDirectory` that throws, a `claim` that reports a taken name — are the ones
that decide whether an entry is acknowledged when it should not be.

## What the store does not do

- No temporary file, no `rename`, no read-modify-write on the write path. Those
  exist to make a whole-file replacement atomic; an append-only trail does not
  need one, and paying for it per line meant rewriting the segment to add a line.
- No deletion of the active segment, even when it is past retention. It is not a
  rotated file, and removing it would drop entries the window still covers.
- No lease on a shared directory. Two stores may append to one segment (the
  `O_APPEND` write is what makes that safe), and the adoption, twin-repair and
  archive rules are what make a restart a continuation rather than a gap.
