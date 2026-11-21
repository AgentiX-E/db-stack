import type { SLAEvent } from './types.js';

export type { SLAEvent };

export interface ISLACollector {
  record(event: Omit<SLAEvent, 'violated'>): void;
  getSLACompliance(since?: Date): Map<string, number>;
  getViolations(since?: Date): SLAEvent[];
  getUptime(since?: Date): number;
}
