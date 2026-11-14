import type { ISecurityCompliance } from '../interfaces/index.js';
import type { SecurityCheck } from '@agentix-e/db-operations-core/types';

export class InMemorySecurityCompliance implements ISecurityCompliance {
  private _checks: SecurityCheck[] = [];

  registerChecks(checks: SecurityCheck[]): void {
    this._checks.push(...checks);
  }

  async runChecks(): Promise<SecurityCheck[]> {
    return this._checks.map((check) => ({
      ...check,
      timestamp: new Date().toISOString(),
    }));
  }

  async runCategory(category: string): Promise<SecurityCheck[]> {
    return this._checks
      .filter((c) => c.category === category)
      .map((check) => ({
        ...check,
        timestamp: new Date().toISOString(),
      }));
  }

  getScore(): number {
    if (this._checks.length === 0) return 100; // Empty = no violations → perfect score
    let sum = 0;
    for (const check of this._checks) {
      if (check.severity === 'PASS') sum += 1;
      else if (check.severity === 'WARN') sum += 0.5;
    }
    return Math.round((sum / this._checks.length) * 100);
  }
}
