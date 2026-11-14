export interface AutoScalerMetrics {
  cpu: number;
  qps: number;
  latency: number;
  connectionCount?: number;
}

export interface TuningRecommendation {
  parameter: string;
  currentValue: number;
  recommendedValue: number;
  confidence: number;
  reason: string;
}

export interface TuningConfig {
  learningRate: number;
  minConfidence: number;
}
