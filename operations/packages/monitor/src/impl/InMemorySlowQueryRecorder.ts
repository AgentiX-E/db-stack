/**
 * InMemorySlowQueryRecorder — ISlowQueryRecorder implementation.
 *
 * Stores slow query entries in a circular buffer (max 1000 entries).
 * Only records queries that exceed the configured threshold.
 *
 * @module @agentix-e/db-operations-monitor/impl
 */

import type { SlowQueryRecord, QueryPattern } from '../interfaces/index.js';

interface InternalEntry {
  query: string;
  durationMs: number;
  startTime: string;
  actor?: string;
  shardId?: string;
}

/**
 * In-memory slow query recorder with circular buffer eviction.
 */
export class InMemorySlowQueryRecorder {
  private readonly _maxEntries: number;
  private _entries: InternalEntry[] = [];
  private _thresholdMs: number;
  private _count = 0;

  constructor(thresholdMs = 100, maxEntries = 1000) {
    this._thresholdMs = thresholdMs;
    this._maxEntries = maxEntries;
  }

  /**
   * Record a slow query. Only stores if durationMs >= thresholdMs.
   */
  record(query: SlowQueryRecord): Promise<void> {
    if (query.durationMs >= this._thresholdMs) {
      const entry: InternalEntry = {
        query: query.query,
        durationMs: query.durationMs,
        startTime: query.timestamp.toISOString(),
        actor: query.user,
        shardId: query.database,
      };

      if (this._entries.length >= this._maxEntries) {
        this._entries.shift();
      }
      this._entries.push(entry);
      this._count++;
    }
    return Promise.resolve();
  }

  /**
   * Get slow queries exceeding a threshold duration.
   */
  getSlowQueries(thresholdMs: number): Promise<SlowQueryRecord[]> {
    const result = this._entries
      .filter(e => e.durationMs >= thresholdMs)
      .map(e => ({
        query: e.query,
        durationMs: e.durationMs,
        timestamp: new Date(e.startTime),
        database: e.shardId ?? 'default',
        user: e.actor,
      }));
    return Promise.resolve(result);
  }

  /**
   * Analyze query patterns to detect anomalies.
   */
  analyzePatterns(): Promise<QueryPattern[]> {
    const patternMap = new Map<string, { durations: number[]; lastSeen: Date }>();
    for (const entry of this._entries) {
      const simplified = entry.query.replace(/\s+/g, ' ').trim();
      const existing = patternMap.get(simplified);
      if (existing) {
        existing.durations.push(entry.durationMs);
        if (new Date(entry.startTime) > existing.lastSeen) {
          existing.lastSeen = new Date(entry.startTime);
        }
      } else {
        patternMap.set(simplified, {
          durations: [entry.durationMs],
          lastSeen: new Date(entry.startTime),
        });
      }
    }

    const patterns: QueryPattern[] = [];
    for (const [pattern, data] of patternMap) {
      const avg = data.durations.reduce((a, b) => a + b, 0) / data.durations.length;
      patterns.push({
        pattern,
        averageDurationMs: Math.round(avg),
        count: data.durations.length,
        lastSeen: data.lastSeen,
      });
    }
    return Promise.resolve(patterns);
  }

  /**
   * Get recent slow queries from the buffer.
   */
  getRecentSlowQueries(limit?: number): SlowQueryRecord[] {
    const entries = limit ? this._entries.slice(-limit) : [...this._entries];
    return entries.map(e => ({
      query: e.query,
      durationMs: e.durationMs,
      timestamp: new Date(e.startTime),
      database: e.shardId ?? 'default',
      user: e.actor,
      rowsExamined: undefined,
      rowsSent: undefined,
    }));
  }

  /**
   * Get the total count of recorded slow queries (including evicted).
   */
  getSlowQueryCount(): number {
    return this._count;
  }

  /**
   * Set the threshold in milliseconds.
   */
  setThreshold(ms: number): void {
    this._thresholdMs = ms;
  }

  /**
   * Get the current threshold in milliseconds.
   */
  getThreshold(): number {
    return this._thresholdMs;
  }

  /**
   * Clear all entries and reset count.
   */
  clear(): void {
    this._entries = [];
    this._count = 0;
  }
}
