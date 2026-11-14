import type { IAutoTuner } from '../interfaces/index.js';
import type { TuningRecommendation, TuningConfig, AutoScalerMetrics } from '../interfaces/types.js';

export class InMemoryAutoTuner implements IAutoTuner {
  private history: TuningRecommendation[] = [];
  private config: TuningConfig = { learningRate: 0.1, minConfidence: 0.7 };

  configure(config: TuningConfig): void {
    this.config = { ...config };
  }

  async analyze(metrics: AutoScalerMetrics): Promise<TuningRecommendation[]> {
    const recommendations: TuningRecommendation[] = [];

    // CPU-based tuning recommendation
    if (metrics.cpu > 0.7) {
      recommendations.push({
        parameter: 'max_connections',
        currentValue: 100,
        recommendedValue: 150,
        confidence: 0.85,
        reason: `CPU at ${(metrics.cpu * 100).toFixed(0)}% suggests higher connection pool`,
      });
    }

    // Latency-based tuning recommendation
    if (metrics.latency > 100) {
      recommendations.push({
        parameter: 'query_timeout_ms',
        currentValue: 5000,
        recommendedValue: 10000,
        confidence: 0.75,
        reason: `Latency at ${metrics.latency}ms exceeds threshold`,
      });
    }

    // QPS-based recommendation
    if (metrics.qps > 5000) {
      recommendations.push({
        parameter: 'pool_size',
        currentValue: 10,
        recommendedValue: Math.min(20, Math.ceil(metrics.qps / 500)),
        confidence: 0.9,
        reason: `QPS at ${metrics.qps} suggests pool increase`,
      });
    }

    return recommendations;
  }

  async apply(recommendation: TuningRecommendation): Promise<void> {
    if (recommendation.confidence >= this.config.minConfidence) {
      this.history.push({ ...recommendation });
    }
  }

  getHistory(): TuningRecommendation[] {
    return [...this.history];
  }
}
