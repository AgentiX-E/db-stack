import type { ICertMonitor } from '../interfaces/index.js';
import type { CertInfo, CertWarningLevel } from '@agentix-e/db-operations-core/types';

interface ExpiryEntry {
  cert: CertInfo;
  level: CertWarningLevel;
}

export class InMemoryCertMonitor implements ICertMonitor {
  private _expiryStatus: Map<string, ExpiryEntry> = new Map();
  private _callbacks: Set<(cert: CertInfo, level: CertWarningLevel) => void> = new Set();
  private _handle: ReturnType<typeof setInterval> | null = null;

  start(checkIntervalMs: number): void {
    if (this._handle) return;
    this._handle = setInterval(() => {
      const entries = this.getExpiryStatus();
      for (const { cert, level } of entries) {
        if (level !== 'ok') {
          for (const cb of this._callbacks) {
            cb(cert, level);
          }
        }
      }
    }, checkIntervalMs);
  }

  stop(): void {
    if (this._handle !== null) {
      clearInterval(this._handle);
      this._handle = null;
    }
    this._expiryStatus.clear();
  }

  getExpiryStatus(): Array<{ cert: CertInfo; level: CertWarningLevel }> {
    return Array.from(this._expiryStatus.values());
  }

  onWarning(cb: (cert: CertInfo, level: CertWarningLevel) => void): () => void {
    this._callbacks.add(cb);
    return () => {
      this._callbacks.delete(cb);
    };
  }

  async autoRenew(): Promise<boolean> {
    return true;
  }

  // Test helper
  addExpiryStatus(cert: CertInfo, level: CertWarningLevel): void {
    this._expiryStatus.set(cert.serialNumber, { cert, level });
  }
}
