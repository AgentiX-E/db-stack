export type { IHealthProbe, ProbeAnswer } from './interfaces/IHealthProbe.js';
export type { IComponentRegistrar } from './interfaces/IComponentRegistrar.js';
export type { IHealthOrchestrator } from './interfaces/IHealthOrchestrator.js';
export type {
  ComponentRegistrationOptions,
  FunctionalChecks,
  FunctionalCheckResult,
} from './interfaces/IComponentRegistrar.js';

export { componentProbe } from './impl/ComponentProbe.js';
export { HealthOrchestrator, DEFAULT_PROBE_TIMEOUT_MS } from './impl/HealthOrchestrator.js';
export type { HealthOrchestratorOptions } from './impl/HealthOrchestrator.js';
export { settleWithin, ProbeTimeoutError, systemTimer } from './impl/ProbeTimeout.js';
export type { ProbeTimer } from './impl/ProbeTimeout.js';
