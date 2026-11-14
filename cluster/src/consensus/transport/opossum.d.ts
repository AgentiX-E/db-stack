declare module 'opossum' {
  import { EventEmitter } from 'events';

  interface CircuitBreakerOptions {
    timeout?: number;
    maxFailures?: number;
    resetTimeout?: number;
    name?: string;
    errorThresholdPercentage?: number;
    volumeThreshold?: number;
    rollingCountTimeout?: number;
    rollingCountBuckets?: number;
    capacity?: number;
    enabled?: boolean;
    cache?: boolean;
    maxQueued?: number;
  }

  class CircuitBreaker extends EventEmitter {
    constructor(action: (...args: any[]) => Promise<any>, options?: CircuitBreakerOptions);
    fire(...args: any[]): Promise<any>;
    shutdown(): void;
    open(): void;
    close(): void;
    disable(): void;
    enable(): void;
    clearCache(): void;
    status: {
      closed: boolean;
      open: boolean;
      halfOpen: boolean;
      stats: { failures: number; successes: number; latencyTimes: number[] };
    };
    stats: { failures: number; successes: number; latencyMean: number; latencyTimes: number[] };
    on(
      event: 'open' | 'close' | 'halfOpen' | 'failure' | 'reject' | 'success' | 'timeout',
      handler: (...args: any[]) => void,
    ): this;
    name: string;
    enabled: boolean;
    isOurError: (err: any) => boolean;
  }

  export = CircuitBreaker;
}
