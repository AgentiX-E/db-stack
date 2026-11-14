/**
 * IOutboxWriter — Interface for writing committed Raft entries to the outbox.
 * Bridges the consensus layer to the replication/outbox system.
 */
export interface IOutboxWriter {
  write(shardId: string, index: number, term: number, data: string): Promise<void>;
  getLastWrittenIndex(shardId: string): Promise<number>;
}
