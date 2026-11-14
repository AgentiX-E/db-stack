# db-federation Architecture

## 1. System Overview

db-federation is the cross-cluster data federation layer for the Agentix-E database ecosystem. It coordinates multi-leader replication, change data capture, causal consistency, and conflict resolution across **independent Raft consensus domains** (individual db-cluster instances).

### The Core Problem

A single Raft cluster's write latency is bounded by `2 × RTT_majority`. For a 3-node cluster spanning us-west-1, eu-west-1, and ap-southeast-1, typical commit latency is 150–400ms — unacceptable for latency-sensitive applications.

db-federation's approach: **each datacenter runs its own Raft cluster** (fast local commits, <5ms), and federation coordinates async replication between clusters. This trades strict global linearizability for **causal consistency + bounded staleness** — the standard for geo-distributed systems (CRDTs, DynamoDB global tables, Cassandra).

### Scope & Boundaries

```
┌────────────────────────────────────────────────────────────────┐
│                        db-federation                           │
│  Coordinates cross-cluster replication only.                   │
│  Does NOT:                                                     │
│    × Replace local Raft consensus                              │
│    × Touch Raft logs directly                                  │
│    × Own storage engine or query path                          │
│    × Provide distributed transactions                          │
│    × Implement global linearizability                          │
├────────────────────────────────────────────────────────────────┤
│  Depends on: local DB cluster for commit + apply;              │
│  IFederationConsumer interface for integration.                │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Module Architecture

### 2.1 Module Dependency Graph

```
FederationManager
  ├── MultiLeaderReplication
  │     ├── OutboxStore (LMDB)
  │     ├── DedupRing
  │     └── Transport (via FederationManager)
  ├── CDCEngine + CDCManager
  │     └── Transport (for webhook delivery)
  ├── AntiEntropy
  │     └── Transport (for Merkle sync)
  ├── ConflictResolver
  ├── HLC
  └── TopologyManager
        └── HealthMonitor
```

Each module has a clear single responsibility. No circular dependencies. All external communication goes through `ITransport`.

### 2.2 Module Responsibilities (Detailed)

#### FederationManager
**File**: `src/core/FederationManager.ts` (164 lines)

The top-level orchestrator. Not a god class — its only job is wiring lifecycle and providing accessors.

```typescript
class FederationManager {
  // Lifecycle — owns start/stop ordering
  async start(): Promise<void>
  async stop(): Promise<void>

  // Accessors — returns references to sub-modules
  getReplication():    IMultiLeaderReplication
  getCDC():            ICDCManager
  getAntiEntropy():    IAntiEntropy
  getHealth():         FederationHealth

  // Consumer management
  registerConsumer(consumer: IFederationConsumer): void
}
```

Start sequence:
1. Start transport (accept connections)
2. Start replication engine (begin outbox polling)
3. Start CDC (if enabled)
4. Start anti-entropy (if enabled)
5. Register consumers (wire up propose callbacks)

Stop sequence (reverse):
1. Unfreeze and drain outbox
2. Stop anti-entropy
3. Stop CDC
4. Stop replication
5. Stop transport

#### MultiLeaderReplication
**File**: `src/replication/MultiLeaderReplication.ts`

The core of cross-DC write replication. Uses a **per-target OutboxWorker** pattern:

```
MultiLeaderReplication
  ├── OutboxStore (shared, LMDB-backed)
  ├── DedupRing (shared, for inbound dedup)
  └── Map<targetNodeId, OutboxWorker>
        └── OutboxWorker
              ├── poll tick (configurable, default 100ms)
              ├── batch entries (max configurable, default 100)
              ├── send via Transport.send()
              ├── success → markDelivered()
              ├── failure → markFailed() + backoff
              └── retryCount ≥ max → deadLetter()
```

OutboxWorker behavior per tick:

```typescript
async tick(): Promise<void> {
  if (this._frozen) return;                    // partition freeze
  if (this._backoffUntil > Date.now()) return; // still in backoff

  const entries = await this._store.fetchOldestPending(this._targetId, this._batchSize);
  if (entries.length === 0) return;

  try {
    await this._transport.broadcast(entries);
    for (const entry of entries) {
      await this._store.markDelivered(entry.msgId);
    }
    this._resetBackoff(); // success → reset to initial interval
  } catch (err) {
    for (const entry of entries) {
      const failed = await this._store.markFailed(entry.msgId);
      if (failed) this._incrementBackoff();
      // failed → send to dead letter
    }
  }
}
```

#### OutboxStore
**File**: `src/storage/OutboxStore.ts`

Durable queue backed by LMDB. Every entry is persisted to disk before `add()` returns — crash safety guarantee.

**Database layout in LMDB:**

```
outbox:{targetPeerId}:pending    → ordered map: msgId → entry (serialized)
outbox:{targetPeerId}:dead-letter → ordered map: msgId → entry
outbox:stats                      → { totalSent, totalDeduped, totalDeadLetter }
```

**Entry schema:**

```typescript
interface OutboxEntry {
  msgId: string;          // UUID v4
  targetPeerId: string;   // routing target
  sourceDc: string;       // which DC produced this
  shardId: string;        // logical shard
  dataType: string;       // 'insert' | 'update' | 'delete'
  payload: Uint8Array;    // msgpack-encoded data
  hlcTimestamp: Uint8Array; // HLC serialized as 8-byte hex
  raftIndex: number;      // gating Raft commit index
  retryCount: number;     // starts at 0
  createdAt: number;      // epoch ms
}
```

**State transitions:**

```
PENDING ──[first send]──→ IN_FLIGHT ──[ACK]──→ DELIVERED
    ▲                        │
    │                        └──[timeout/NAK]──→ PENDING (retryCount++)
    │                                              │
    │                                              └──[retryCount ≥ max]──→ DEAD_LETTER
    │                                                                         │
    └──────────────────────[manual retry]─────────────────────────────────────┘
```

#### DedupRing
**File**: `src/replication/DedupRing.ts`

In-flight message deduplication. Uses a ring buffer of message IDs with TTL-based eviction. At-least-once delivery without duplicate application.

```typescript
class DedupRing {
  // O(1) check + add
  tryAdd(msgId: string): boolean  // returns false if already seen

  // O(1) eviction (lazy — evicted entries are naturally forgotten)
  // Eviction is time-based: entries older than TTL (default 5min) are dropped

  getStats(): { totalSeen: number; totalDeduped: number }
}
```

TTL is generous (5 minutes) to handle long-lived retries. Memory bounded by `max entries = (max throughput × TTL_seconds)` — at 1000 msg/s, ~300K entries (~24MB for UUIDs).

#### ConflictResolver
**File**: `src/replication/ConflictResolver.ts`

Pluggable conflict resolution engine. Each table or key space can register its own strategy.

```typescript
interface IConflictResolver {
  resolve(conflict: ConflictEntry): ResolvedEntry;
}

type ConflictStrategy = 'lww' | 'crdt-counter' | 'crdt-set' | 'crdt-map' | 'custom';
```

**LWW strategy:**

```typescript
resolve(a, b):
  if a.hlc > b.hlc → a wins       // HLC comparison (wall+logical)
  if a.hlc < b.hlc → b wins
  if a.nodeId > b.nodeId → a wins  // deterministic tiebreak
  else → b wins
```

**CRDT Counter (PN-Counter):**

```typescript
resolve(a, b):
  // Each entry carries per-node deltas
  // Final value = sum(all positive deltas) - sum(all negative deltas)
  // Concurrent increments are commutative: a.merge(b) = b.merge(a)
  return { value: a.positives.merge(b.positives).value - a.negatives.merge(b.negatives).value }
```

**CRDT Set (OR-Set):**

```typescript
resolve(a, b):
  // Elements have unique tags (element + nodeId + timestamp)
  // Add: insert element with new tag
  // Remove: add tag to tombstone set
  // Observed-remove: if element's latest tag is in tombstone, it's removed
  // Concurrent add after remove → add wins (unobserved remove)
  return { elements: a.observedMerge(b) }
```

#### CDC (Change Data Capture)
**Files**: `src/replication/CDCEngine.ts`, `src/replication/CDCManager.ts`

Two-tier design separates concerns:

```
CDCEngine (data source layer)
  ├── watchTable('orders')          // subscribe to table
  ├── unwatchTable('orders')
  ├── onChange(cb)                  // raw change events
  └── start() / stop()

CDCManager (publication/subscription layer)
  ├── createPublication('pub1', ['orders', 'users'])
  ├── createSubscription('sub1', 'pub1', webhookUrl)
  ├── onChange(event)               // match → dispatch
  │     ├── Webhook POST
  │     └── Outbox re-enter (for further replication)
  └── start() / stop()
```

Events carry HLC timestamps:

```typescript
interface CDCChangeEvent {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  hlc: Uint8Array;
  sourceDc: string;
  sourceNodeId: string;
  sequence: number;     // monotonically increasing per table
}
```

#### AntiEntropy
**File**: `src/replication/AntiEntropy.ts`

Periodic Merkle-tree reconciliation for eventual consistency guarantees.

**Algorithm:**

```
1. Build Merkle tree from local data (SHA-256 hashes of key-value pairs)
   ├─ depth: configurable (default 8), determines precision vs. cost
   └─ leaf: hash(key + value), internal: hash(left_child + right_child)
       └─ binary-split partitioning for range-partitioned data

2. Exchange root hash with peer

3. If root hashes differ:
   ├─ Walk tree: compare sub-range hashes
   ├─ Binary search to find minimal divergent ranges
   └─ Exchange full data for divergent ranges

4. Apply received entries through ConflictResolver

5. Repeat for each shard
```

Each Merkle tree is per-shard. The tree is not persisted — rebuilt from data on each sync cycle (or cached between cycles with TTL).

#### HLC (Hybrid Logical Clock)
**File**: `src/hlc/HLC.ts`

Pure implementation. No external dependencies. Provides causal ordering.

```typescript
class HLC {
  constructor(wallClock?: IWallClock)  // default: Date.now

  now(): HLCTimestamp                   // returns (wall, logical) pair
  observe(ts: HLCTimestamp): void       // advance past remote
  compare(a: HLCTimestamp, b): number   // -1, 0, +1
  reset(): void                         // reset for testing
}
```

**Serialization format** (`hlcToKey` / `keyToHlc`):

```
| wall: 8 bytes big-endian uint64 | logical: 4 bytes big-endian uint32 | nodeId: hex(1-16 bytes) |
```

This format guarantees lexicographic sort order matches HLC causal order — critical for LMDB key ordering and range queries.

**Wall clock drift handling:**

```typescript
now():
  currentWall = wallClock()
  if currentWall > this.wall:
    this.wall = currentWall
    this.logical = 0
  else:
    this.logical++

observe(remote):
  if remote.wall > this.wall:
    this.wall = remote.wall
    this.logical = 0
  elif remote.wall == this.wall:
    this.logical = max(this.logical, remote.logical) + 1
```

If the wall clock jumps backward (NTP adjustment), HLC's logical counter absorbs the difference — `now()` always returns monotonically increasing timestamps.

#### TopologyManager
**File**: `src/topology/TopologyManager.ts`

Manages cluster membership, DC labels, and per-node routing tables.

```typescript
interface TopologyConfig {
  dc: string;                        // my DC
  peers: Array<{
    nodeId: string;
    dc: string;                      // which DC this peer belongs to
    host: string;
    port: number;
    role: 'leader' | 'follower';     // can accept writes?
  }>;
}

class TopologyManager {
  getMyDc(): string;
  getPeersInDc(dc: string): PeerInfo[];
  getBackoffConfig(targetNodeId: string): { initial: number; ceiling: number };
  isLocalDc(peerId: string): boolean;
  isEdgeNode(peerId: string): boolean;
}
```

Backoff selection:

| Topology | Condition | Initial | Ceiling | Doubles |
|----------|-----------|---------|---------|---------|
| intra-DC | `peer.dc === myDc` | 100ms | 3s | ×2 |
| cross-DC | `peer.dc !== myDc && !edge` | 1s | 60s | ×2 |
| edge | `peer.role === 'follower' && peer.dc === 'edge'` | 5s | 300s | ×2 |

#### HealthMonitor
**File**: `src/monitoring/HealthMonitor.ts`

Per-target health tracking and lag classification.

```typescript
enum LagLevel { HEALTHY, WARNING, CRITICAL, UNKNOWN }

interface TargetHealth {
  nodeId: string;
  connected: boolean;
  lagMs: number | null;
  lagLevel: LagLevel;
  lastHeartbeat: number | null;
  lastError: string | null;
  pendingCount: number;
}
```

Lag thresholds:

| Level | Condition |
|-------|-----------|
| HEALTHY | lagMs < highLagThreshold (default: 5000ms) |
| WARNING | lagMs < criticalLagThreshold (default: 60000ms) |
| CRITICAL | lagMs ≥ criticalLagThreshold |
| UNKNOWN | No connection established |

---

## 3. Data Flows (Detailed)

### 3.1 Cross-DC Write — Full Trace

```
┌─────────────────────────────────────────────────────────────────────┐
│ DC-West (sqlvec-db cluster, 3 nodes)                                │
│                                                                     │
│ Client → RaftLeader.propose('shard-0', data)                       │
│   ├── Raft commit (3/3 nodes)                                      │
│   ├── apply to state machine (local read available immediately)     │
│   └── OutboxManager.append({                                        │
│         msgId: uuid(),                                              │
│         targetDC: 'dc-east',                                        │
│         payload: msgpack(data),                                     │
│         hlc: HLC.now(),                                             │
│         raftIndex: committed_index                                  │
│       })                                                            │
│                                                                     │
│ OutboxWorker[dc-east] polls every 100ms                            │
│   ├── fetchOldestPending('dc-east', 100)                           │
│   ├── if entries.length > 0:                                        │
│   │     Transport.broadcast({                                       │
│   │       messages: entries,                                        │
│   │       sourceDc: 'dc-west',                                      │
│   │     })                                                          │
│   │     ├── success → markDelivered() for all                      │
│   │     └── failure → markFailed() + backoff                       │
│   └── if no entries → idle until next tick                         │
└─────────────────────────────────────────────────────────────────────┘
        │
        │ TCP/mTLS (curve25519 encryption)
        │
┌─────────────────────────────────────────────────────────────────────┐
│ DC-East (sqlvec-db cluster, 3 nodes)                                │
│                                                                     │
│ Transport.onMessage(batch)                                          │
│   ├── for each entry in batch:                                     │
│   │     ├── DedupRing.tryAdd(msgId) → if duplicate, skip           │
│   │     ├── HLC.observe(entry.hlc)                                  │
│   │     └── if concurrent write detected:                          │
│   │           ConflictResolver.resolve(local_entry, remote_entry)   │
│   │               └── result → propose as new Raft entry           │
│   │         else:                                                   │
│   │           propose(entry) as new Raft entry                     │
│   └── apply to local state machine                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 CDC Streaming — Full Trace

```
┌─────────────────────────────────────────────────────────────────┐
│ sqlvec-db node                                                  │
│                                                                 │
│ INSERT INTO orders VALUES (1, 'widget', 100)                   │
│   ├── Raft commit                                               │
│   ├── apply to SQLite state machine                             │
│   └── WAL flush → CDCEngine.onChange({                          │
│         table: 'orders',                                        │
│         operation: 'insert',                                    │
│         newData: { id: 1, product: 'widget', amount: 100 },    │
│         hlc: HLC.now()                                          │
│       })                                                        │
│         │                                                        │
│         CDCManager: match against publications                  │
│           ├── matched pub 'all_orders' → subscription 'sub_a'  │
│           │     ├── webhook mode → HTTP POST to endpoint       │
│           │     └── outbox mode → OutboxStore.append(...)      │
│           └── no match → event dropped                         │
│         │                                                        │
│         External system receives CDC event                      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Partition Recovery — Full Trace

```
Time T0: DC-West and DC-East connected, normal operation
Time T1: Network partition (cross-DC link drops)
  ├── DC-West OutboxWorker[dc-east]: send fails
  │     ├── entry.retryCount++ → 1
  │     ├── backoff: 1s (first failure)
  │     └── entries accumulate in LMDB (durable)
  ├── DC-East OutboxWorker[dc-west]: same behavior
  └── Both DCs: 
        ├── local Raft continues operating independently
        ├── writes accepted on both sides → divergence begins
        └── AntiEntropy: syncWith() fails → retries (same backoff)

Time T10: Network heals
  ├── Transport reconnects
  ├── OutboxWorker flushes accumulated entries
  │     ├── DC-West: 1,247 entries sent, 1,247 ACKed
  │     └── DC-East: 892 entries sent, 892 ACKed
  └── AntiEntropy.syncAll() triggered
        ├── Detects 15 divergent ranges
        ├── Exchanges missing entries through ConflictResolver
        │     ├── 12 entries: DC-West timestamp > DC-East → DC-West wins
        │     ├── 2 entries: DC-East timestamp > DC-West → DC-East wins
        │     └── 1 entry: identical HLC → tiebreak by nodeId
        └── All nodes converge to consistent state

Time T12: Steady state recovered
```

### 3.4 Conflict Resolution — CRDT Merge Example

```
DC-West (user A)                              DC-East (user B)
  │                                              │
  ├─ SET cart.item_count = 5                     ├─ SET cart.item_count = 3
  │  (counter: { dc-west: +5 })                  │  (counter: { dc-east: +3 })
  │                                              │
  └─── replication ────► resolves ────► ────────┘
                                          │
                                    Result: counter = { dc-west: 5, dc-east: 3 }
                                    Final value = 5 + 3 = 8
                                    (correct: 5 from A + 3 from B)
```

Without CRDT, LWW would pick whichever write arrived last — losing one user's input. CRDT merge preserves both.

---

## 4. Error Handling & Failure Modes

### 4.1 Transport Failures

| Failure | Detection | Recovery |
|---------|-----------|----------|
| TCP connection timeout | Socket timeout (configurable, default 5s) | Exponential backoff, reconnection |
| TLS handshake failure | Certificate validation error | Backoff, log cert details for debugging |
| mTLS peer cert invalid | `certificateUnknown` error | Backoff indefinitely, require manual intervention |
| Connection reset (ECONNRESET) | Socket error event | Immediate reconnect attempt |
| Heartbeat timeout | 3 missed heartbeats → suspect | Mark peer unhealthy, outbox freeze on majority loss |

### 4.2 Outbox Corruption

LMDB is crash-safe by design (mmap + append-only B-tree). Corruption is rare but handled:

| Scenario | Handling |
|----------|----------|
| Partial write on crash | LMDB's MVCC ensures atomic page writes. Uncommitted transactions are discarded on reopen. |
| Full LMDB map | `isCapacityExceeded() → true` when 80% used. FederationManager emits warning. |
| File system full | LMDB throws `ENOSPC` on `txn.commit()`. Outbox pauses, error logged. |

### 4.3 CDC Failures

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Webhook endpoint down | HTTP timeout after `webhookTimeoutMs` | Retry with backoff (same as outbox). Dead letter after max retries. |
| Publication table dropped | onChange fires with `UNKNOWN_TABLE` | Mark subscription as invalid. Call `onSlotInvalid(slotId)`. |
| Subscription lag | Pending events accumulate beyond threshold | `onHighLag()` callback. Application decides to drop or wait. |

### 4.4 Anti-Entropy Failures

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Peer unreachable | Sync attempt timeout | Retry on next interval |
| Merkle tree too large | >30s to build tree | Increase depth parameter (fewer leaf comparisons per node) |
| Sync diverges cyclically | Same ranges diverge every cycle | Escalate: manual reconciliation required |

---

## 5. Configuration Reference

```typescript
interface FederationConfig {
  /** DC identifier (used for HLC node ID, routing) */
  dc: string;
  /** Transport instance (TCP/mTLS or in-process) */
  transport: ITransport;
  /** Registered downstream consumers */
  consumers: IFederationConsumer[];
  /** Replication engine settings */
  replication?: {
    tickMs?: number;          // default 100 — outbox poll interval
    maxBatchSize?: number;    // default 100 — entries per batch send
    maxBackoffSeconds?: {     // per-topology backoff ceiling
      intraDC?: number;       // default 3
      crossDC?: number;       // default 60
      edge?: number;          // default 300
    };
  };
  /** Change data capture settings */
  cdc?: {
    enabled: boolean;         // default false
    webhookTimeoutMs?: number;// default 5000
    webhookRetryMax?: number; // default 3
  };
  /** Anti-entropy reconciliation settings */
  antiEntropy?: {
    enabled: boolean;         // default true
    intervalSeconds?: number; // default 30 — how often to sync
    merkleDepth?: number;     // default 8 — tree depth vs. precision
  };
  /** HLC settings */
  hlc?: {
    maxDriftMs?: number;      // default 500 — warn if wall clock drift exceeds this
  };
}
```

---

## 6. Interface Contracts

Every module is defined by its interface contract. Tests verify against interfaces, not implementations.

```typescript
// src/interfaces/transport/ITransport.ts
interface ITransport {
  /** Send a message to a specific peer */
  send(peerId: string, msg: TransportMessage): Promise<boolean>;
  
  /** Broadcast to all connected peers */
  broadcast(msg: TransportMessage): Promise<number>;
  
  /** Subscribe to inbound messages. Returns unsubscribe function. */
  onMessage(cb: (msg: InboundMessage) => void): () => void;
  
  /** Lifecycle */
  start(): Promise<void>;
  stop(): Promise<void>;
}

// src/interfaces/replication/IMultiLeaderReplication.ts
interface IMultiLeaderReplication {
  start(config: ReplicationConfig): Promise<void>;
  stop(): Promise<void>;
  replicate(shardId: number, data: string, type: string): Promise<{ msgId: string }>;
  getStatus(): Promise<ReplicationStatus>;
  retryFailed(targetNodeId: string): Promise<number>;
  onTargetConnected(cb: (id: string) => void): () => void;
  onTargetDisconnected(cb: (id: string) => void): () => void;
  onHighLag(cb: (id: string, lagMs: number) => void): () => void;
}

// src/interfaces/replication/ICDCManager.ts
interface ICDCManager {
  createPublication(name: string, tables: string[]): Promise<ICDCPublication>;
  dropPublication(name: string): Promise<void>;
  createSubscription(name: string, pubName: string, target: SubscriptionTarget): Promise<CDCSubscription>;
  dropSubscription(name: string): Promise<void>;
  getSubscriptions(): Promise<CDCSubscription[]>;
  getPublications(): Promise<ICDCPublication[]>;
  onSlotInvalid(cb: (subId: string) => void): () => void;
}

// src/interfaces/replication/IAntiEntropy.ts
interface IAntiEntropy {
  start(config: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  syncWith(peerNodeId: string): Promise<SyncResult>;
  syncAll(): Promise<SyncResult[]>;
  getMerkleRoot(shardId: string): Promise<string>;
  getMerkleTree(shardId: string): Promise<MerkleNode>;
}

// src/interfaces/outbox/IOutboxStore.ts
interface IOutboxStore {
  add(entry: Omit<OutboxEntry, 'msgId' | 'createdAt'>): Promise<string>;
  fetchOldestPending(peerId: string, limit?: number): Promise<OutboxEntry[]>;
  markDelivered(msgId: string): Promise<void>;
  markFailed(msgId: string): Promise<'pending' | 'dead-letter'>;
  getDeadLetterEntries(): Promise<OutboxEntry[]>;
  retryDeadLetter(msgId: string): Promise<void>;
  getStats(): Promise<OutboxStats>;
  isCapacityExceeded(): boolean;
}

// src/interfaces/hlc/IHLCTimestamp.ts
interface IHLCTimestamp {
  wall: number;
  logical: number;
  nodeId?: string;
}

// Integration consumer interface
interface IFederationConsumer {
  proposeReplicated(entry: ReplicatedEntry): Promise<void>;
  getHLC(): IHLCTimestamp;
  onConflict(conflict: ConflictEntry): Promise<void>;
}
```

---

## 7. Acceptance Criteria (Summary)

All 275 tests validate against these criteria. Each criterion maps to one or more test cases.

| Category | AC ID | Criteria | Tests |
|----------|-------|----------|-------|
| **Zero data loss** | 40.1–5 | Outbox durability, crash recovery, at-least-once delivery, dead letter, manual retry | 26 |
| **Low latency** | 41.1–4 | intra-DC <1s P99, batched sends, per-topology backoff, capacity | 9 |
| **Causal consistency** | 42.1–4 | HLC monotonicity, observe, serialization, write timestamp verification | 14 |
| **Partition tolerance** | 43.1–5 | Outbox freeze, unfreeze, no data loss, AE divergence detection, deterministic recovery | 12 |
| **Conflict resolution** | 44.1–4 | LWW, LWW tiebreak, CRDT merge, custom resolver | 18 |
| **CDC** | 45.1–5 | Start/stop, watch/unwatch, onChange delivery, publication lifecycle, webhook dispatch | 26 |
| **Integration** | 46.1–6 | SqlVec consumer, GraphVec consumer, TcpTransport, reverse integration | 32 |

Total: **275 tests across 16 test files** ✅

---

## 8. Implementation Guidelines

### Adding a new transport backend
1. Implement `ITransport` interface
2. Pass to `FederationManager` constructor
3. Ensure `send()` returns `false` (not throws) on transient failure
4. Implement reconnection state machine (CONNECTING → CONNECTED → BACKOFF)

### Adding a new conflict resolution strategy
1. Extend `ConflictStrategy` type
2. Add handler to `ConflictResolver.registerStrategy()`
3. Ensure deterministic result for same input pair
4. Add acceptance test (AC 44.x)

### Adding a new integration consumer
1. Implement `IFederationConsumer`
2. Wire to your local consensus provider/outbox
3. Register via `FederationManager.registerConsumer()`
4. Test with `InProcessTransport` for isolation
