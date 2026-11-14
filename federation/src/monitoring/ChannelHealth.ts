/**
 * ChannelHealthCalculator — 跨 DC 通道健康度精确量化。
 *
 * 基于加权公式计算 0-100 的健康分：
 * - lag 惩罚（线性）: penalty_lag = clamp(lagMs / 1000, 0, 1) * 30
 * - errorRate 惩罚（sigmoid）: penalty_err = (errorRate / (errorRate + 0.01)) * 40
 * - reconnectCount 惩罚（指数退避）: penalty_reconn = min(reconnectCount * 5, 25)
 * - jitter 惩罚（对数）: penalty_jitter = min(log2(jitterMs + 1) * 2, 10)
 *
 * 健康分 = 100 - penalty_lag - penalty_err - penalty_reconn - penalty_jitter
 * 最低为 0。
 *
 * @module monitoring
 */

export interface ChannelHealthMetrics {
  /** 复制延迟 (ms) */
  lagMs: number;
  /** 延迟抖动 (ms) */
  jitterMs: number;
  /** 当前吞吐 (ops/sec) */
  throughputOps: number;
  /** 错误率 (0-1) */
  errorRate: number;
  /** 累计重连次数 */
  reconnectCount: number;
}

export interface ChannelHealthResult {
  /** 0-100 综合健康分 */
  healthScore: number;
  /** 各维度独立评分 */
  breakdown: {
    lagPenalty: number;
    errorPenalty: number;
    reconnectPenalty: number;
    jitterPenalty: number;
  };
  /** 健康等级 */
  level: 'healthy' | 'degraded' | 'critical';
  /** 计算时间 */
  timestamp: number;
}

// ── 工具函数 ──────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function log2(x: number): number {
  return Math.log(Math.max(x, 1)) / Math.LN2;
}

// ── 实现 ──────────────────────────────────────────────────────────

export class ChannelHealthCalculator {
  /**
   * 计算通道健康分。
   *
   * 公式合理性：
   * - errorRate 惩罚最重（最多 -40），因为错误直接影响数据正确性
   * - lag 惩罚（最多 -30），延迟影响实时性
   * - reconnectCount（最多 -25），频繁重连说明网络不稳定
   * - jitter（最多 -10），抖动对吞吐影响较小但仍需监控
   *
   * 健康分分段：
   * - healthy: score ≥ 80
   * - degraded: 50 ≤ score < 80
   * - critical: score < 50
   */
  calculate(metrics: ChannelHealthMetrics): ChannelHealthResult {
    // 1. Lag 惩罚（线性）
    const lagPenalty = clamp(metrics.lagMs / 1000, 0, 1) * 30;

    // 2. ErrorRate 惩罚（sigmoid-like）
    const errorPenalty = (metrics.errorRate / Math.max(metrics.errorRate + 0.01, 0.01)) * 40;

    // 3. Reconnect 惩罚（线性，最多 25）
    const reconnectPenalty = clamp(metrics.reconnectCount * 5, 0, 25);

    // 4. Jitter 惩罚（对数，最多 10）
    const jitterPenalty = clamp(log2(metrics.jitterMs + 1) * 2, 0, 10);

    // 计算综合分
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
   * 批量计算多个通道的健康分（例如多个目标 DC）。
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
