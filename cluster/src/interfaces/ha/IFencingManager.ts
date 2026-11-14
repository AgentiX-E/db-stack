export interface IFencingManager {
  /** Acquire a write fence for a shard (prevents split-brain writes) */
  acquireFence(shardId: string, ownerId: string, ttlMs: number): Promise<boolean>;
  /** Release a write fence */
  releaseFence(shardId: string, ownerId: string): Promise<void>;
  /** Check if a shard is currently fenced */
  isFenced(shardId: string): Promise<boolean>;
  /** Get the current fence owner */
  getFenceOwner(shardId: string): Promise<string | null>;
  /** STONITH: forcibly terminate the current fence owner */
  stonith(shardId: string): Promise<void>;
  /** Renew a fence lease (extend TTL) */
  renewFence(shardId: string, ownerId: string, ttlMs: number): Promise<boolean>;
}
