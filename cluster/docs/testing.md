# Testing harnesses

`@agentix-e/db-cluster/testing` publishes the instruments this package is
verified with: a real multi-node cluster you can start, partition and kill; the
waiting and linearizability checks that make an assertion about a cluster
mean something; and a conformance suite you can run against your own storage
engine.

They ship rather than living in `src/__tests__` for one reason: a deployment's
own suite needs them, and vendoring cluster internals to get them is not a
reasonable thing to ask. `@agentix-e/db-federation` uses `TestCluster` to
verify cross-cluster replication, which is the proof that the harness works
from outside the package.

Nothing here is on the consensus path. Import it in a test suite, never in a
service.

```ts
import { TestCluster, awaitAgreement } from '@agentix-e/db-cluster/testing';
```

## `TestCluster`

An in-process cluster of `RaftAdapter` nodes, each on its own port, speaking
mutual TLS over loopback with certificates generated at `start()`. It is a real
cluster in every respect that a test can observe: separate sockets, separate
storage directories, real elections, real log replication.

```typescript
class TestCluster {
  constructor(opts?: TestClusterOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  findLeader(): Promise<TestNode>;
  awaitLeaderAgreement(options?: LeaderAgreementOptions): Promise<LeaderAgreement>;
  waitForNewLeader(excludeId: number): Promise<TestNode>;
  killNode(id: number): Promise<void>;
  restartNode(id: number, options?: { connectivityTimeoutMs?: number }): Promise<TestNode>;
  remainingNodes(excludeId: number): TestNode[];
  stateOf(id: number): string[];
}
```

### Options

| Option                  | Default               | What it decides                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeCount`             | `3`                   | Nodes to start. Three is the smallest number that can lose one and still elect.                                                                                                                                                                                                                                                                                                         |
| `electionTick`          | `15`                  | Ticks of silence before a follower campaigns.                                                                                                                                                                                                                                                                                                                                           |
| `heartbeatTick`         | `3`                   | Ticks between the leader's heartbeats.                                                                                                                                                                                                                                                                                                                                                  |
| `tickIntervalMs`        | `50`                  | Wall-clock length of a tick. Lower makes every test faster and every timeout tighter.                                                                                                                                                                                                                                                                                                   |
| `leaderTimeoutMs`       | `30_000`              | Budget for `findLeader()` and for `awaitLeaderAgreement()`.                                                                                                                                                                                                                                                                                                                             |
| `pollIntervalMs`        | `200`                 | Gap between polls while waiting for a leader.                                                                                                                                                                                                                                                                                                                                           |
| `snapshotInterval`      | raft-core's own (200) | Entries between snapshots. **Left unset by default on purpose.** The harness used to forward `100_000`, written when the option only drove the group metadata loop; forwarding it to the library switches snapshotting off for the whole run, so the high-concurrency suites grew a 10 000-entry log and slowed by an order of magnitude. Tests that want snapshots pass a small value. |
| `preVote`               | `true`                | Accepted for compatibility. raft-core 0.2.1 always pre-votes.                                                                                                                                                                                                                                                                                                                           |
| `checkQuorum`           | `true`                | Accepted for compatibility and read by nothing downstream: raft-core 0.2.1 has no check-quorum, so an isolated leader keeps claiming leadership while committing nothing. **A test that needs "no progress without a quorum" must assert on commits, not on `isLeader()`.**                                                                                                             |
| `enableInstallSnapshot` | `false`               | Whether a leader may ship a snapshot to a lagging follower.                                                                                                                                                                                                                                                                                                                             |
| `portAllocator`         | OS-assigned           | How ports are chosen. Inject one that returns a port another socket already holds to exercise the retry path in `getFreePort`.                                                                                                                                                                                                                                                          |

### `TestNode`

| Field               | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `id`, `port`, `dir` | The node's identity, listening port and storage directory.  |
| `adapter`           | The `RaftAdapter` itself. Drive proposals through it.       |
| `applied`           | Everything this node's state machine has applied, in order. |

`applied` is not decoration. A node with _no_ application state takes 0-byte
snapshots, so every snapshot test passes without transferring a byte — which is
how a snapshot-encoding defect survives a green suite. The harness keeps the
smallest state machine that behaves like one.

### Lifecycle

`start()` generates certificates, allocates ports, creates directories and
waits for a leader. `stop()` is safe to call twice and closes every listener.

`killNode(id)` destroys a node's listeners without stopping the process, which
is the fault a test usually wants: the data directory survives, so
`restartNode(id)` rejoins with its own log and has to catch up. `restartNode`
waits until the node can talk to its peers before returning, bounded by
`connectivityTimeoutMs`.

`remainingNodes(excludeId)` is the list every test writes when it needs "the
other two", and `stateOf(id)` reads a node's `applied` array.

## Waiting for agreement

A cluster is asynchronous: `findLeader()` resolving does not mean every node
agrees who the leader is, and asserting immediately after an election is how a
suite becomes flaky. These helpers turn "wait for something to become true"
into one line with a budget and a failure that names what it was waiting for.

```typescript
function pollUntil<T>(probe: () => T | Promise<T>, options: ConvergeOptions): Promise<T>;
function awaitAgreement<T>(
  observe: () => T[],
  predicate: (values: T[]) => boolean,
  options: AgreementOptions<T>,
): Promise<T[]>;
```

`pollUntil` waits for `probe()` to return something truthy. `awaitAgreement`
waits for every node's observation to satisfy `predicate` — the shape most
cluster assertions take. Both take `timeoutMs` and `intervalMs`, both default
`intervalMs` to `DEFAULT_POLL_INTERVAL_MS` (50), and both throw
`ConvergenceTimeoutError` on expiry.

`ConvergenceTimeoutError` carries the last observation and the number of
rounds, so a failure reads `waited 30 000 ms over 150 rounds; last saw
["follower","follower","follower"]` instead of `timed out`.

`awaitLeaderAgreement()` is the cluster-level version: it polls until every node
names the same leader and term, and returns `{ leaderId, term, attempts,
elapsedMs }`. `attempts` and `elapsedMs` are there to be asserted on — a
cluster that needs forty rounds to agree is telling you something a boolean
cannot.

## `PartitionTransport`

Isolating a node in-process used to mean stopping it, which is not a partition:
a stopped node's sockets close and sends fail with `ECONNREFUSED`, and a
cluster's reaction to a dead node is a different fault from its reaction to a
network that silently drops packets. `PartitionTransport` models the silent one.

```typescript
class PartitionTransport implements Transport {
  constructor(inner: Transport);
  isolate(peers?: number[]): void; // no argument: every peer
  heal(): void;
  isIsolated(peerId?: number): boolean;
  get blocked(): number[];
  getStats(): PartitionStats;
  get underlying(): Transport;
}
```

It wraps any `Transport`, so a cluster built on the TLS transport gets a
partition switch without knowing about it. A blocked send does not reject: it
answers with a refusal of the request's own kind at term 0, which is the closest
in-process shape of a packet that vanished. Getting the _kind_ right matters —
answering a `RequestVote` with an `AppendEntries` message is not a dropped
message, it is a malformed one that only reads as a rejection by accident.

Isolation is symmetric: an inbound request from a blocked peer is refused too.
Half-open isolation is the shape that lets a "partitioned" follower keep up with
its leader, which is the bug this class exists to make impossible to write.

`getStats()` counts `forwarded`, `blocked`, `delivered` and `refused`, so a test
can assert that a partition actually blocked something rather than assuming it
did.

## `generateClusterCerts`

```typescript
function generateClusterCerts(nodeCount: number): TestClusterCerts;
```

Produces a CA and one leaf per node, valid for `localhost` and loopback, with
mutual authentication on. Each `CertBundle` carries `ca`, `cert` and `key` as
file paths, because that is what the transport's configuration takes.

The certificates are generated per run, not checked in: a fixture key in a
repository is a key that has to be trusted everywhere, and these are worth
nothing outside a test.

## Ports and temporary directories

```typescript
function getFreePort(attempts?: number): Promise<number>;
function getFreePorts(count: number): Promise<number[]>;
function createTempDir(prefix: string): string;
function cleanupTempDir(dir: string): void;
```

`getFreePort` asks the OS for a port and cannot reserve what it is given —
another process may take it between the answer and the bind. It retries
`attempts` times (25 by default) and throws rather than returning a port it
knows is taken. `getFreePorts` checks that the numbers it returns are distinct,
because the OS will happily hand out the same port twice in one sweep.

`createTempDir` returns a fresh directory under the system temp root, and
`cleanupTempDir` removes it and its contents. The removal is deliberately
forgiving: a cleanup that throws because the thing it cleans up is already gone
turns a passing test into a failing one for no reason.

## Linearizability

```typescript
class OperationRecorder {
  recordCall(clientId: string, operation: 'read' | 'write', key: string, value?: string): string;
  recordReturn(callId: string, operation: 'read' | 'write', key: string, value?: string): void;
  getEvents(): Event[];
  isLinearizable(maxStates?: number): boolean | 'unknown';
  reset(): void;
}

class LinearizabilityChecker {
  static isLinearizable(events: Event[], maxStates?: number): boolean | 'unknown';
}

function fuzzyCheck(events: Event[]): FuzzyCheckResult;
```

`OperationRecorder` is the writer: one `recordCall` before the operation, one
`recordReturn` after, and `isLinearizable()` on the resulting history.
`LinearizabilityChecker` is the decision procedure — a bounded search over
legal sequential orderings, consistent with real-time order.

The third return value is the important one. `'unknown'` means the search hit
`maxStates` (one million by default) and cannot answer. It is not `true`, and a
test that treats it as truthy is testing nothing; assert `=== true`.

`fuzzyCheck` is the deliberately weaker check that does not need timing: it
collects every value written to a key and reports reads that returned a value
nobody wrote. It gives up the interleaving and catches the failure that matters
most — fabricated data — in linear time, which makes it the right tool for a
long chaos run where the full checker would exhaust its bound.

## Engine conformance

```typescript
function runEngineConformance(options: EngineConformanceOptions): void;
```

`runEngineConformance` registers a suite that checks any `IStorageEngine` against the contract the
consensus layer assumes: apply is ordered and durable, query sees applied
state, snapshot/restore round-trips, `sizeInBytes` moves with the data, and a
failing apply leaves the replica usable. It registers into whatever framework
you hand it, so it works under `node:test`, Vitest or Jest without a dependency
on any of them.

```typescript
runEngineConformance({
  label: 'my-engine',
  create: () => new MyEngine(),
  codec, // KeyValueConformanceCodec
  framework: { describe, it }, // from your test runner
});
```

`codec` is the part only you can write: a translation from the suite's standard
key/value workload (`put`, `del`, `get`, `keys`) into your engine's own request
bytes, plus decoders for the two queries. Every method is pure — it produces
bytes, it does not run them.

The suite injects its own failure by sending a sentinel payload that the
instrumented engine refuses, so your engine needs no cooperation and no test
hooks of its own.
