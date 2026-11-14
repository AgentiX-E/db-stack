import type { IChaosEngine } from '../interfaces/index.js';
import type { ChaosFault } from '../interfaces/types.js';

let faultCounter = 0;

export class InMemoryChaosEngine implements IChaosEngine {
  private active: Map<string, ChaosFault> = new Map();
  private history: ChaosFault[] = [];

  async inject(fault: ChaosFault): Promise<void> {
    const id = `fault-${++faultCounter}-${Date.now()}`;
    this.active.set(id, { ...fault });
    this.history.push({ ...fault });
  }

  async resolve(faultId: string): Promise<void> {
    this.active.delete(faultId);
  }

  getActiveFaults(): ChaosFault[] {
    return Array.from(this.active.values());
  }

  getHistory(): ChaosFault[] {
    return [...this.history];
  }
}
