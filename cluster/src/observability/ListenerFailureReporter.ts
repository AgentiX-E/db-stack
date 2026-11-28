/**
 * ListenerFailureReporter — the channel from a swallowed callback to a verdict.
 *
 * Four cluster components call user-supplied listeners inside `try`/`catch` and
 * swallow the exception so one bad callback cannot abort the host operation
 * (C-04). That isolation is correct; losing the failure is not. Until now the
 * `catch {}` was the end of the story, so a listener that had been throwing for
 * an hour left no trace in the node's health.
 *
 * This module is the missing half, and it is deliberately engine-agnostic: a
 * reporter is a plain function `(failure) => void`. It knows nothing about
 * storage, transport, Raft or any engine. A component that invokes a listener
 * takes an optional reporter; when absent, the default is inert and every
 * existing construction site keeps its exact behaviour. A composition root that
 * owns a `HealthProbe` wires `createHealthFailureReporter`, and a thrown listener
 * then degrades readiness with the component's name attached.
 *
 * Nothing here imports a store or a foreign package layer. `cluster` stays
 * independent of `node` and `federation`.
 *
 * @module observability
 */

import type { HealthProbe } from './HealthProbe';

/** The shape every reporting site hands to the channel. */
export interface ListenerFailureEvent {
  /** Name of the component whose listener threw, e.g. `WatchApi.handler`. */
  source: string;
  /** The thrown value, whatever it was — a caught error is not always an Error. */
  error?: unknown;
  /** When it happened, so a verdict can age the failure if it wants to. */
  at?: number;
}

/** An engine-agnostic sink for a swallowed listener exception. */
export type ListenerFailureReporter = (failure: ListenerFailureEvent) => void;

/**
 * The default: report nothing. Kept as a named, exported value so a test can
 * assert the inert path without constructing a component around it.
 */
export const ignoreListenerFailure: ListenerFailureReporter = () => {};

/**
 * Adapt a `HealthProbe` into a reporter. A failure becomes a recorded listener
 * failure, which `readiness()` surfaces as degraded. The adapter is the only
 * place that knows about `HealthProbe`, so every reporting site stays agnostic.
 */
export function createHealthFailureReporter(health: HealthProbe): ListenerFailureReporter {
  return (failure) => {
    health.recordListenerFailure(failure.source, failure.error, failure.at);
  };
}
