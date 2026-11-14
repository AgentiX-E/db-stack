# Glossary

Terms as they are used **in this stack**. Where a word has a broader meaning elsewhere,
the definition here is the narrower, operative one.

---

## Consensus

**Raft group**
: One consensus unit: a set of nodes replicating one ordered log. Each shard is backed by
  exactly one group. A group tolerates `floor((n-1)/2)` permanent failures.

**Leader / Follower / Learner**
: The leader accepts writes; followers replicate and vote; a learner replicates but does
  not vote, so it can never affect quorum.

**Term**
: A monotonically increasing election epoch. Every message carries its sender's term; a
  node that sees a higher term steps down. Terms are the only ordering authority in Raft —
  wall clocks are never consulted.

**Quorum (majority)**
: `floor(n/2) + 1` nodes. A write is committed once a quorum has appended and fsynced it.

**Commit index / applied index**
: The highest log index known to be committed, and the highest index whose effect is
  visible in the state machine. `applied ≤ commit` always; the gap is backpressure.

**Joint consensus**
: The two-phase membership change from Raft §6. Phase `C_old,new` requires majorities of
  *both* configurations; phase `C_new` requires only the new one. This makes adding or
  removing a node safe: there is no instant at which two disjoint majorities can elect
  two leaders.

**Pre-vote**
: An election prefix that asks "would I win?" without incrementing the term. It prevents a
  partitioned node from disrupting a healthy leader each time it times out.

**Check-quorum**
: A leader that cannot reach a quorum within an election timeout steps down instead of
  continuing to serve reads that may be stale.

**Fencing**
: Revoking a former owner's write access to a shard before granting it to a new owner
  (epoch/token based). Without fencing, a paused-then-resumed process can corrupt a shard
  it no longer owns.

**Leader lease / Read index**
: Two ways to answer a read without writing to the log. A *lease* relies on a bounded
  clock assumption; a *read index* costs one heartbeat round-trip and needs no clock
  assumption. This stack ships both (`LeaseReadManager`, `ReadIndexManager`).

**Log compaction / Snapshot**
: Replacing a prefix of the log with a snapshot of the state machine. `InstallSnapshot`
  streams a snapshot to a follower that has fallen behind the compacted prefix.

---

## Sharding

**Shard**
: A horizontal partition of the keyspace, owned by one Raft group. "Shard" and "group" are
  used interchangeably when the sharding layer is not the topic.

**Resharding**
: Moving a key range from one shard to another. *Online* resharding copies state, replays
  the tail, then flips routing — with no write outage.

**Learner catch-up**
: Adding a non-voting replica and streaming the log (or a snapshot) to it *before*
  promoting it to voter, so the promotion does not stall commits.

---

## Federation

**CDC (change data capture)**
: Reading a database's change stream (`insert`/`update`/`delete` with before/after images)
  instead of polling for differences.

**Outbox**
: A durable queue written in the same order as the changes it describes. Writing to the
  outbox *before* transmitting is what makes cross-DC delivery crash-safe: a process that
  dies after committing locally still has the change on disk.

**At-least-once / effectively-once**
: Delivery is at-least-once because a sender may re-send after a timeout. The *dedup ring*
  remembers recently seen message ids, so each change takes effect once — without claiming
  the transport itself is exactly-once.

**HLC (hybrid logical clock)**
: A `(physical, logical, nodeId)` tuple. It follows wall time when it can and is advanced
  past anything observed, giving causal ordering plus a deterministic total order, without
  trusting clocks for safety.

**LWW (last-write-wins)**
: A conflict strategy: the write with the greater HLC wins. Simple, convergent, and lossy —
  it discards the losing write. Choose it only when a discarded write is acceptable.

**CRDT merge**
: A conflict strategy for data types with a well-defined merge (counters, sets, maps). No
  write is discarded; convergence is guaranteed by the data type, not by the clock.

**Anti-entropy**
: Background reconciliation after a partition. Merkle trees summarise each range; only
  divergent leaves are exchanged. Cost is proportional to divergence, not to data size.

**Split brain**
: Two clusters (or two leaders) both believing they own the same data. Federation detects
  it by comparing cluster identity and topology epochs; consensus prevents it by quorum.

**Topology epoch**
: A monotonically increasing number identifying a cluster's membership view. A peer with a
  stale epoch is rejected rather than merged.

---

## Operations

**Provider registry**
: The dependency-injection seam of `db-operations`: components register implementations
  under typed tokens, so the same code runs against different engines and different
  environments (test, staging, production) without branching.

**Probe**
: A single check with a defined semantics — `liveness` (is the process alive?) versus
  `readiness` (should it receive traffic?). Conflating the two is the most common
  health-check bug.

**SLO / SLI / error budget**
: An SLI is a measured ratio (e.g. successful requests / total); an SLO is the target for
  it; the error budget is `1 - SLO`. The `slacollector` package computes these from
  recorded events rather than from marketing numbers.

**Backup vs PITR**
: A *backup* is a full copy at a point in time. *PITR* (point-in-time recovery) replays
  WAL segments from a backup to an arbitrary timestamp, giving an RPO measured in seconds.

**Rolling upgrade**
: Replacing nodes one at a time, never losing quorum, with a health gate between steps.
  The `rollingupgrade` package owns the sequencing and the abort conditions.

---

## Testing vocabulary used by this project

**Acceptance criterion (AC)**
: A numbered, externally observable statement that a feature must satisfy, e.g.
  *AC-C2: peer traffic uses TLS 1.3 with mutual certificate verification*. Tests cite the
  AC they prove.

**Linearizability (and the fuzzy variant)**
: Linearizability means every operation appears to take effect atomically at some instant
  between its invocation and its response. This project uses a *fuzzy register* check that
  rejects fabricated values (a read returning something never written) while tolerating a
  value that is not visible the instant a write returns — the exact guarantee Raft gives.

**Chaos / nemesis**
: Deliberate fault injection (crash, pause, partition, clock jump) during a workload.
  "Nemesis" is the Jepsen term for the component that inflicts it.

**Boundary suite**
: Tests that push a component to its configured limits (connection storms, log growth,
  mass proposals) and assert the failure mode, not just the happy path.

**Coverage gate**
: A CI check that fails the build unless *each* of lines, statements, functions and
  branches clears its threshold in *every* package. Aggregate coverage cannot hide a
  single uncovered module.

---

## Deployment

**mTLS (mutual TLS)**
: Both peers present and verify certificates. Used for all node-to-node and DC-to-DC
  traffic; a node with the wrong identity cannot complete a handshake, so it cannot join.

**DC (datacenter) / region**
: A failure domain with its own network and power. "Cross-DC" means the link between two
  such domains, which is assumed to be slow and unreliable.

**RPO / RTO**
: Recovery point objective (how much data may be lost) and recovery time objective (how
  long recovery may take). With `quorum` writes, RPO is 0 for node failures; with
  asynchronous federation, cross-DC RPO equals the outbox lag.
