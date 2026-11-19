/**
 * @agentix-e/db-federation/testing — instruments for exercising a CDC sink.
 *
 * Published (not test-only) because the delivery rules this package promises —
 * a change reaches a sink once, in order, and a refusal is retried then
 * recorded — are only checkable by a consumer who can make their own sink
 * misbehave. `CDCFailureInjector` is the instrument that does it: it wraps any
 * `ICDCSink` and fires the faults it is told to, deterministically or
 * probabilistically, counting each one against its own budget.
 *
 * Nothing here is on the replication path. A deployment imports this module in
 * its test suite, never in its runtime.
 */

export { CDCFailureInjector } from './CDCFailureInjector';
export type { FailureConfig, FailureType, InjectionPoint } from './CDCFailureInjector';
