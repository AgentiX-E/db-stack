/**
 * @agentix-e/db-operations — umbrella entry point.
 *
 * The framework is delivered as 21 focused packages. This entry re-exports
 * every package under a stable namespace so consumers can either:
 *
 *   1. depend on the umbrella and reach for `operations.health`,
 *      `operations.backup`, ... — convenient when several domains are used;
 *   2. depend on the individual package (`@agentix-e/db-operations-health`)
 *      to keep the dependency graph (and bundle) minimal.
 *
 * Namespaced re-exports are intentional: several packages legitimately use
 * the same exported symbol names (e.g. `Counter`, `Probe`, `Config`).
 * Flattening them into a single module scope would create collisions and
 * silently drop APIs, so each package keeps its own namespace.
 */

export * as core from '@agentix-e/db-operations-core';
export * as health from '@agentix-e/db-operations-health';
export * as logger from '@agentix-e/db-operations-logger';
export * as metrics from '@agentix-e/db-operations-metrics';
export * as monitor from '@agentix-e/db-operations-monitor';
export * as backup from '@agentix-e/db-operations-backup';
export * as maintenance from '@agentix-e/db-operations-maintenance';
export * as auth from '@agentix-e/db-operations-auth';
export * as security from '@agentix-e/db-operations-security';
export * as audit from '@agentix-e/db-operations-audit';
export * as observability from '@agentix-e/db-operations-observability';
export * as otel from '@agentix-e/db-operations-otel';
export * as autotuner from '@agentix-e/db-operations-autotuner';
export * as autoscaler from '@agentix-e/db-operations-autoscaler';
export * as chaosengine from '@agentix-e/db-operations-chaosengine';
export * as circuitbreaker from '@agentix-e/db-operations-circuitbreaker';
export * as configwatcher from '@agentix-e/db-operations-configwatcher';
export * as memoryguard from '@agentix-e/db-operations-memoryguard';
export * as rollingupgrade from '@agentix-e/db-operations-rollingupgrade';
export * as slacollector from '@agentix-e/db-operations-slacollector';
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
export const DB_OPERATIONS_VERSION = '1.11.3';
