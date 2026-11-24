# Concepts

This page is the mental model. It explains the four kinds of object the stack gives you,
the guarantee each one makes, and the failure it is designed to survive. Terms in
*italics* are defined in the [glossary](glossary.md).

---

## 1. The problem the stack solves

A single database process has three independent weaknesses, and each needs a different
mechanism:

| Weakness | Mechanism in this stack | Package |
|---|---|---|
| The process dies | Replication + leader election over a *consensus group* | `db-cluster` |
| The data outgrows one machine | *Sharding* + online *resharding* | `db-cluster` |
| The region dies | Asynchronous *cross-DC replication* with conflict resolution | `db-federation` |
| Nobody can tell whether any of that is healthy | Engine-agnostic operations interfaces | `db-node` |

The stack does **not** implement a storage engine. It is the middleware between your
engine — anything from SQLite to a bespoke LSM tree — and the cluster/federation/ops
semantics around it.

---

## 2. Consensus: what a Raft group guarantees

A *Raft group* is a set of nodes that agree on an ordered log. One node is the *leader*;
the others are *followers*. A write is applied only after a *majority* (quorum) has
persisted it.

```
        ┌───────────────┐  AppendEntries   ┌───────────────┐
 client │    leader     │─────────────────▶│   follower    │
───────▶│  (node 1)     │─────────────────▶│   (node 3)    │
        │ term 7        │◀──── ack ────────│               │
        │ commit=1042   │◀──── ack ────────└───────────────┘
        └───────┬───────┘
                │ majority reached → commit → apply
                ▼
        application state machine
```

| Guarantee | Precise statement | What it costs |
|---|---|---|
| **Agreement** | Two leaders never commit different entries at the same index | An election needs a round-trip |
| **Durability** | A committed entry is on disk on a majority before the client sees the acknowledgement | One `fsync` per entry per node |
| **Order** | Every replica applies entries in the same order | Apply is single-threaded per group |
| **Liveness** | A group with a majority available elects a leader within a few *election timeouts* | Minority partitions stop accepting writes |

What Raft does **not** give you:

* **Low latency across regions.** A commit needs a majority round-trip. If your majority
  spans an ocean, every write pays that RTT. That is what federation is for.
* **Linearizable reads for free.** A read from a follower is stale until you take a
  *read barrier* or use a *leader lease*.
* **Exactly-once client semantics.** Consensus gives you an ordered log, not a
  de-duplicated one; idempotency is the client's job (the *session manager* helps).

---

## 3. Roles inside a group

| Role | Votes | Receives log | Can serve reads | Typical use |
|---|---|---|---|---|
| Leader | yes | yes | yes, immediately | Writes, read barriers |
| Follower | yes | yes | yes, after a barrier | Read scaling |
| *Learner* | no | yes | yes, after a barrier | Read replicas, cross-region followers that must not affect quorum |

A learner is how you add a replica in another region without letting that region's
network latency (or its outage) affect your write availability.

---

## 4. Sharding: many groups, one cluster

A *shard* is an independent Raft group. Shards do not talk to each other; the routing
layer decides which shard owns a key.

| Strategy | Key → shard | Good for | Weakness |
|---|---|---|---|
| `HashShardStrategy` | `hash(key) % n` | Uniform load with random keys | Range scans span every shard |
| `RangeShardStrategy` | ordered ranges | Range scans, time-series | Hot shard when keys are monotonic |
| `ConsistentHashStrategy` | hash ring with virtual nodes | Membership churn | Needs care to stay balanced |

Resharding is **online**: `OnlineShardMigration` copies a shard's state to the target,
catches up everything written above the version the copy reached, and flips routing
atomically. There is no maintenance window.

The coordinator reads through `IShardMigrationSource` and writes through
`IShardMigrationSink`, so it migrates any engine that can enumerate its entries by
version and count what it holds — the package never imports your engine. It completes
only after asking both sides for their entry counts, which is why a migration that
loses a write reports the two numbers rather than a percentage.

---

## 5. Failure detection, fencing, and the split-brain problem

A node that cannot reach the leader must not accept writes — but a *paused* process
(GC, VM live-migration) does not know it is paused. Three mechanisms work together:

1. **Pre-vote** — a candidate asks whether it *would* win before incrementing its term,
   so a partitioned node cannot disrupt a healthy leader by campaigning repeatedly.
2. **Check-quorum** — a leader that cannot reach a majority steps down instead of
   serving stale writes.
3. **Fencing** — before a new leader takes ownership of a shard, the old owner's access
   to the underlying storage is revoked (epoch/token-based), so a resurrected zombie
   cannot write.

The HA layer (`HAFailoverDetector`, `HAFailoverCoordinator`, `HAConsistencyVerifier`)
automates 1–3 and verifies afterwards that the surviving nodes actually agree.

---

## 6. Federation: why a second consensus group, not a bigger one

```
   DC-East (cluster A)                            DC-West (cluster B)
   ┌───────────────────────┐                      ┌───────────────────────┐
   │  Raft group, 3 nodes  │   TLS 1.3 + mTLS     │  Raft group, 3 nodes  │
   │  commit in ~2 ms      │  ─── outbox ───▶     │  applies remote log   │
   └───────────────────────┘   (async, durable)   └───────────────────────┘
```

* Each DC commits locally with local latency.
* Changes are written to a durable *outbox* **before** transmission, so a crash cannot
  lose them. Delivery is at-least-once; a *dedup ring* turns that into effectively-once.
* Divergent writes are reconciled by a *conflict strategy*: last-write-wins on a
  *hybrid logical clock*, CRDT merge, or a custom resolver you supply.
* After a partition heals, *anti-entropy* compares *Merkle trees* and repairs only the
  divergent ranges.

The cost is explicit: **cross-DC replication is asynchronous**, therefore the two DCs are
eventually consistent with each other. If you need synchronous cross-DC consistency, put
the Raft majority across DCs instead — and accept the latency.

---

## 7. Time, ordering and conflict resolution

Wall clocks lie. The federation layer orders events with a *hybrid logical clock* (HLC):
a tuple of physical time and a logical counter that is advanced past anything it has
seen. HLC gives you:

* **Causality**: if A happened before B, `hlc(A) < hlc(B)`.
* **Bounded skew**: an HLC never drifts more than the configured max offset from physical
  time, so a badly-skewed node cannot poison the ordering forever.
* **Total order for LWW**: ties broken by node id, deterministically.

---

## 8. The engine-agnostic seams

Every layer talks to "a database" through an interface, never a concrete engine:

| Layer | Interface | Your engine implements |
|---|---|---|
| Cluster (state machine) | `IShardReplica` — `apply`, `snapshot(boundaryIndex)`, `restore`, `dataSize` | How a committed command mutates and serialises your data |
| Cluster (storage) | `IWalStorage` — append, truncate, read ranges | Optional: replace SQLite as the Raft log store |
| Federation (change capture) | `ICDCEngine` — `watchTable`, `onChange` | How to read your engine's change stream |
| Federation (delivery) | `IOutboxStore`, `ITransport` | Durable queue and wire transport |
| Operations | provider tokens (`ProviderRegistry`) | Health probes, backup/restore, metrics, auth |

SQLite appears only as the *default reference implementation* of the cluster's log store,
so the stack runs out of the box. Replacing it with your engine is a configuration change,
not a fork. See [engine adapters](user-guide/engine-adapters.md).

---

## 9. Guarantees at a glance

| Scenario | Guarantee | Not guaranteed |
|---|---|---|
| Leader crashes, majority alive | No committed entry is lost; a new leader is elected | Sub-second unavailability (2–3 election timeouts) |
| Majority lost | No new commits; existing data readable if a node survives | Availability |
| Network partition heals | Followers converge to the leader's log | Anything about the *minority* side's uncommitted writes |
| Cross-DC link fails | Both DCs keep accepting local writes; outbox grows | Cross-DC consistency until the link returns |
| Node restarts after crash | The snapshot restores the state machine, then the log tail replays | Nothing — this is the designed recovery path |
| Whole cluster restarts after compaction | Every committed key returns and the cluster accepts writes again (three-process acceptance test) | Nothing beyond the snapshot interval of in-flight, uncommitted work |
| Clock jumps | HLC advances monotonically; Raft ignores wall clocks | Applications that use `Date.now()` for ordering |

---

## 10. Where to read next

* Concrete API by feature: [cluster](user-guide/cluster.md), [federation](user-guide/federation.md), [operations](user-guide/operations.md).
* How the pieces are actually built: [architecture](architecture.md).
* Vocabulary: [glossary](glossary.md).
