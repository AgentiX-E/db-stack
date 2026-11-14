# ADR-002: Transport Layer Architecture — TCP, mTLS, Batched, Shared

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

db-cluster supports multiple deployment modes:
1. **Distributed** — nodes on different machines, communicating over TCP
2. **Single-process multi-group** — multiple RaftGroups within one process, sharing resources
3. **Embedded** — direct in-process transport for testing

A single transport implementation cannot efficiently serve all three.

## Decision

We implemented a **layered transport architecture** with four modes:

| Transport | Use Case | Features |
|-----------|----------|----------|
| `RaftTcpTransport` | Distributed deployment | TCP with optional mTLS, connection pooling |
| `BatchedRaftTransport` | TCP with batching | Wraps RaftTcpTransport, batches messages for throughput |
| `SharedBatchedTransport` | Single-process multi-group | Shared message bus with shard-based routing |
| `InMemoryTransport` | Testing | Direct function call, zero network overhead |

### Key Design Choices

**BatchedRaftTransport** wraps a single `RaftTcpTransport` instance and batches
outgoing Raft messages. This reduces system call overhead and amortizes TCP
connection setup costs. Messages are serialized with `MessageCodec` for
compact wire format.

**SharedBatchedTransport** implements proper request/response matching via
`requestId` and `SharedTransport.onMessage()` dispatch. It routes messages
to the correct RaftGroup by `shardId`, enabling efficient single-process
multi-RaftGroup deployments.

**ConnectionPool** in `RaftTcpTransport` manages persistent TCP connections
with connection-storm resilience — limiting concurrent connection attempts
during cluster startup.

## Consequences

### Positive
- Zero-config switching between modes via constructor parameters
- Batched transport reduces system call overhead by 4-16x
- Shared transport eliminates inter-process communication for multi-group mode
- ConnectionPool prevents thundering herd during cluster initialization

### Negative
- Four transport classes to maintain
- BatchedTransport adds latency vs. direct TCP (acceptable for async messaging)
- SharedTransport requires careful message routing logic

## Alternatives Considered

### gRPC-only transport
- **Pro**: Standardized, multi-language, built-in streaming
- **Con**: Adds protobuf dependency, heavier than raw TCP for Raft messages
- **Verdict**: Rejected — Raft messages are small and frequent, raw TCP with codec is more efficient

### WebSocket transport
- **Pro**: Browser-compatible, firewall-friendly
- **Con**: Not needed for server-side database deployments, adds framing overhead
- **Verdict**: Not implemented yet — could be added as a fifth transport mode

## References
- [ADR-001: Why @maboke123/raft-core](001-raft-core.md)
- Transport implementations: `src/consensus/transport/`
