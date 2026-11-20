import type { CircuitState, CircuitBreakerConfig } from './types.js';

export type { CircuitState, CircuitBreakerConfig };

export interface ICircuitBreaker {
  readonly name: string;
  getState(): CircuitState;
  call<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T>;
  onSuccess(): void;
  onFailure(): void;
  reset(): void;
}
