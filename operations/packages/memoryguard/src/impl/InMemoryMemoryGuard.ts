import type { IMemoryGuard } from '../interfaces/index.js';
import type { MemoryStats } from '../interfaces/types.js';

export class InMemoryMemoryGuard implements IMemoryGuard {
  private threshold = 0.9;

  configure(threshold: number): void {
    this.threshold = threshold;
  }

  getStats(): MemoryStats {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      threshold: this.threshold,
    };
  }

  isHealthy(): boolean {
    const stats = this.getStats();
    const ratio = stats.heapTotal > 0 ? stats.heapUsed / stats.heapTotal : 0;
    return ratio < this.threshold;
  }

  async protect<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!this.isHealthy()) {
      return null;
    }
    return fn();
  }
}
