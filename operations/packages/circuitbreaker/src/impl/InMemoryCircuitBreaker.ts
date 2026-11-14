import type { ICircuitBreaker } from '../interfaces/index.js';
import type { CircuitState, CircuitBreakerConfig } from '../interfaces/types.js';

export class InMemoryCircuitBreaker implements ICircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private callCount = 0;
  private config: CircuitBreakerConfig;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      successThreshold: config?.successThreshold ?? 2,
      timeoutMs: config?.timeoutMs ?? 30000,
    };
  }

  getState(): CircuitState {
    if (
      this.state === 'open'
      && this.config.timeoutMs > 0
      && Date.now() - this.lastFailureTime >= this.config.timeoutMs
    ) {
      this.state = 'half-open';
    }
    return this.state;
  }

  async call<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    this.callCount++;

    if (currentState === 'open') {
      if (fallback) return fallback();
      throw new Error(`Circuit breaker '${this.name}' is OPEN`);
    }

    try {
      const result = await fn();
      if (currentState === 'half-open') {
        this.onSuccess();
      }
      return result;
    } catch (err) {
      this.onFailure();
      if (fallback) return fallback();
      throw err;
    }
  }

  onSuccess(): void {
    if (this.state === 'half-open') {
      this.failureCount = 0;
      this.state = 'closed';
    } else if (this.state === 'closed') {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.callCount = 0;
  }
}
