# db-cluster Architecture

> Last updated: 2026-07-09 · Test coverage: 43 files, 391 tests, 0 failures

---

## 1. Overall Architecture (Component Diagram)

```
┌──────────────────────────────────────────────────────────────────┐
│                       Application Layer                          │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────┐           │
│  │ RaftClient   │  │ ShardReplica  │  │ OutboxWriter │           │
│  └──────┬──────┘  └───────┬───────┘  └──────┬───────┘           │
└─────────┼──────────────────┼──────────────────┼──────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Consensus Layer                                │
│                                                                  │
│  ┌─────────────────┐     ┌──────────────────┐                    │
│  │ RaftGroupManager │────▶│  RaftGroup       │                    │
│  │ (1935 lines)     │     │  (1813 lines)    │                    │
│  │ orchestrator     │     │  per-shard       │                    │
│  └────────┬────────┘     └────────┬─────────┘                    │
│           │                       │                              │
│           ▼                       ▼                              │
│  ┌─────────────────┐     ┌──────────────────┐                    │
│  │ RaftAdapter      │────▶│ RaftNode          │                    │
│  │ (774 lines)      │     │ (@maboke123/      │                    │
│  │ wrapper + init   │     │  raft-core)       │                    │
│  └────────┬────────┘     └──────────────────┘                    │
│           │                                                      │
│           ▼                                                      │
│  ┌──────────────────────────────────────────┐                    │
│  │           Transport Layer                  │                    │
│  │                                            │                    │
│  │  ┌────────────┐  ┌──────────────────┐     │                    │
│  │  │ NodeTransport│  │ BatchedRaftTransp │     │                    │
│  │  │ shared      │  │ batch + shard     │     │                    │
│  │  └──────┬─────┘  └────────┬─────────┘     │                    │
│  │         │                 │                │                    │
│  │         ▼                 ▼                │                    │
│  │  ┌──────────────────────────────────┐     │                    │
│  │  │    RaftTcpTransport (619 lines)   │     │                    │
│  │  │    TLS server + client           │     │                    │
│  │  └──────────────┬───────────────────┘     │                    │
│  │                 │                          │                    │
│  │                 ▼                          │                    │
│  │  ┌──────────────────────────────────┐     │                    │
│  │  │ ConnectionPool (1206 lines)       │     │                    │
│  │  │ PeerConnection + circuit breaker  │     │                    │
│  │  │ frame encode/decode + retry queue  │     │                    │
│  │  └──────────────────────────────────┘     │                    │
│  └──────────────────────────────────────────┘                    │
│                                                                  │
│  ┌──────────────────────────────────────────┐                    │
│  │           Storage Layer                    │                    │
│  │  ┌──────────────┐  ┌──────────────────┐   │                    │
│  │  │ SqliteStorage  │  │ SqliteNodeStorage│   │                    │
│  │  │ (907 lines)    │  │ (340 lines)      │   │                    │
│  │  │ raw SQLite     │  │ @raft-core       │   │                    │
│  │  └──────────────┘  │  NodeStorage impl  │   │                    │
│  │                    └──────────────────┘   │                    │
│  │  ┌──────────────┐  ┌──────────────────┐   │                    │
│  │  │ ShardStateMach│  │ FencingManager   │   │                    │
│  │  │ (89 lines)    │  │ (414 lines)      │   │                    │
│  └──────────────────────────────────────────┘                    │
│                                                                  │
│  ┌──────────────────────────────────────────┐                    │
│  │           Extensions                      │                    │
│  │  ┌────────────────┐ ┌─────────────────┐  │                    │
│  │  │ InstallSnapshot  │ │ LeaderTransfer   │  │                    │
│  │  │ Handler (420)   │ │ Handler (238)    │  │                    │
│  │  └────────────────┘ └─────────────────┘  │                    │
│  │  ┌────────────────┐ ┌─────────────────┐  │                    │
│  │  │ Replication     │ │ ReadIndexHandler│  │                    │
│  │  │ Pipeline (350)  │ │ (248 lines)     │  │                    │
│  │  └────────────────┘ └─────────────────┘  │                    │
│  │  ┌────────────────┐ ┌─────────────────┐  │                    │
│  │  │ PreVoteHandler   │ │ CheckQuorumHndlr│  │                    │
│  │  │ (273 lines)    │ │ (261 lines)     │  │                    │
│  │  └────────────────┘ └─────────────────┘  │                    │
│  └──────────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow

### 2.1 Propose Path

```
Client → RaftClient.propose()
    │
    ▼
RaftGroup.propose(data)
    │
    ▼
RaftAdapter.propose(data)
    │
    ▼
@maboke123/raft-core RaftNode.propose()
    │
    ├── ▶ Local: Append to WAL → SqliteNodeStorage
    │
    └── ▶ Broadcast: step() output messages
              │
              ▼
        RaftAdapter → RaftGroup → NodeTransport.send()
              │
              ▼
        RaftTcpTransport.send(fromId, msgs[])
              │
              ├── ▶ MessageCodec.encode() → JSON frame
              │
              ├── ▶ _sendFrame() → compress (optional)
              │
              └── ▶ _doSendFrame() → ConnectionPool.sendTo()
                        │
                        ├── ▶ tryGetConnection() → PeerConnection.write()
                        │          │
                        │          └── ▶ encodeFrame() → [4-byte len][payload]
                        │
                        └── ▶ (no connection) → _pendingMessages[]
                                + _initiateConnection() → getConnection()
```

### 2.2 Receive Path

```
TLS socket secureConnection
    │
    ▼
RaftTcpTransport._handleIncoming(socket)
    │
    ├── ▶ cert CN validation (raft-node-{id})
    │
    └── ▶ ConnectionPool.onIncoming(peerId, socket)
              │
              ▼
        PeerConnection.on('data')
              │
              ▼
        RaftTcpTransport._processData(peerId, data)
              │
              ├── ▶ Buffer accumulation (handles partial frames)
              │
              ├── ▶ decodeFrame() → [4-byte len][payload]
              │
              ├── ▶ MessageCodec.decode() → RaftMessage
              │
              └── ▶ emit('message', msg, peerId)
                        │
                        ▼
                  RaftGroup.onMessage(msg)
                        │
                        ▼
                  @maboke123/raft-core step(msg)
                        │
                        ▼
                  RaftAdapter.applyHandler → ShardStateMachine
```

### 2.3 Heartbeat Path

```
Leader RaftNode (every heartbeatTick interval)
    │
    ├── ▶ step() → MsgHeartbeat (msgType=8)
    │
    └── ▶ RaftTcpTransport.send(fromId, [heartbeat_msgs])
              │
              ├── ▶ _sendFrame() → isHeartbeat=true
              │
              └── ▶ _doSendFrame()
                        ├── ▶ connected → write (fast path)
                        └── ▶ not connected → drop (idempotent)

Follower receives MsgHeartbeat
    │
    ├── ▶ _processData() → decode → emit('message')
    │
    ├── ▶ RaftGroup.onMessage() → step() → reset election timer
    │
    └── ▶ emit('heartbeat', { from: peerId })
```

### 2.4 Connection Lifecycle

```
START
  │
  ▼
TCP LISTEN (port bind)
  │
  ├── ▶ incoming: _handleIncoming → onIncoming
  │       │
  │       └── ▶ PeerConnection (EventEmitter)
  │               │
  │               ├── on('data') → _processData
  │               └── on('close') → _onDisconnect → _scheduleRetry
  │
  └── ▶ outgoing: _initiateConnection → pool.getConnection()
          │
          ├── ▶ TLS handshake (mTLS, TLSv1.3)
          │
          └── ▶ PeerConnection + onConnectionCreated callback
                  │
                  ├── ▶ clear stale buffer → register data listener
                  └── ▶ flush _pendingMessages

DISCONNECT
  │
  ├── ▶ PeerConnection.close() → emit('close')
  │
  ├── ▶ ConnectionPool._onDisconnect(peerId)
  │
  ├── ▶ CircuitBreaker.recordFailure()
  │
  └── ▶ _scheduleRetry(peerId, backoff)

RECONNECT (health check at 500ms interval + on send)
  │
  ├── ▶ tryGetConnection() → null → _initiateConnection()
  │
  └── ▶ pool.getConnection() → repeat TLS handshake

STOP
  │
  ├── ▶ clearInterval(healthCheckTimer)
  ├── ▶ ConnectionPool.stop()
  │       ├── ▶ clear all retry timers
  │       ├── ▶ close all connections
  │       └── ▶ shutdown circuit breakers
  └── ▶ TLS server.close()
```

---

## 3. Error State Machine

### 3.1 ConnectionPool Error States

```
┌──────────┐     retry     ┌──────────┐     retry     ┌──────────┐
│  Active   │──────────────▶│ Backoff   │──────────────▶│  Circuit  │
│ connected │   failure     │ exp incr  │   threshold  │  Broken   │
│   write   │              │ timer set │   exceeded   │  (open)   │
└────┬─────┘              └──────────┘              └─────┬────┘
     │                                                     │
     │ close()                                              │ resetTimeout
     ▼                                                     ▼
┌──────────┐                                           ┌──────────┐
│ Disposed │                                           │  Half-   │
│ destroyed │                                          │  Open     │
└──────────┘                                           └────┬─────┘
     ▲                                                     │
     │                                                     │ probe success
     │                                                     ▼
     │                                                  ┌──────────┐
     └──────────────────────────────────────────────────│  Active   │
                                                        │ (retry   │
                                                        │  reset)  │
                                                        └──────────┘

Events emitted:
  - 'close'        → PeerConnection destroyed
  - 'connection-lost' → write failure detected
  - 'connect-error'   → TLS handshake failed
  - 'decode-error'    → frame parsing failed (invalid JSON, truncation)
```

### 3.2 RaftAdapter Error Paths

```
Before init:
  propose()           → throw "not initialized"
  stopHeartbeat()     → throw "not initialized"
  transferLeadership()→ throw "not initialized"
  campaign()          → no-op (returns undefined)
  getTerm()           → 0
  getLeader()         → null
  getProgress()       → {}
  getAppliedIndex()   → 0
  getCommitIndex()    → 0
  compactLogs()       → no-op
  readBarrier()       → no-op
  isLeader()          → false

After init:
  propose()           → reject if node refused entry (leader lost)
  proposeAndWait()    → reject if commit timeout
  transferLeadership()→ reject if not current leader
  compactLogs()       → reject if snapshot write fails

Error types (SqlVecError):
  SqlVecErrorCode.RAFT_NOT_LEADER      → client redirect to new leader
  SqlVecErrorCode.RAFT_PROPOSE_TIMEOUT  → retry with backoff
  SqlVecErrorCode.RAFT_ADAPTER_INVALID  → node not initialized
  SqlVecErrorCode.RAFT_PIPELINE_OVERFLOW → too many in-flight entries
```

### 3.3 TLS Connection Security

```
Incoming socket:
  socket.authorized === false      → destroy() [CA validation failed]
  cert.subject.CN is null         → destroy() [no identity]
  CN doesn't match raft-node-{id} → destroy() [unexpected peer]
  pool.onIncoming returns null    → destroy() [pool rejected]
  ✓ all checks pass               → register + data listener

Outgoing socket (in PeerConnection._onConnect):
  TLSSocket emits 'connect'
  socket.authorized === false      → close() + retry
  ✓ authorized                     → set _connected = true
```

### 3.4 Frame Decode Errors

```
decodeFrame() errors (handled in _processData):
  ┌──────────────────────────────────────┐
  │ accumulated < 4 bytes                │→ wait for more data
  │ payloadLen > maxFrameSize (32MB)     │→ reject (emit decode-error)
  │ accumulated < 4 + payloadLen         │→ wait for more data
  │ MessageCodec.decode() throws (JSON)  │→ emit decode-error
  └──────────────────────────────────────┘
```

---

## 4. Core Data Structures

### 4.1 Wire Format (Frame)

```
[4-byte BE uint32: payload length][payload bytes]
            │                              │
            └── header (big-endian)        └── body (JSON → compressed)

Write path:     RaftMessage → MessageCodec.encode() → Buffer
                → _sendFrame → compress → encodeFrame() → [len][compressed]
Read path:      socket data → decodeFrame() → [len][compressed]
                → _processData → decompress → MessageCodec.decode()
```

### 4.2 ConnectionPool Internals

```
ConnectionPool:
  _connections: Map<peerId, PeerConnection>    // active outgoing connections
  _incoming: Map<peerId, PeerConnection>       // connections from incoming
  _pending: Map<peerId, PendingMessage[]>      // queued messages (max 1024)
  _retryAttempts: Map<peerId, number>          // retry count per peer
  _retryTimers: Map<peerId, NodeJS.Timeout>    // retry timers
  _connecting: Set<peerId>                     // peers in TLS handshake
  _circuitBreakers: Map<peerId, CBWrapper>     // per-peer circuit breaker
  _stopped: boolean                            // lifecycle flag
```

### 4.3 RaftMessage (JSON)

```typescript
{
  msgType: number;      // 0=Heartbeat, 1=Append, 2=Vote, 3=PreVote, ...
  from: string;         // "1" (node id)
  to: string;           // "2"
  term: string;         // "1" (u64 as string)
  entries?: RaftEntry[]; // [{ index: "1", term: "1",
                         //   data: base64, entryType: number }]
  commit?: string;      // "1"
  commitGroup?: string; // "1"
  commitBroadcast?: string; // "1"
  vote?: string;        // "1"
  reject?: boolean;
  rejectHint?: string;
  readState?: { ... };
  context?: Uint8Array;
}
```

---

## 5. Test Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Test Suite (437 tests, 45 files)                │
│                                                                     │
│  ┌─ Unit Tests ────────────────────────────────────────┐            │
│  │  SqliteStorage (10)     RaftGroupManager (10)       │            │
│  │  ConnectionPool (9)     RaftTcpTransport (13)       │            │
│  │  RaftAdapter (24)       MessageCodec (X)            │            │
│  │  BatchedRaftTransport   FlexQuorumRouter            │            │
│  │  CircuitBreaker         RowLockManager              │            │
│  │  PipelineTransport      53 more unit test files     │            │
│  └─────────────────────────────────────────────────────┘            │
│                                                                     │
│  ┌─ Integration Tests ────────────────────────────────┐            │
│  │  RaftGroup integration (10)                        │            │
│  │  HA e2e (multi-node failover)                      │            │
│  │  Raft multishard (cross-shard consensus)           │            │
│  │  Raft stress (write-heavy, 3 nodes)                │            │
│  │  Raft core (basic lifecycle, election)             │            │
│  └─────────────────────────────────────────────────────┘            │
│                                                                     │
│  ┌─ Performance / Chaos ─────────────────────────────┐            │
│  │  Raft throughput benchmark                        │            │
│  │  Raft chaos: network partition + leader failure   │            │
│  │  Raft latency: tail latency under load            │            │
│  │  Raft snapshot: install + recovery                │            │
│  │  Raft membership: add/remove node                  │            │
│  └─────────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Key Design Decisions

| # | Decision | Rationale |
|---|------|------|
| D1 | ConnectionPool pending queue limit of 1024 messages | Prevents OOM, heartbeats can be safely dropped |
| D2 | Message compression (CompressionConfig, default threshold=1024) | Reduces bandwidth, but small messages (heartbeats) skip compression |
| D3 | Per-peer independent CircuitBreaker (opossum) | A single peer failure does not affect other peers |
| D4 | Health check at 500ms interval | Balances detection latency and overhead, heartbeat at 100ms, recovers within 5 ticks |
| D5 | TLSv1.3 mandatory mTLS | Security baseline, prevents MITM attacks |
| D6 | `tryGetConnection()` synchronous, non-blocking | Cannot block within the WASM queue |
| D7 | `onIncoming` prefers first established connection | Avoids duplicate connections when two peers connect simultaneously |
| D8 | `_pendingMessages` flushed in `onConnectionCreated` | Ensures critical messages are not lost when connection becomes ready |
| D9 | Frame format: [4-byte BE][payload] | Simple, reliable, no sticking packet issues |
