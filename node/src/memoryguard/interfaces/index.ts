import type { MemoryStats } from './types.js';

export type { MemoryStats };

export interface IMemoryGuard {
  getStats(): MemoryStats;
  isHealthy(): boolean;
  protect<T>(fn: () => Promise<T>): Promise<T | null>;
  configure(threshold: number): void;
}
