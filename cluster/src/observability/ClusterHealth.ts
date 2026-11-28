/**
 * ClusterHealth — the composition root that makes listener failures observable.
 *
 * C-04 made each component's swallowed exception reportable; this root is the
 * one consumer that turns those signals into health state (C-07). It owns a
 * single `HealthProbe` and hands out one reporter that every component can share,
 * so a readiness check can name every component whose listener is broken rather
 * than keeping four disconnected counters.
 *
 * The root is engine-agnostic by construction: it takes no store, no socket, no
 * Raft group and no engine. An application composes it into its own health endpoint
 * and passes `reporter` to each component's `onListenerFailure` hook. Nothing here
 * starts a timer or subscribes to a signal with no producer — the watchdog stays
 * an on-demand record (see the C-06 audit), and failures arrive only when a
 * component actually swallows one.
 *
 * @module observability
 */

import { HealthProbe } from './HealthProbe';
import type { ListenerFailureReporter } from './ListenerFailureReporter';

/** Options for {@link createClusterHealth}. */
export interface ClusterHealthOptions {
  /** Time source for a failure that arrives without its own timestamp. */
  now?: () => number;
}

/** What the composition root hands back. */
export interface ClusterHealth {
  health: HealthProbe;
  reporter: ListenerFailureReporter;
}

/**
 * Build a health probe and a reporter bound to it. The reporter fills in the
 * clock when a component reports a failure without a timestamp, so a deployment
 * with its own time source gets consistent verdicts across all components.
 */
export function createClusterHealth(options: ClusterHealthOptions = {}): ClusterHealth {
  const health = new HealthProbe();
  const now = options.now ?? Date.now;
  const reporter: ListenerFailureReporter = (failure) => {
    health.recordListenerFailure(failure.source, failure.error, failure.at ?? now());
  };
  return { health, reporter };
}
