/**
 * @agentix-e/db-node — every topology-agnostic primitive, in one
 * package.
 *
 * The twenty modules below share one property and it is the property that
 * decides where code lives in this workspace: **none of them needs to know how
 * many nodes exist.** A health probe probes its own process, a circuit breaker
 * trips on its own call site, an audit store appends to its own directory, a PITR
 * chain restores its own snapshot. Anything that has to reason about a *set* of
 * nodes — which one steps down first, how many may be down at once, what a fault
 * on node 3 means for the leader — is not here, and lives in
 * `@agentix-e/db-cluster` instead.
 *
 * That boundary is why this package stayed one package. Twenty npm names for code
 * that cannot be misused without a topology would have been twenty version
 * numbers, twenty `docs/` trees and twenty release notes describing one decision:
 * "this module is node-local". A module is a directory here, and the sentence
 * that used to be a package description is now `docs/<module>/README.md`.
 *
 * Namespaced, not flattened: several modules legitimately export the same symbol
 * name (`Config`, `Probe`, `Counter`), and `export *` from twenty barrels would
 * silently drop every collision. Reach for the module:
 *
 * ```ts
 * import { KeyManager } from '@agentix-e/db-node/security';
 * import * as node from '@agentix-e/db-node';
 *
 * node.health.HealthOrchestrator;
 * ```
 */

export * as core from './core/index.js';
export * as audit from './audit/index.js';
export * as auth from './auth/index.js';
export * as autoscaler from './autoscaler/index.js';
export * as autotuner from './autotuner/index.js';
export * as backup from './backup/index.js';
export * as chaosengine from './chaosengine/index.js';
export * as circuitbreaker from './circuitbreaker/index.js';
export * as configwatcher from './configwatcher/index.js';
export * as health from './health/index.js';
export * as logger from './logger/index.js';
export * as maintenance from './maintenance/index.js';
export * as memoryguard from './memoryguard/index.js';
export * as metrics from './metrics/index.js';
export * as monitor from './monitor/index.js';
export * as observability from './observability/index.js';
export * as otel from './otel/index.js';
export * as rollingupgrade from './rollingupgrade/index.js';
export * as security from './security/index.js';
export * as slacollector from './slacollector/index.js';
