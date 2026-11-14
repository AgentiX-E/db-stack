# db-federation — Cross-Cluster Data Federation Layer

**An embeddable, production-grade npm package for multi-datacenter database replication,
CDC, conflict resolution, and anti-entropy reconciliation.**

Package: `@agentix-e/db-federation`  
Version: 0.1.0  
License: MIT

---

## Quick Start

```bash
npm install @agentix-e/db-federation
```

```typescript
import { ExactlyOnceCDCPipeline } from '@agentix-e/db-federation';

// Create a CDC pipeline that guarantees exactly-once delivery
const pipeline = new ExactlyOnceCDCPipeline({
  nodeId: 'dc-east-1',
  cdcConfig: {
    tables: ['orders', 'users'],
    batchSize: 500,
    pollIntervalMs: 100,
  },
  outboxConfig: {
    dataDir: '/data/cdc-outbox',
    maxSizeMB: 1024,
  },
  remoteNodeId: 'dc-west-1',
});

await pipeline.start();

// All changes to 'orders' and 'users' are now replicated
// to dc-west-1 with exactly-once semantics
```

---

## Why db-federation?

Modern applications span multiple datacenters. A single Raft cluster, no matter how
well-tuned, has a fundamental physical limitation: the speed of light. db-federation
solves three problems that a single consensus group cannot:

| Problem | Impact | db-federation Solution |
|---------|--------|----------------------|
| **Write latency across regions** | Raft commit requires majority; cross-Atlantic RTT is ~80ms, cross-Pacific ~180ms | Async outbox replication — local Raft commit in <5ms, async fan-out to other DCs |
| **Durable cross-DC writes** | Network partitions, packet loss, DC outage — writes can be lost | Outbox-before-send pattern: persisted to LMDB before transmission, at-least-once with dedup |
| **Concurrent writes to same data** | Two leaders in different DCs can accept writes to the same key | Configurable conflict resolution: LWW, CRDT merge, or custom resolvers |
| **Catch-up after partition** | Split network heals, data has diverged | Merkle-tree anti-entropy reconciliation with deterministic conflict resolution |

### What db-federation is NOT

- **Not a global consensus protocol.** Each DC runs its own Raft cluster (via `@agentix-e/db-cluster`).
  db-federation coordinates async replication *between* clusters.
- **Not a replication of existing Raft logs.** db-federation operates at the application/outbox level,
  not the Raft log level. This allows storage-engine-agnostic federation.
- **Not a distributed SQL engine.** You don't query "through" db-federation — it's the glue that
  keeps data synchronized across isolated consensus domains.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Your Application                       │
│        (sqlvec-db / graphvec-db / custom clients)         │
├───────────────────────────────────────────────────────────┤
│                  Federation Manager                       │
│      Top-level orchestrator — lifecycle, wiring           │
├─────────────────┬─────────────────┬───────────────────────┤
│ Multi-Leader    │  CDC & Events    │  Anti-Entropy         │
│ Replication     │                  │  (Reconciliation)     │
│                 │                  │                       │
│ ┌─────────────┐ │ ┌─────────────┐  │ ┌─────────────────┐  │
│ │ OutboxStore │ │ │ CDCEngine   │  │ │ MerkleTree Sync │  │
│ │ (LMDB)      │ │ │ CDCManager  │  │ │ Range Partition │  │
│ │ DedupRing   │ │ │ Webhooks    │  │ │ Gap Repair      │  │
│ └─────────────┘ │ └─────────────┘  │ └─────────────────┘  │
├─────────────────┼─────────────────┼───────────────────────┤
│            Conflict Resolution (LWW / CRDT / Custom)      │
├─────────────────┼─────────────────┼───────────────────────┤
│           Transport Layer (TCP/mTLS / InProcess)          │
│           HLC — Hybrid Logical Clock (causal ordering)    │
├─────────────────┴─────────────────┴───────────────────────┤
│              Durability — LMDB Outbox + Checkpoints       │
└───────────────────────────────────────────────────────────┘
```

---

## Core Modules

| Module | Path | Description |
|--------|------|-------------|
| **ExactlyOnceCDCPipeline** | `src/replication/` | Primary CDC pipeline with exactly-once guarantees |
| **CDCEngine** | `src/replication/` | Change data capture engine — table watching, polling |
| **CDCManager** | `src/replication/` | Lifecycle management for multiple CDC streams |
| **OutboxStore** | `src/replication/` | LMDB-backed outbox with batch read/write |
| **DedupRing** | `src/replication/` | In-memory deduplication ring with configurable TTL |
| **MultiLeaderReplication** | `src/replication/` | Multi-leader setup with conflict resolution |
| **ConflictResolver** | `src/replication/` | LWW, CRDT-merge, and custom conflict strategies |
| **AntiEntropy** | `src/replication/` | Merkle-tree based reconciliation and gap repair |
| **InMemoryCDCSink** | `src/replication/` | Test sink for CDC events |

---

## Delivery Guarantees

| Stage | Guarantee | Mechanism |
|-------|-----------|-----------|
| CDC capture | At-least-once | CDCEngine polls source, OutboxStore persists before marking |
| Transport | At-least-once | Outbox-before-send pattern, retry with backoff |
| Delivery | Exactly-once | DedupRing filters duplicates by messageId |
| Crash recovery | No data loss | Checkpoint restores last confirmed LSN, OutboxStore replays unacked |
| End-to-end | Exactly-once | CDCEngine → OutboxStore → Transport → DedupRing → Consumer |

---

## Testing

```bash
npm test    # 363 tests, 29 test files
```

- **29 test files, 363 tests** — unit, integration, batch, performance, chaos
- **CDC exactly-once chaos tests** — crash & restart resilience
- **Cross-repo end-to-end** — db-cluster + db-federation + db-operations integration
- **Stage isolation chaos** — fault injection & latency validation

---

## Design Decisions

See:

- [ADR: Outbox-before-send pattern](docs/adr/outbox-before-send.md)
- [ADR: Exactly-once via DedupRing](docs/adr/exactly-once-dedup.md)
- [ARCHITECTURE.md](docs/architecture.md)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
