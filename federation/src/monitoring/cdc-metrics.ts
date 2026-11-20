/**
 * cdc-metrics — the counters, in a form an operator can scrape, and the
 * identity that says they add up.
 *
 * Two things were missing and they are the same thing. The pump and the
 * pipeline both kept counters that nothing exported, so "is the CDC path
 * healthy" could only be answered by reading the source; and nothing stated
 * what the counters were supposed to sum to, so a counter that silently stopped
 * incrementing looked exactly like a quiet stream.
 *
 * The identity, for the pump:
 *
 *     accepted = delivered + failed + dropped + Σ pending
 *
 * It holds because the queue is the ledger. Every change routed to a
 * subscription is counted once as `accepted`; from that moment it is in exactly
 * one place — waiting in the queue (`pending`, which includes the head being
 * emitted right now, because the head is only shifted after its outcome is
 * known), delivered, failed after the retry budget, or dropped (the queue was
 * full, the subscription was closed, or the pump stopped). There is no
 * in-flight bucket: giving the head its own counter would let the identity hold
 * while the head was double-counted in `pending`.
 *
 * For the pipeline the identity is over the outbox:
 *
 *     produced = stillPending + sent + deadLettered
 *
 * where `produced` counts only the events this process appended. It is exact
 * for an outbox that was empty at start, which is why `pipelineConservation`
 * takes the pre-existing count rather than assuming zero.
 */

import type { CDCSubscriptionPumpStatus } from '../replication/CDCSubscriptionPump';
import type { CDCPipelineMetrics } from '../replication/ExactlyOnceCDCPipeline';

export type MetricLabels = Record<string, string>;

export interface PumpConservation {
  accepted: number;
  delivered: number;
  failed: number;
  dropped: number;
  pending: number;
  /** delivered + failed + dropped + pending */
  accounted: number;
  /** accepted - accounted; zero when the counters agree */
  unaccounted: number;
  balanced: boolean;
}

export interface PipelineConservation {
  produced: number;
  pending: number;
  sent: number;
  deadLettered: number;
  accounted: number;
  unaccounted: number;
  balanced: boolean;
}

/** Does the pump's ledger balance? */
export function pumpConservation(status: CDCSubscriptionPumpStatus): PumpConservation {
  const pending = Object.values(status.pending).reduce((sum, count) => sum + count, 0);
  const accounted = status.delivered + status.failed + status.dropped + pending;
  return {
    accepted: status.accepted,
    delivered: status.delivered,
    failed: status.failed,
    dropped: status.dropped,
    pending,
    accounted,
    unaccounted: status.accepted - accounted,
    balanced: status.accepted === accounted,
  };
}

/**
 * Does the pipeline's outbox balance?
 *
 * @param preExisting entries the outbox held before this process started.
 *   Their `produced` was counted by an earlier process, so they are added to
 *   the left-hand side rather than assumed away.
 */
export function pipelineConservation(metrics: CDCPipelineMetrics, preExisting = 0): PipelineConservation {
  const accounted = metrics.pendingCount + metrics.outboxDelivered + metrics.deadLetterCount;
  return {
    produced: metrics.totalProduced,
    pending: metrics.pendingCount,
    sent: metrics.outboxDelivered,
    deadLettered: metrics.deadLetterCount,
    accounted,
    unaccounted: metrics.totalProduced + preExisting - accounted,
    balanced: metrics.totalProduced + preExisting === accounted,
  };
}

// ── Prometheus text exposition ─────────────────────────────

const PREFIX = 'db_federation';

/**
 * Escape a label value per the exposition format.
 *
 * Backslash, double quote and newline are the only three that are special, and
 * a subscription id is caller-supplied text — the one input that can contain
 * any of them. An unescaped newline turns one metric line into two, and the
 * second one is parsed as a metric the deployment never declared.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelString(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const pairs = keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`);
  return `{${pairs.join(',')}}`;
}

function counter(name: string, help: string, value: number, labels: MetricLabels = {}): string[] {
  const full = `${PREFIX}_${name}`;
  return [`# HELP ${full} ${help}`, `# TYPE ${full} counter`, `${full}${labelString(labels)} ${value}`];
}

function gauge(name: string, help: string, value: number, labels: MetricLabels = {}): string[] {
  const full = `${PREFIX}_${name}`;
  return [`# HELP ${full} ${help}`, `# TYPE ${full} gauge`, `${full}${labelString(labels)} ${value}`];
}

/**
 * Render the pump's status as Prometheus text.
 *
 * `pending` is emitted per subscription because a single number cannot say
 * which destination is stuck. The other counters are process-wide, and the
 * `node` label is what separates two deployments reporting into one scraper.
 */
export function renderPumpMetrics(status: CDCSubscriptionPumpStatus, labels: MetricLabels = {}): string {
  const lines: string[] = [];
  lines.push(
    ...gauge('cdc_pump_started', '1 when the pump is attached to its engine', status.started ? 1 : 0, labels),
    ...gauge('cdc_pump_subscriptions', 'Subscriptions with a connected sink', status.subscriptions, labels),
    ...gauge('cdc_pump_unopened', 'Catalogue subscriptions the pump could not open', status.unopened.length, labels),
    ...counter('cdc_pump_accepted_total', 'Changes routed to a subscription', status.accepted, labels),
    ...counter('cdc_pump_delivered_total', 'Changes the sink accepted', status.delivered, labels),
    ...counter('cdc_pump_failed_total', 'Changes that exhausted the retry budget', status.failed, labels),
    ...counter('cdc_pump_dropped_total', 'Changes that never reached a sink', status.dropped, labels),
    ...counter(
      'cdc_pump_projection_failed_total',
      'Changes a caller-supplied projection refused to convert',
      status.projectionFailed,
      labels,
    ),
  );

  const pendingIds = Object.keys(status.pending).sort();
  if (pendingIds.length === 0) {
    lines.push(...gauge('cdc_pump_pending', 'Changes waiting in a subscription queue', 0, labels));
  } else {
    const help = '# HELP ' + `${PREFIX}_cdc_pump_pending` + ' Changes waiting in a subscription queue';
    lines.push(help, `# TYPE ${PREFIX}_cdc_pump_pending gauge`);
    for (const id of pendingIds) {
      lines.push(`${PREFIX}_cdc_pump_pending${labelString({ ...labels, subscription: id })} ${status.pending[id]}`);
    }
  }

  // The identity as a metric pair, so a scrape can alert on disagreement
  // instead of a human having to subtract four series.
  const conservation = pumpConservation(status);
  lines.push(
    ...gauge('cdc_pump_accounted', 'accepted minus the sum of its outcomes', conservation.accounted, labels),
    ...gauge(
      'cdc_pump_unaccounted',
      'Changes accepted and not accounted for anywhere',
      conservation.unaccounted,
      labels,
    ),
  );
  return `${lines.join('\n')}\n`;
}

/** Render the cross-datacenter pipeline's metrics as Prometheus text. */
export function renderPipelineMetrics(metrics: CDCPipelineMetrics, labels: MetricLabels = {}): string {
  const lines: string[] = [
    ...counter(
      'cdc_pipeline_produced_total',
      'Changes this process appended to the outbox',
      metrics.totalProduced,
      labels,
    ),
    ...counter(
      'cdc_pipeline_sent_total',
      'Outbox entries the peer or the transport accepted',
      metrics.outboxDelivered,
      labels,
    ),
    ...counter(
      'cdc_pipeline_delivered_total',
      'Inbound changes accepted after deduplication',
      metrics.totalDelivered,
      labels,
    ),
    ...counter('cdc_pipeline_deduped_total', 'Inbound changes suppressed as duplicates', metrics.totalDeduped, labels),
    ...counter(
      'cdc_pipeline_dead_letter_total',
      'Outbox entries that exhausted their retries',
      metrics.deadLetterCount,
      labels,
    ),
    ...gauge('cdc_pipeline_pending', 'Outbox entries not yet sent', metrics.pendingCount, labels),
    ...gauge('cdc_pipeline_pump_active', '1 while an outbox pump cycle is running', metrics.pumpActive ? 1 : 0, labels),
  ];
  const conservation = pipelineConservation(metrics);
  lines.push(
    ...gauge(
      'cdc_pipeline_unaccounted',
      'Changes produced and not accounted for by the outbox',
      conservation.unaccounted,
      labels,
    ),
  );
  return `${lines.join('\n')}\n`;
}
