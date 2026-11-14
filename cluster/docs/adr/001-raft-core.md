# ADR-001: Use @maboke123/raft-core as the Consensus Engine

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

db-cluster needs a production-grade Raft consensus implementation for
replicated state machines. We evaluated three approaches:

1. **Write our own Raft implementation** — Full control, maximum engineering cost
2. **Use @maboke123/raft-core** — TypeScript-native, gRPC-capable, battle-tested in npm ecosystem
3. **Use etcd/raft (Go) via RPC bridge** — Mature but adds language boundary and RPC overhead

## Decision

We chose **@maboke123/raft-core** as the consensus engine, wrapping it in
`RaftAdapter` to provide:
- Transport independence (TCP, SharedTransport, InProcess)
- SQLite-backed durable storage via `SqliteNodeStorage`
- Concurrency limiting via propose-and-wait semaphore
- Snapshot management and log compaction
- Joint consensus membership changes

## Consequences

### Positive
- Pure TypeScript — no language boundary, no FFI, no serialization overhead
- npm-native — embeddable in any Node.js project
- Production features: gRPC transport, disk storage, snapshots, membership changes
- Event-driven architecture with proper Session tracking
- Well-defined public API with TypeScript types

### Negative
- Dependency risk — we don't own the consensus core
- Must adapt to the library's log format and wire protocol
- Upgrade coordination required when raft-core releases breaking changes
- Some features (EventBus, Session, TimingClock) require adapter bridging

### Mitigations
- `RaftAdapter` isolates our code from raft-core changes
- `SqliteNodeStorage` translates our storage format to raft-core's expectations
- `BatchedRaftTransport` and `SharedBatchedTransport` wrap the transport layer
- Pin to specific version, test upgrades before adopting new raft-core releases

## Alternatives Considered

### Self-implemented Raft
- **Pro**: Full control, no dependency risk
- **Con**: 6-12 months of engineering effort, endless edge cases
- **Verdict**: Rejected — raft-core already provides production-quality Raft

### etcd/raft via RPC
- **Pro**: Battle-tested by Kubernetes, Jepsen-verified
- **Con**: Go/TypeScript boundary, RPC overhead (~1ms per proposal), complex deployment
- **Verdict**: Rejected — adds deployment complexity for an embeddable npm package

## References
- [@maboke123/raft-core on npm](https://www.npmjs.com/package/@maboke123/raft-core)
- [Raft Extended Paper §6](https://raft.github.io/raft.pdf) — Joint Consensus, Membership Changes
