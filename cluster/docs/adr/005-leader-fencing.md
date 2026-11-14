# ADR-005: Leader Fencing for Split-Brain Prevention

| Field       | Value                                                   |
|-------------|---------------------------------------------------------|
| **Status**  | accepted                                                |
| **Date**    | 2026-08-02                                              |
| **Author**  | Lambertyan <lambertyan@agentix-e.ai>                    |
| **Supersedes** | —                                                    |
| **Superseded by** | —                                                |

## Context

In distributed consensus, a partitioned leader may believe it is still
active while the rest of the cluster has already elected a new leader.
Without fencing, the stale leader may continue serving reads, accepting
writes, or executing transactions — causing split-brain corruption.

Raft mitigates this via term-based leader election: a leader with a
lower term cannot commit entries because followers will reject its
AppendEntries. However, this only protects _log consistency_, not
_service-level_ operations. A stale leader could still:
- Serve stale reads (pre-commit reads)
- Accept client requests that it can never commit
- Hold locks or resources that the new leader needs

We need **application-level fencing** on top of Raft term enforcement.

## Decision

Implement a **FencingToken** mechanism with these properties:

1. **Monotonically increasing token**: `{ term, leaderId, tokenEpoch }`.
   Each leadership election increments `tokenEpoch`, even within the
   same term (for leader re-election scenarios).

2. **Token gate on every client request**: Every write, read (if
   consistency=linearizable), or transaction carries the fencing token.
   The receiving node validates: `request.tokenEpoch >= node.tokenEpoch`.
   Stale tokens are rejected with `FENCING_ERROR`.

3. **Token propagation**:
   - Leader generates the token on election and attaches it to every
     AppendEntries heartbeat.
   - Followers update their local token from AppendEntries.
   - Clients obtain the token from the leader handshake.

4. **Lock release on fencing**: If a resource lock is held by a stale
   leader, the fencing token on the lock is compared. If the new
   token's epoch is higher, the lock is forcibly released (with audit
   trail).

## Consequences

### Positive

- Eliminates every class of stale-leader split-brain at the application
  level, beyond what Raft term enforcement provides.
- Simple to implement: token is an opaque integer pair, validated at the
  gRPC/transport boundary before any mutation.
- Backwards-compatible: non-fenced clients simply don't include the
  token and are handled by term-based enforcement.

### Negative

- Adds ~2 bytes of overhead per request (varint-encoded epoch).
- Token validation must be thread-safe and atomic (contention on hot
  path). Mitigated by using `Atomics.compareExchange` — single
  instruction.
- Clients must be fencing-aware for linearizable reads. Best-effort
  clients (eventual reads) can skip fencing.

### Undone Work

- Cross-datacenter fencing tokens: tokens are currently cluster-scoped.
  In a multi-datacenter deployment, a global fencing epoch or vector
  clock may be needed.
- Fencing for async operations (outbox, scheduled jobs) — currently
  only enforced for synchronous gRPC requests.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Rely solely on Raft term numbers | Terms only protect log consistency, not application state (locks, leases, client sessions) |
| Lease-based fencing (Chubby-style) | Requires accurate clock synchronization; our target deployments include edge nodes with NTP drift |
| External fencing service (etcd leases) | Adds deployment dependency; violates embeddability goal |
| STONITH (node-level fencing) | Overkill for a software library; hardware fencing requires cloud provider integration we can't assume |

## References

- ADR-004: Joint Consensus
- Ongaro, D. (2014). "Consensus: Bridging Theory and Practice." §8.10: Leader leases.
- `src/consensus/fencing/FencingToken.ts` — implementation
- `src/__tests__/unit/fencing.test.ts` — fence validation tests
