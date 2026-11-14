import type { ISCIMSyncProvider } from '../interfaces/index.js';

export class InMemorySCIMSyncProvider implements ISCIMSyncProvider {
  private _lastSync: Date | null = null;
  private _users: string[] = [];

  async syncUsers(): Promise<{ added: number; updated: number; removed: number }> {
    this._lastSync = new Date();
    if (this._users.length === 0) {
      this._users = ['user-1', 'user-2', 'user-3'];
      return { added: 3, updated: 0, removed: 0 };
    }
    return { added: 0, updated: this._users.length, removed: 0 };
  }

  getLastSyncTime(): Date | null {
    return this._lastSync;
  }

  async fullResync(): Promise<void> {
    this._lastSync = new Date();
    this._users = ['user-1', 'user-2', 'user-3'];
  }
}
