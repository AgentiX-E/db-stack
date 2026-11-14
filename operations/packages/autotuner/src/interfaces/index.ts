import type { TuningRecommendation, TuningConfig, AutoScalerMetrics } from './types.js';

export type { TuningRecommendation, TuningConfig, AutoScalerMetrics };

export interface IAutoTuner {
  analyze(metrics: AutoScalerMetrics): Promise<TuningRecommendation[]>;
  apply(recommendation: TuningRecommendation): Promise<void>;
  getHistory(): TuningRecommendation[];
  configure(config: TuningConfig): void;
}
