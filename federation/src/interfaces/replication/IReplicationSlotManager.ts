export interface ReplicationSlot {
  slotName: string;
  outputPlugin: string;
  database: string;
  lsn: string;
  active: boolean;
  activePID: number | null;
  catalogXmin: number | null;
  restartLsn: string | null;
  confirmedFlushLsn: string | null;
}

export interface IReplicationSlotManager {
  createSlot(slotName: string, outputPlugin?: string): Promise<ReplicationSlot>;
  dropSlot(slotName: string): Promise<void>;
  getSlot(slotName: string): Promise<ReplicationSlot | null>;
  listSlots(): Promise<ReplicationSlot[]>;
  /** Advance the confirmed flush LSN for a slot */
  advanceSlot(slotName: string, lsn: string): Promise<void>;
  /** Get the oldest WAL position still needed by any slot */
  getOldestRequiredLSN(): Promise<string>;
}
