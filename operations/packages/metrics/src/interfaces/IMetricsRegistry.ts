/**
 * IMetricsRegistry — Metrics interface for counters, gauges, histograms.
 *
 * Inspired by Prometheus client API but engine-agnostic.
 * Supports labels / tags for dimensional analysis.
 *
 * @module @agentix-e/db-operations-metrics/interfaces
 */

import type { MetricsSnapshot } from '@agentix-e/db-operations-core/types';

/** Counter metric — monotonically increasing. */
export interface ICounter {
  /** Increment by 1. */
  inc(): void;
  /** Increment by an arbitrary non-negative value. */
  incBy(value: number): void;
  /** Reset to zero (use with caution — only for well-defined scopes). */
  reset(): void;
  /** Get the current value. */
  get(): number;
}

/** Gauge metric — up/down value. */
export interface IGauge {
  /** Set to an absolute value. */
  set(value: number): void;
  /** Increment by 1. */
  inc(): void;
  /** Decrement by 1. */
  dec(): void;
  /** Increment by an arbitrary value (can be negative). */
  add(value: number): void;
  /** Get the current value. */
  get(): number;
}

/** Histogram / Summary metric — latency or size distributions. */
export interface IHistogram {
  /** Observe a value (adds to the distribution). */
  observe(value: number): void;
  /** Get the current count of observations. */
  getCount(): number;
  /** Get the total sum of all observations. */
  getSum(): number;
  /** Get approximate quantile (0.0–1.0). */
  getQuantile(p: number): number | undefined;
  /** Reset the histogram. */
  reset(): void;
}

/**
 * Metrics registry — creates and manages metric instances.
 */
export interface IMetricsRegistry {
  /**
   * Create or retrieve a counter.
   *
   * @param name - Metric name (snake_case).
   * @param labels - Optional label pairs.
   */
  counter(name: string, labels?: Record<string, string>): ICounter;

  /**
   * Create or retrieve a gauge.
   *
   * @param name - Metric name (snake_case).
   * @param labels - Optional label pairs.
   */
  gauge(name: string, labels?: Record<string, string>): IGauge;

  /**
   * Create or retrieve a histogram.
   *
   * @param name - Metric name (snake_case).
   * @param labels - Optional label pairs.
   * @param buckets - Bucket boundaries for the histogram.
   */
  histogram(name: string, labels?: Record<string, string>, buckets?: number[]): IHistogram;

  /**
   * Take a snapshot of all metrics.
   */
  snapshot(): MetricsSnapshot;
}
