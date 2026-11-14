export interface IDeadlockDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
  detectDeadlocks(holds: Map<number, Set<string>>, waits: Map<number, Set<number>>): number | null;
  wouldCauseDeadlock(
    sessionId: number,
    resourceId: string,
    holds: Map<number, Set<string>>,
    waits: Map<number, Set<number>>,
  ): boolean;
  releaseSession(sessionId: number): void;
  reportHold(sessionId: number, resourceId: string): void;
  onDeadlock(callback: (info: { cycle: number[]; victimTransaction: number; detectedAt: number }) => void): () => void;
  getDeadlockHistory(): Array<{ cycle: number[]; victimTransaction: number; detectedAt: number }>;
}
