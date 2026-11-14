import type { ISLACollector } from '../interfaces/index.js';
import type { SLAEvent } from '../interfaces/types.js';

export class InMemorySLACollector implements ISLACollector {
  private events: SLAEvent[] = [];

  record(event: Omit<SLAEvent, 'violated'>): void {
    const violated = event.value > event.threshold;
    this.events.push({ ...event, violated });
  }

  getSLACompliance(since?: Date): Map<string, number> {
    const filtered = since
      ? this.events.filter(e => e.timestamp >= since)
      : this.events;

    const metricGroups = new Map<string, { total: number; ok: number }>();
    for (const event of filtered) {
      if (!metricGroups.has(event.metric)) {
        metricGroups.set(event.metric, { total: 0, ok: 0 });
      }
      const group = metricGroups.get(event.metric)!;
      group.total++;
      if (!event.violated) group.ok++;
    }

    const result = new Map<string, number>();
    for (const [metric, group] of metricGroups) {
      result.set(metric, group.total > 0 ? (group.ok / group.total) * 100 : 100);
    }
    return result;
  }

  getViolations(since?: Date): SLAEvent[] {
    return this.events.filter(e => {
      if (since && e.timestamp < since) return false;
      return e.violated;
    });
  }

  getUptime(since?: Date): number {
    const filtered = since
      ? this.events.filter(e => e.timestamp >= since)
      : this.events;

    if (filtered.length === 0) return 100;
    const violations = filtered.filter(e => e.violated);
    return ((filtered.length - violations.length) / filtered.length) * 100;
  }
}
