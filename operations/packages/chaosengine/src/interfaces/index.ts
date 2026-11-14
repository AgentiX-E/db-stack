import type { FaultType, ChaosFault } from './types.js';

export type { FaultType, ChaosFault };

export interface IChaosEngine {
  inject(fault: ChaosFault): Promise<void>;
  resolve(faultId: string): Promise<void>;
  getActiveFaults(): ChaosFault[];
  getHistory(): ChaosFault[];
}
