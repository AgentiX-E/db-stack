/**
 * @agentix-e/db-operations — umbrella entry point.
 *
 * The framework is delivered as three packages, split by the question each one
 * answers:
 *
 *   - `@agentix-e/db-operations-node` — twenty modules whose implementation does
 *     not need to know how many nodes exist. A probe probes its own process, a
 *     breaker trips on its own call site, an audit store appends to its own
 *     directory.
 *   - `@agentix-e/db-operations-cluster` — the code that has to reason about a
 *     *set* of nodes: which one is removed first, how many may be out at once
 *     without losing quorum, what a fault on node 3 means for the leader.
 *   - `@agentix-e/db-operations-federation` — the cross-datacenter binding:
 *     `FederatedNode` and `FederatedQueryRouter`.
 *
 * The umbrella re-exports each *module* under its own namespace rather than
 * re-exporting the three packages, so that `operations.health` keeps naming the
 * same object it named before the split. Several modules legitimately use the
 * same exported symbol names (`Counter`, `Probe`, `Config`); flattening them into
 * a single module scope would create collisions and silently drop APIs, so each
 * module keeps its own namespace.
 *
 * A consumer whose dependency graph should say what it uses imports the package
 * it actually uses — `@agentix-e/db-operations-node/health` — and not this
 * barrel.
 */

export * as core from '@agentix-e/db-operations-node/core';
export * as audit from '@agentix-e/db-operations-node/audit';
export * as auth from '@agentix-e/db-operations-node/auth';
export * as autoscaler from '@agentix-e/db-operations-node/autoscaler';
export * as autotuner from '@agentix-e/db-operations-node/autotuner';
export * as backup from '@agentix-e/db-operations-node/backup';
export * as chaosengine from '@agentix-e/db-operations-node/chaosengine';
export * as circuitbreaker from '@agentix-e/db-operations-node/circuitbreaker';
export * as configwatcher from '@agentix-e/db-operations-node/configwatcher';
export * as health from '@agentix-e/db-operations-node/health';
export * as logger from '@agentix-e/db-operations-node/logger';
export * as maintenance from '@agentix-e/db-operations-node/maintenance';
export * as memoryguard from '@agentix-e/db-operations-node/memoryguard';
export * as metrics from '@agentix-e/db-operations-node/metrics';
export * as monitor from '@agentix-e/db-operations-node/monitor';
export * as observability from '@agentix-e/db-operations-node/observability';
export * as otel from '@agentix-e/db-operations-node/otel';
export * as rollingupgrade from '@agentix-e/db-operations-node/rollingupgrade';
export * as security from '@agentix-e/db-operations-node/security';
export * as slacollector from '@agentix-e/db-operations-node/slacollector';
export * as cluster from '@agentix-e/db-operations-cluster';
export * as federation from '@agentix-e/db-operations-federation';

/**
 * Framework version.
 *
 * This was `1.1.0` while the manifest said `1.11.3`, under a comment claiming
 * the two were kept in sync "at release time" — and nothing in the repository
 * read the constant or rewrote it, so the claim described a mechanism that did
 * not exist. It is asserted against `package.json` by `AC 79.8`; a version
 * constant nobody compares to the manifest is a number that drifts and a
 * deployment that cannot answer "which build am I running".
 */
export const DB_OPERATIONS_VERSION = '2.0.0';
