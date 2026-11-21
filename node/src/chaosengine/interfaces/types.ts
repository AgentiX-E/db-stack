export type FaultType = 'latency' | 'error' | 'crash' | 'partition' | 'resource_exhaustion';

export interface ChaosFault {
  type: FaultType;
  target: string;
  durationMs: number;
  config?: Record<string, unknown>;
}
