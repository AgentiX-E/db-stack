export type { IAutoScaler } from './interfaces/index.js';
export type {
  ScaleAction,
  AutoScalerMetrics,
  ScalingPolicy,
  ScalingStats,
  ScalingEvent,
  CooldownState,
  ScaleDirection,
  ScalingStrategy,
} from './interfaces/types.js';
export { InMemoryAutoScaler } from './impl/InMemoryAutoScaler.js';
export { PredictiveScalingEngine } from './impl/PredictiveScalingEngine.js';
