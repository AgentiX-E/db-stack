/**
 * RaftMetricsCollector — Raft-specific metrics for db-cluster.
 *
 * Collects:
 *   - leader_changes: counter (incremented on every election outcome)
 *   - proposals_total: counter (total proposals submitted)
 *   - proposals_failed: counter (proposals rejected)
 *   - commit_latency_ms: histogram (time from proposal to commit)
 *   - current_term: gauge
 *   - log_size_bytes: gauge
 *   - peer_count: gauge
 *
 * I13 invariant (OBS1): All Raft operations expose a metrics hook.
 *
 * @module db-cluster/observability
 */

/** Snapshot of Raft metrics at a point in time. */
export interface RaftMetricsSnapshot {
  leaderChanges: number;
  proposalsTotal: number;
  proposalsFailed: number;
  currentTerm: number;
  logSizeBytes: number;
  peerCount: number;
  commitLatencyMs: number;
  commitLatencyP50: number;
  commitLatencyP95: number;
  commitLatencyP99: number;
  /** Percentile buckets (ms): 1,5,10,25,50,100,250,500,1000 */
  commitLatencyBuckets: number[];
}

/** Bucket boundaries for commit latency histogram. */
const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

/**
 * Lightweight in-process metrics collector.
 *
 * Not a Prometheus registry — just counters + simple percentile
 * computation. Can be exported to any metrics backend.
 */
export class RaftMetricsCollector {
  // ── Counters ──────────────────────────────────────────
  private _leaderChanges = 0;
  private _proposalsTotal = 0;
  private _proposalsFailed = 0;

  // ── Gauges ────────────────────────────────────────────
  private _currentTerm = 0;
  private _logSizeBytes = 0;
  private _peerCount = 0;

  // ── Histogram (commit latency) ────────────────────────
  private readonly _buckets: number[] = new Array(LATENCY_BUCKETS.length).fill(0);
  private _latencyCount = 0;
  private _latencySum = 0;
  private _latencies: number[] = []; // for percentile computation (capped)

  private readonly _maxSamples = 10_000; // cap to avoid unbounded memory

  // ── Record methods ─────────────────────────────────────

  recordLeaderChange(): void {
    this._leaderChanges++;
  }

  recordProposal(success: boolean): void {
    this._proposalsTotal++;
    if (!success) this._proposalsFailed++;
  }

  recordCommitLatency(ms: number): void {
    this._latencyCount++;
    this._latencySum += ms;

    // Histogram bucket
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      const bound = LATENCY_BUCKETS[i]!;
      if (ms <= bound) {
        this._buckets[i] = this._buckets[i]! + 1;
        break;
      }
    }
    // Overflow (above max bucket)
    const lastIdx = LATENCY_BUCKETS.length - 1;
    if (ms > LATENCY_BUCKETS[lastIdx]!) {
      (this._buckets[lastIdx] as number)++;
    }

    // Percentile sample
    if (this._latencies.length < this._maxSamples) {
      this._latencies.push(ms);
    }
  }

  // ── Gauge setters ──────────────────────────────────────

  setTerm(term: number): void { this._currentTerm = term; }
  setLogSizeBytes(bytes: number): void { this._logSizeBytes = bytes; }
  setPeerCount(count: number): void { this._peerCount = count; }

  // ── Snapshot ───────────────────────────────────────────

  snapshot(): RaftMetricsSnapshot {
    return {
      leaderChanges: this._leaderChanges,
      proposalsTotal: this._proposalsTotal,
      proposalsFailed: this._proposalsFailed,
      currentTerm: this._currentTerm,
      logSizeBytes: this._logSizeBytes,
      peerCount: this._peerCount,
      commitLatencyMs: this._latencyCount > 0 ? Math.round(this._latencySum / this._latencyCount) : 0,
      commitLatencyP50: this._percentile(50),
      commitLatencyP95: this._percentile(95),
      commitLatencyP99: this._percentile(99),
      commitLatencyBuckets: [...this._buckets],
    };
  }

  /** Prometheus-compatible text format (for /metrics endpoint). */
  toPrometheus(prefix = 'db_cluster'): string {
    const s = this.snapshot();
    const lines = [
      `# HELP ${prefix}_leader_changes_total Number of leader changes.`,
      `# TYPE ${prefix}_leader_changes_total counter`,
      `${prefix}_leader_changes_total ${s.leaderChanges}`,

      `# HELP ${prefix}_proposals_total Total proposals submitted.`,
      `# TYPE ${prefix}_proposals_total counter`,
      `${prefix}_proposals_total ${s.proposalsTotal}`,

      `# HELP ${prefix}_proposals_failed_total Total failed proposals.`,
      `# TYPE ${prefix}_proposals_failed_total counter`,
      `${prefix}_proposals_failed_total ${s.proposalsFailed}`,

      `# HELP ${prefix}_current_term Current Raft term.`,
      `# TYPE ${prefix}_current_term gauge`,
      `${prefix}_current_term ${s.currentTerm}`,

      `# HELP ${prefix}_log_size_bytes Approximate log size in bytes.`,
      `# TYPE ${prefix}_log_size_bytes gauge`,
      `${prefix}_log_size_bytes ${s.logSizeBytes}`,

      `# HELP ${prefix}_peer_count Number of peer nodes.`,
      `# TYPE ${prefix}_peer_count gauge`,
      `${prefix}_peer_count ${s.peerCount}`,

      `# HELP ${prefix}_commit_latency_ms Average commit latency.`,
      `# TYPE ${prefix}_commit_latency_ms gauge`,
      `${prefix}_commit_latency_ms ${s.commitLatencyMs}`,

      `# HELP ${prefix}_commit_latency_seconds Histogram of commit latency.`,
      `# TYPE ${prefix}_commit_latency_seconds histogram`,
      ...LATENCY_BUCKETS.map((b, i) =>
        `${prefix}_commit_latency_seconds_bucket{le="${b}"} ${s.commitLatencyBuckets[i]}`),
    ];
    return lines.join('\n') + '\n';
  }

  /** Reset all counters (useful for tests). */
  reset(): void {
    this._leaderChanges = 0;
    this._proposalsTotal = 0;
    this._proposalsFailed = 0;
    this._buckets.fill(0);
    this._latencyCount = 0;
    this._latencySum = 0;
    this._latencies = [];
  }

  // ── Private ────────────────────────────────────────────

  private _percentile(p: number): number {
    if (this._latencies.length === 0) return 0;
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    const clamped = Math.max(0, Math.min(idx, sorted.length - 1));
    return sorted[clamped] as number;
  }
}
