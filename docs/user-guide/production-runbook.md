# Production runbook

Operating the stack: what to configure, what to watch, what to do when something breaks.

---

## 1. Before the first deploy

| Item | Decision | Why it cannot be deferred |
|---|---|---|
| Failure domains | Which racks/AZs/regions hold each voter | Quorum placement determines what outage you survive |
| Cluster size | 3 voters (1 failure) or 5 voters (2 failures) | You cannot change it later without joint consensus |
| Storage class | Local NVMe SSD per node | The log is fsync-bound; network storage multiplies write latency |
| Certificate authority | Your PKI, not the test helper | Node identity is the security boundary |
| Clock policy | NTP/chrony on every node | Raft safety does not need clocks; lease reads and HLC do |
| Backup target | Object storage + retention policy | A backup you cannot restore is not a backup |
| Federation topology | Active–active vs active–passive | Determines your conflict strategy up front |

---

## 2. Certificates

Every node-to-node and DC-to-DC connection is TLS 1.3 with mutual verification.

```
ca.pem
 ├── raft-node-1.pem/.key   CN/SAN: raft-node-1   → node id 1
 ├── raft-node-2.pem/.key   CN/SAN: raft-node-2   → node id 2
 └── raft-node-3.pem/.key   CN/SAN: raft-node-3   → node id 3
```

**Verification rules**

* The CA bundle must contain only the issuers you intend to trust.
* Certificate identity must match the peer's declared id (`raft-node-<id>` by default, or an
  explicit `tls.verify.serverName`).
* A certificate from an unknown CA fails the handshake. It never falls back to plaintext.

**Rotation with zero downtime:** add the new CA to every node's trust bundle, roll the
certificates node by node (never two voters at once), then remove the old CA. Verify with
a handshake test before removing anything:

```bash
openssl s_client -connect node-2:7001 -cert node-1.pem -key node-1.key -CAfile ca.pem -tls1_3 </dev/null
```

---

## 3. Capacity planning

| Resource | Rule of thumb | Symptom when exhausted |
|---|---|---|
| Disk | Log + snapshots + 30 % headroom; growth ≈ write rate × retention | `SQLITE_FULL`, then a node that cannot vote |
| IOPS | ≥ 2 × (write rate) sustained fsyncs | Election storms, apply lag |
| Memory | Snapshot of largest shard × 2 + page cache | OOM during snapshot install |
| Network | Majority RTT drives write latency; keep voters within one region unless RPO 0 is required | p99 write latency climbing without CPU pressure |
| File descriptors | ≥ 1024 per node plus one per peer connection | Handshake failures under load |

Watch `commit_index − applied_index`: persistent divergence is an **apply** bottleneck
(engine too slow, lock contention), not a network problem.

---

## 4. Monitoring

Minimum dashboard:

| Panel | Metric | Alert threshold |
|---|---|---|
| Leadership | term, leader per shard | Term changes > 3 per hour |
| Replication | `commit_index − applied_index` per node | > 10 000 for 5 min |
| Peer health | RTT, reconnect count | RTT > 100 ms or reconnects > 10 per hour |
| Disk | free space, fsync latency | < 20 % free, p99 fsync > 20 ms |
| Snapshots | count, bytes, duration | Duration > 60 s |
| Federation | outbox depth, per-channel lag, channel health | Depth growing for 10 min, health < 80 |
| HA | failover count, verification result | Any verification failure |

Structured logs carry `nodeId`, `shardId`, `term`, `index` — join on those, not on free text.

---

## 5. Failure handling

### 5.1 Leader loss (expected)

Automatic. A new leader is elected within 2–3 election timeouts. Client retries against the
new leader; no operator action. If elections loop, the cause is almost always one of: an
election timeout below the GC pause, asymmetric network loss, or a disk so slow that
`fsync` exceeds the heartbeat interval.

### 5.2 Quorum loss

Writes stop by design. **Do not** "fix" this by starting a new cluster from a surviving
node — that forks history. Options, in order of preference:

1. Restore connectivity to the missing voters.
2. Restore a failed voter from a snapshot (it will catch up).
3. Only after an explicit incident decision: force a new configuration from the majority
   side, accepting that the minority's uncommitted writes are lost.

### 5.3 Suspected split brain

Symptoms: two leaders, divergence warnings from `HAConsistencyVerifier`, or a topology
epoch mismatch in federation.

1. Stop the smaller side (it cannot commit without quorum anyway).
2. Check `FencingManager` events: a leader that was not fenced is the dangerous one.
3. Compare `commit_index` on both sides; the higher one is the truth.
4. Rebuild the loser from a snapshot — never merge logs by hand.

### 5.4 Federation link down

Both DCs keep accepting local writes; the outbox grows. When the link returns, delivery
resumes and anti-entropy repairs divergence.

* Size `dedupTtlMs` above the longest outage you expect.
* If the outbox hits `maxSizeMB`, the pipeline applies backpressure — local writes
  continue, cross-DC lag grows. Alert on growth rate, not just depth.

### 5.5 Node restart

Replays from the last snapshot plus the retained log. If the node fell behind a compacted
prefix, the leader streams a snapshot (`InstallSnapshotHandler`). No manual step.

---

## 6. Upgrade procedure

1. Verify a fresh, **restored** backup exists.
2. Upgrade one node at a time, never touching two voters simultaneously.
3. After each node: readiness green, apply lag zero, term stable for 60 s.
4. Upgrade learners before voters — they can be sacrificed.
5. Federation: upgrade the receiving DC first, then the sending DC.
6. Roll back by reverting the binary, not the data directory.

`RollingUpgradeOrchestrator` implements 2–3 with an abort on the first unhealthy node.

---

## 7. Disaster recovery

| Scenario | RPO | Procedure |
|---|---|---|
| Single node lost | 0 | Replace, join as learner, promote |
| Whole AZ lost (3 voters, 1 per AZ) | 0 | Cluster continues; replace the AZ's node |
| Region lost, federation deployed | Outbox lag | Promote the surviving DC; re-point clients |
| Region lost, no federation | Time of last backup | Restore backup + replay WAL to the desired timestamp (PITR) |

**Restore drill (run quarterly):** restore the latest backup into an isolated environment,
verify the checksum with `BackupVerifier`, start a single-node cluster from it, and run a
read-only query set. A drill that has never been executed is a plan, not a capability.

---

## 8. Security hardening checklist

- [ ] Certificates issued by your PKI, node identity in CN/SAN, no shared certificates
- [ ] CA bundle minimal; test certificates removed from production paths
- [ ] No plaintext transport mode enabled anywhere
- [ ] Encryption at rest enabled for backups and snapshots (`EnvelopeEncryptionProvider`)
- [ ] Audit log shipped off-host, hash chain verified daily (`audit.verify()`)
- [ ] RBAC denies by default; every role justified (`RBACEngine`)
- [ ] Secrets only from environment/secret manager — never in code, config files or git
- [ ] Dependency audit clean (`pnpm audit --audit-level high`) and secret scan green
- [ ] Network policy: only peers may reach the consensus port

---

## 9. On-call quick reference

| Symptom | First check | Command / signal |
|---|---|---|
| Writes rejected | `isLeader()`, `getLeader()` | Client should retry on the leader |
| Writes slow | fsync latency, peer RTT | `RaftMetricsCollector` |
| Reads stale | read mode used | Use `readBarrier()` or `ReadIndexManager` |
| Cluster unreachable | process, ports, certificates | Handshake test from §2 |
| Disk filling | log growth vs snapshots | `snapshotInterval`, `maxLogEntries` |
| Elections looping | election timeout vs GC pause | Increase `tickIntervalMs` |
| Federation lag | channel health, outbox depth | `ChannelHealth`, `getStats()` |
| Duplicate effects | `dedupTtlMs` | Increase to cover the outage window |
