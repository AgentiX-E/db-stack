/**
 * cdc-metrics — the counters as an operator sees them, and the identity.
 *
 *   AC 96.1  pumpConservation balances the four outcomes, and names the gap
 *   AC 96.2  pipelineConservation balances the outbox, including pre-existing
 *            entries
 *   AC 96.3  the exposition is deterministic, sorted, and declares HELP/TYPE once
 *   AC 96.4  a label value cannot break the format
 *   AC 96.5  an idle pump still emits a pending series
 *   AC 96.6  the pipeline exposition carries the sender, receiver and queue
 */

import { describe, expect, it } from 'vitest';
import {
  escapeLabelValue,
  pipelineConservation,
  pumpConservation,
  renderPipelineMetrics,
  renderPumpMetrics,
} from './cdc-metrics';
import type { CDCSubscriptionPumpStatus } from '../replication/CDCSubscriptionPump';
import type { CDCPipelineMetrics } from '../replication/ExactlyOnceCDCPipeline';

const status = (overrides: Partial<CDCSubscriptionPumpStatus> = {}): CDCSubscriptionPumpStatus => ({
  started: true,
  subscriptions: 2,
  unopened: [],
  pending: { 'sub-a': 2, 'sub-b': 3 },
  accepted: 20,
  delivered: 10,
  failed: 3,
  projectionFailed: 0,
  dropped: 2,
  evictedFailures: 0,
  ...overrides,
});

const metrics = (overrides: Partial<CDCPipelineMetrics> = {}): CDCPipelineMetrics => ({
  totalProduced: 10,
  totalDelivered: 4,
  totalDeduped: 1,
  pendingCount: 5,
  outboxDelivered: 4,
  checkpoints: {},
  deadLetterCount: 1,
  pumpActive: false,
  acksReceived: 4,
  ackTimeouts: 0,
  ...overrides,
});

describe('cdc-metrics', () => {
  it('AC 96.1: pumpConservation balances the four outcomes, and names the gap', () => {
    // 10 delivered + 3 failed + 2 dropped + (2 + 3) pending = 20 accepted
    expect(pumpConservation(status())).toEqual({
      accepted: 20,
      delivered: 10,
      failed: 3,
      dropped: 2,
      pending: 5,
      accounted: 20,
      unaccounted: 0,
      balanced: true,
    });

    // One change that was accepted and then went nowhere: the identity is the
    // only thing that can say so, because every individual counter is sane.
    const short = pumpConservation(status({ accepted: 21 }));
    expect(short.balanced).toBe(false);
    expect(short.unaccounted).toBe(1);

    const over = pumpConservation(status({ accepted: 19 }));
    expect(over.unaccounted).toBe(-1);
    expect(over.balanced).toBe(false);
  });

  it('AC 96.2: pipelineConservation balances the outbox, including pre-existing entries', () => {
    // produced(10) = pending(5) + sent(4) + deadLettered(1)
    expect(pipelineConservation(metrics())).toMatchObject({
      produced: 10,
      accounted: 10,
      unaccounted: 0,
      balanced: true,
    });

    // A restart inherits entries produced by an earlier process; without the
    // `preExisting` term the identity would report a gap that is not one.
    expect(pipelineConservation(metrics(), 4)).toMatchObject({
      unaccounted: 4,
      balanced: false,
    });
    expect(pipelineConservation(metrics({ pendingCount: 9 }), 4)).toMatchObject({
      accounted: 14,
      unaccounted: 0,
      balanced: true,
    });
  });

  it('AC 96.3: the exposition is deterministic, sorted, and declares HELP/TYPE once', () => {
    const first = renderPumpMetrics(status(), { node: 'dc-east' });
    const second = renderPumpMetrics(status(), { node: 'dc-east' });
    expect(first).toBe(second);

    const lines = first.trimEnd().split('\n');
    for (const family of [
      'db_federation_cdc_pump_accepted_total',
      'db_federation_cdc_pump_delivered_total',
      'db_federation_cdc_pump_failed_total',
      'db_federation_cdc_pump_dropped_total',
      'db_federation_cdc_pump_pending',
    ]) {
      expect(
        lines.filter((line) => line === `# TYPE ${family} counter` || line === `# TYPE ${family} gauge`),
      ).toHaveLength(1);
    }

    // Sorted by subscription id, so a diff between two scrapes is readable.
    const pending = lines.filter((line) => line.startsWith('db_federation_cdc_pump_pending{'));
    expect(pending).toEqual([
      'db_federation_cdc_pump_pending{node="dc-east",subscription="sub-a"} 2',
      'db_federation_cdc_pump_pending{node="dc-east",subscription="sub-b"} 3',
    ]);

    // Every metric line parses as `<name>{labels} <number>`.
    for (const line of lines) {
      if (line.startsWith('#') || line.length === 0) continue;
      expect(line).toMatch(/^db_federation_[a-z_]+\{?.*\}? -?\d+$/);
    }
  });

  it('AC 96.4: a label value cannot break the format', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');

    const rendered = renderPumpMetrics(status({ pending: { 'line\nbreak"quote': 1 } }));
    // One line per series: an unescaped newline would have produced a second
    // line that the scraper parses as a metric nobody declared.
    const series = rendered.split('\n').filter((line) => line.startsWith('db_federation_cdc_pump_pending{'));
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('subscription="line\\nbreak\\"quote"');
  });

  it('AC 96.5: an idle pump still emits a pending series', () => {
    const rendered = renderPumpMetrics(status({ pending: {}, subscriptions: 0 }));
    // A missing series reads as "no data" to a scraper, and no alert rule can
    // fire on "the queue depth metric disappeared".
    expect(rendered).toContain('db_federation_cdc_pump_pending 0');
  });

  it('AC 96.7: the boolean gauges report both states', () => {
    // A pump that has stopped, and a pipeline whose pump cycle is running: the
    // two flags are the only way a scrape can tell "quiet" from "not started".
    const stopped = renderPumpMetrics(status({ started: false }));
    expect(stopped).toContain('db_federation_cdc_pump_started 0');
    const running = renderPipelineMetrics(metrics({ pumpActive: true }));
    expect(running).toContain('db_federation_cdc_pipeline_pump_active 1');
  });

  it('AC 96.6: the pipeline exposition carries the sender, receiver and queue', () => {
    const rendered = renderPipelineMetrics(metrics(), { node: 'dc-west' });
    expect(rendered).toContain('db_federation_cdc_pipeline_produced_total{node="dc-west"} 10');
    expect(rendered).toContain('db_federation_cdc_pipeline_sent_total{node="dc-west"} 4');
    expect(rendered).toContain('db_federation_cdc_pipeline_delivered_total{node="dc-west"} 4');
    expect(rendered).toContain('db_federation_cdc_pipeline_deduped_total{node="dc-west"} 1');
    expect(rendered).toContain('db_federation_cdc_pipeline_dead_letter_total{node="dc-west"} 1');
    expect(rendered).toContain('db_federation_cdc_pipeline_pending{node="dc-west"} 5');
    expect(rendered).toContain('db_federation_cdc_pipeline_pump_active{node="dc-west"} 0');
    expect(rendered).toContain('db_federation_cdc_pipeline_unaccounted{node="dc-west"} 0');
    expect(rendered.endsWith('\n')).toBe(true);
  });
});
