/**
 * IPITRHook — Interface for Point-in-Time Recovery hooks.
 */
export interface IPITRHook {
  record(shardId: string, index: number, term: number, data: Buffer | string): Promise<void>;
  getLastRecordedIndex(shardId: string): Promise<number>;
  flush(): Promise<void>;
  /** Hook invoked when Raft applies an entry */
  onApply(shardId: string, index: number, term: number, data: string): void;
}
