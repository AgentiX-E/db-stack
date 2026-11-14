/**
 * InMemoryAlertRuleManager — IAlertRuleManager implementation.
 *
 * Manages alert rules in memory. Supports add/remove/toggle/enable.
 * evaluate() checks enabled rules against a provided snapshot.
 *
 * @module @agentix-e/db-operations-monitor/impl
 */

import type { AlertRule, TriggeredAlert } from '../interfaces/index.js';

interface RuleEntry {
  rule: AlertRule;
  enabled: boolean;
}

/**
 * In-memory alert rule manager.
 */
export class InMemoryAlertRuleManager {
  private readonly _rules = new Map<string, RuleEntry>();
  private readonly _silencedUntil = new Map<string, number>();

  /**
   * Create a new alert rule.
   */
  createRule(rule: AlertRule): Promise<string> {
    const id = rule.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._rules.set(id, {
      rule: { ...rule, id },
      enabled: rule.enabled !== false,
    });
    return Promise.resolve(id);
  }

  /**
   * Update an existing alert rule.
   */
  updateRule(id: string, rule: Partial<AlertRule>): Promise<void> {
    const existing = this._rules.get(id);
    if (!existing) {
      return Promise.reject(new Error(`Rule not found: ${id}`));
    }
    existing.rule = { ...existing.rule, ...rule, id };
    return Promise.resolve();
  }

  /**
   * Delete an alert rule.
   */
  deleteRule(id: string): Promise<void> {
    this._rules.delete(id);
    this._silencedUntil.delete(id);
    return Promise.resolve();
  }

  /**
   * Evaluate all rules and return triggered alerts.
   *
   * This no-argument overload cannot resolve metric values without a snapshot;
   * rules are therefore only evaluated via {@link evaluateSnapshot}. Returns an
   * empty list to honour the interface contract.
   */
  evaluate(): Promise<TriggeredAlert[]> {
    return Promise.resolve([]);
  }

  /**
   * Silence a rule for a specified duration.
   */
  silenceRule(id: string, durationMs: number): Promise<void> {
    this._silencedUntil.set(id, Date.now() + durationMs);
    return Promise.resolve();
  }

  // ── Additional methods used by tests ──

  /**
   * Add a rule directly.
   */
  addRule(rule: AlertRule): Promise<string> {
    return this.createRule(rule);
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(ruleId: string): boolean {
    this._rules.delete(ruleId);
    this._silencedUntil.delete(ruleId);
    return true;
  }

  /**
   * Get all rules.
   */
  getRules(): AlertRule[] {
    return Array.from(this._rules.values()).map(e => ({ ...e.rule }));
  }

  /**
   * Set a rule's enabled state.
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const entry = this._rules.get(ruleId);
    if (entry) {
      entry.enabled = enabled;
    }
  }

  /**
   * Evaluate rules against a snapshot of values.
   * @param snapshot — Record of metric name → current value
   */
  evaluateSnapshot(snapshot: Record<string, number>): TriggeredAlert[] {
    const triggered: TriggeredAlert[] = [];
    const now = new Date();

    for (const [id, entry] of this._rules) {
      if (!entry.enabled) continue;

      // Check silence
      const silencedUntil = this._silencedUntil.get(id);
      if (silencedUntil && Date.now() < silencedUntil) continue;

      const rule = entry.rule;
      const currentValue = snapshot[rule.metric];

      if (currentValue === undefined) continue;

      let isTriggered: boolean;
      switch (rule.condition) {
        case 'gt': isTriggered = currentValue > rule.threshold; break;
        case 'lt': isTriggered = currentValue < rule.threshold; break;
        case 'eq': isTriggered = currentValue === rule.threshold; break;
        case 'gte': isTriggered = currentValue >= rule.threshold; break;
        case 'lte': isTriggered = currentValue <= rule.threshold; break;
        default: isTriggered = currentValue >= rule.threshold;
      }

      if (isTriggered) {
        triggered.push({
          ruleId: id,
          ruleName: rule.name,
          severity: rule.severity,
          value: currentValue,
          threshold: rule.threshold,
          triggeredAt: now,
          message: `${rule.name}: ${currentValue} ${rule.condition} ${rule.threshold}`,
        });
      }
    }

    return triggered;
  }

  /**
   * Clear all rules.
   */
  clearRules(): void {
    this._rules.clear();
    this._silencedUntil.clear();
  }
}
