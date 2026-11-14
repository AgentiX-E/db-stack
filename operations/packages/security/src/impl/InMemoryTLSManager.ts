import type { ITLSManager, TLSConfig } from '../interfaces/index.js';
import type { CertInfo } from '@agentix-e/db-operations-core/types';

export class InMemoryTLSManager implements ITLSManager {
  private _config: TLSConfig | null = null;
  private _certInfo: CertInfo | null = null;

  async loadConfig(config: TLSConfig): Promise<void> {
    this._config = config;
    this._certInfo = {
      subject: 'CN=localhost',
      issuer: 'CN=TestCA',
      serialNumber: 'ABCDEF123456',
      validFrom: new Date(Date.now() - 86400000 * 60).toISOString(),
      validTo: new Date(Date.now() + 86400000 * 30).toISOString(),
      daysRemaining: 30,
      path: config.certPath,
      fingerprint: 'sha256$$deadbeef',
    };
  }

  async getCertInfo(): Promise<CertInfo> {
    if (!this._certInfo) {
      throw new Error('TLSManager: no config loaded');
    }
    return this._certInfo;
  }

  async reloadCerts(): Promise<void> {
    if (!this._config) {
      throw new Error('TLSManager: no config loaded');
    }
    this._certInfo = {
      subject: 'CN=localhost',
      issuer: 'CN=TestCA',
      serialNumber: 'FEDCBA987654',
      validFrom: new Date(Date.now() - 86400000 * 30).toISOString(),
      validTo: new Date(Date.now() + 86400000 * 60).toISOString(),
      daysRemaining: 60,
      path: this._config.certPath,
      fingerprint: 'sha256$$reloaded',
    };
  }
}
