# Architecture

## Position in the framework

The audit package provides **evidence**: a trail that is durable when a write returns, and that can
answer "was anything changed after it was written" with a walk rather than a promise. It is used
cross-cutting by `security` (key rotation, RBAC denials), by deployments, and by any component that has
to record what an operator did.

```
┌──────────────────────────────────────────────────────────────┐
│                     db-node/audit                            │
│                                                              │
│   IAuditStore   write | query | get | count | prune | verify │
│        │                                                     │
│        ├─ FileAuditStore      NDJSON segments, rotation,     │
│        │                      gzip archives, durable writes  │
│        ├─ InMemoryAuditStore  same contract, same chain      │
│        └─ auditChain          the link rule, published       │
│                                                              │
│   IAuditExporter   exportToFile | exportToString             │
│        └─ JsonAuditExporter                                  │
├──────────────────────────────────────────────────────────────┤
│  Dependencies: @agentix-e/db-node/core (types)               │
└──────────────────────────────────────────────────────────────┘
```

## Design principles

1. **An id means durable.** `write()` appends the line, syncs the file, and — once per segment — syncs the
   directory that names it. If any step fails, it **rejects**: a store that acknowledges an entry it could
   not make durable lies about the one thing it exists to record. There is no temporary file and no
   `rename`, because an append-only trail does not need whole-file replacement and a rename per line cost
   1 000× the payload.

2. **An entry links to its predecessor.** `chain: { writer, seq, prev, hash }` is computed over the
   canonical JSON of the entry plus the writer, the sequence and the previous digest of that writer.
   Deleting, editing or inserting a line breaks the chain at that point, and `verify()` names it.

3. **Verification is unbounded; queries are not.** `query()` honours `maxScanLines` because a search
   answers a question about a page. `verify()` reads every segment and archive, because a verification
   capped the same way answers "intact" about the part it happened to look at.

4. **No business logic.** The store is append/query/delete/verify. What to audit and when to prune are
   the caller's decisions.

5. **Export is decoupled.** `IAuditExporter` works with any `IAuditStore`, so JSON, CSV and NDJSON are
   exporters rather than modes of the store.

## The chain, in one diagram

```
entry n-1 (writer W)        entry n (writer W)
┌──────────────────┐        ┌──────────────────────────────┐
│ content …        │        │ content …                    │
│ chain.hash = H₁  │◄───────│ chain.prev = H₁              │
└──────────────────┘        │ chain.seq  = n               │
                            │ chain.hash = H(domain,       │
                            │   canonical(entry), W, n, H₁)│
                            └──────────────────────────────┘
```

Why each part is there:

| Part | Without it |
|---|---|
| `canonicalJson` (sorted keys, every depth) | two writers of the same entry produce two digests, so a re-encode looks like tampering |
| domain separator `db-node/audit/chain/v1` | a digest from another protocol could be substituted for this one |
| `writer` in the pre-image | one writer's chain could be spliced into another's |
| `seq` in the pre-image | a deleted entry whose neighbours were renumbered would verify |
| per-writer chains | two processes appending to one trail would fight over one sequence |

## What verification reports

| Reason | What it means | What an operator does |
|---|---|---|
| `content` | the entry changed after it was sealed | treat the trail as evidence of nothing until the change is explained |
| `link` | `prev` names something that is not the previous entry | look for an insertion or a reordering |
| `sequence-gap` | the sequence skips inside what is present | look for a deletion |
| `unchained` | no link at all — written before this version, or appended by hand | decide the cut-off date for legacy entries |
| `unparsable` | the line is not an entry (includes a torn tail after a crash) | a torn tail is a lost write, not tampering |

A pruned prefix is **not** a failure: retention removes whole segments from the front, so the first
surviving entry of a writer may legitimately name a `prev` that is gone.

## What the chain is not

It is an **unkeyed digest**, not a signature. It detects an edit that was not followed by a recompute of
every subsequent entry; an administrator who can rewrite the file and the chain defeats it. That limit
is stated in the module's own documentation rather than implied away, because the alternative — calling
a checksum "tamper-proof" — is the defect this layer was built to remove.

## Query performance

`InMemoryAuditStore` scans sequentially, O(n). A trail larger than memory is `FileAuditStore`'s job:
`query()` reads the newest segment first, honours `maxScanLines`, and `count()` is a fact rather than a
page.
