export type { IHealthProbe, ProbeAnswer } from './interfaces/IHealthProbe.js';
export type { IComponentRegistrar } from './interfaces/IComponentRegistrar.js';
export type { IHealthOrchestrator } from './interfaces/IHealthOrchestrator.js';
export type {
  ComponentRegistrationOptions,
  FunctionalChecks,
  FunctionalCheckResult,
} from './interfaces/IComponentRegistrar.js';

export { componentProbe } from './impl/ComponentProbe.js';
export { HealthOrchestrator } from './impl/HealthOrchestrator.js';
