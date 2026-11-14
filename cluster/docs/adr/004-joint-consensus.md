# ADR-004: Joint Consensus for Safe Membership Changes

| Field       | Value                                                   |
|-------------|---------------------------------------------------------|
| **Status**  | accepted                                                |
| **Date**    | 2026-08-02                                              |
| **Author**  | Lambertyan <lambertyan@agentix-e.ai>                    |
| **Supersedes** | ADR-001 (extends raft-core with joint consensus)     |
| **Superseded by** | —                                                |

## Context

Single-phase membership changes (add/remove one node at a time) are safe
in Raft, but any change that modifies the quorum size can create a
split-brain window where two majorities exist simultaneously. Operations
that change cluster topology (adding multiple nodes, removing multiple
nodes, or reconfiguring shard assignments) require stronger guarantees.

We evaluated two approaches:
1. **One-at-a-time** — always change one node, wait for commit, repeat.
   Safe but slow for multi-node operations (e.g., adding 3 nodes
   requires 3 sequential raft log entries).
2. **Joint consensus** — enter transitional configuration where entries
   must be committed by both old and new majorities. Once the joint
   entry commits, transition to the new config.

## Decision

Implement **joint consensus via `RaftJointConsensusEngine`** extending
the core Raft implementation with:

- **`JointConfig` entry type**: A log entry that contains both C_old and
  C_new configurations. While in joint consensus, decisions require
  majority in both configurations.
- **Two-phase commitment**:
  1. Leader proposes `JointConfig {C_old, C_new}` — requires quorum
     from old config to commit.
  2. Once committed, nodes apply both configs concurrently for all
     subsequent entries.
  3. Leader proposes final `Config {C_new}` — only needs new config
     quorum to commit (old config no longer blocks).
- **Safety invariant**: During joint consensus, any committed entry has
  been replicated to a majority of both C_old and C_new. No two leaders
  can be elected with conflicting views.
- **Fencing token**: Each configuration change increments a monotonically
  increasing `configIndex`. Stale leaders are rejected if their
  configIndex is behind.

## Consequences

### Positive

- Zero-downtime membership changes: can add/remove arbitrary nodes in a
  single operation without availability loss.
- Eliminates split-brain risk entirely during reconfiguration.
- Backwards-compatible: single-node changes still work with standard
  Raft semantics.

### Negative

- Joint phase doubles the quorum requirement, increasing latency during
  the transitional window (typically one or two heartbeat intervals).
- Complexity: `RaftJointConsensusEngine` adds ~400 lines of state
  machine logic that must be tested exhaustively for edge cases
  (simultaneous config changes, leader step-down during joint phase,
  snapshot compression of joint entries).

### Undone Work

- Automatic joint consensus rollback if the joint phase fails (currently
  requires operator intervention to abort the change).
- Joint consensus across shard boundaries (shard-level vs cluster-level
  configs tracked separately).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| One-at-a-time (add/remove single node) | Too slow for multi-node ops; no protection against concurrent membership changes from different cluster operators |
| External coordination (etcd/ZooKeeper) | Adds dependency on external system; defeats embeddability goal |
| No formal joint consensus — manual operator sequencing | Error-prone at scale; requires operator discipline that isn't enforceable |

## References

- ADR-001: Raft Core Implementation
- ADR-002: Transport Layer
- Ongaro, D., & Ousterhout, J. (2014). "In Search of an Understandable Consensus Algorithm." §6: Cluster membership changes.
- `src/consensus/joint-consensus/RaftJointConsensusEngine.ts` — implementation
- `src/__tests__/unit/raft-joint-consensus.test.ts` — 52 tests, all passing
