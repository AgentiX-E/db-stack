/**
 * ChannelHealthCalculator — precise quantification of cross-DC channel health.
 *
 * Computes a 0-100 health score from a weighted formula:
 * - lag penalty (linear): penalty_lag = clamp(lagMs / 1000, 0, 1) * 30
 * - errorRate penalty (sigmoid): penalty_err = (errorRate / (errorRate + 0.01)) * 40
 * - reconnectCount penalty (exponential backoff): penalty_reconn = min(reconnectCount * 5, 25)
 * - jitter penalty (logarithmic): penalty_jitter = min(log2(jitterMs + 1) * 2, 10)
 *
 * health = 100 - penalty_lag - penalty_err - penalty_reconn - penalty_jitter,
 * clamped at a minimum of 0.
 *
 * @module monitoring
 */

export interface ChannelHealthMetrics {
  /** Replication lag (ms) */
  lagMs: number;
  /** Lag jitter (ms) */
  jitterMs: number;
  /** Current throughput (ops/sec) */
  throughputOps: number;
  /** Error rate (0-1) */
  errorRate: number;
  /** Cumulative reconnect count */
  reconnectCount: number;
}

export interface ChannelHealthResult {
  /** Composite health score, 0-100 */
  healthScore: number;
  /** Per-dimension scores */
  breakdown: {
    lagPenalty: number;
    errorPenalty: number;
    reconnectPenalty: number;
    jitterPenalty: number;
  };
  /** Health grade */
  level: 'healthy' | 'degraded' | 'critical';
  /** Calculation timestamp */
  timestamp: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function log2(x: number): number {
  return Math.log(Math.max(x, 1)) / Math.LN2;
}

// ── Implementation ─────────────────────────────────────────────────

export class ChannelHealthCalculator {
  /**
   * Compute the health score of a channel.
   *
   * Why the weights are shaped this way:
   * - the errorRate penalty is the heaviest (up to -40) because errors corrupt data directly
   * - the lag penalty (up to -30) hurts freshness
   * - reconnectCount (up to -25): frequent reconnects mean an unstable network
   * - jitter (up to -10) affects throughput less, but still needs monitoring
   *
   * Score bands:
   * - healthy: score ≥ 80
   * - degraded: 50 ≤ score < 80
   * - critical: score < 50
   */
  calculate(metrics: ChannelHealthMetrics): ChannelHealthResult {
    // 1. Lag penalty (linear)
    const lagPenalty = clamp(metrics.lagMs / 1000, 0, 1) * 30;

    // 2. errorRate penalty (sigmoid-like)
    const errorPenalty = (metrics.errorRate / Math.max(metrics.errorRate + 0.01, 0.01)) * 40;

    // 3. Reconnect penalty (linear, at most 25)
    const reconnectPenalty = clamp(metrics.reconnectCount * 5, 0, 25);

    // 4. Jitter penalty (logarithmic, at most 10)
    const jitterPenalty = clamp(log2(metrics.jitterMs + 1) * 2, 0, 10);

    // Composite score
    const rawScore = 100 - lagPenalty - errorPenalty - reconnectPenalty - jitterPenalty;
    const healthScore = clamp(rawScore, 0, 100);

    let level: 'healthy' | 'degraded' | 'critical';
    if (healthScore >= 80) {
      level = 'healthy';
    } else if (healthScore >= 50) {
      level = 'degraded';
    } else {
      level = 'critical';
    }

    return {
      healthScore,
      breakdown: {
        lagPenalty,
        errorPenalty,
        reconnectPenalty,
        jitterPenalty,
      },
      level,
      timestamp: Date.now(),
    };
  }

  /**
   * Compute health scores for several channels at once (for example multiple target DCs).
   */
  calculateBatch(
    channels: Array<{ name: string; metrics: ChannelHealthMetrics }>,
  ): Array<{ name: string; result: ChannelHealthResult }> {
    return channels.map((ch) => ({
      name: ch.name,
      result: this.calculate(ch.metrics),
    }));
  }
}
