/**
 * NoopLogger — the null object of ILogger.
 *
 * Contract: every level accepts every documented overload shape, emits nothing
 * and returns nothing; `child()` keeps returning a silent logger. Call sites
 * use it as a fallback so they never have to null-check a logger, which only
 * holds if no call shape throws or writes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NoopLogger } from '../impl/NoopLogger.js';

describe('NoopLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes one shared INSTANCE that is itself a NoopLogger', () => {
    expect(NoopLogger.INSTANCE).toBeInstanceOf(NoopLogger);
    expect(NoopLogger.INSTANCE).toBe(NoopLogger.INSTANCE.child({ service: 'backup' }));
  });

  it('child() returns the same silent logger instead of a new one', () => {
    const parent = new NoopLogger();
    const child = parent.child({ requestId: 'req-1', shard: 3 });

    expect(child).toBe(parent);
    expect(child.info({ requestId: 'req-1' }, 'still discarded')).toBeUndefined();
  });

  it('returns nothing from every level in every documented overload shape', () => {
    const logger = new NoopLogger();
    const failure = new Error('boom');

    const results = [
      logger.trace('trace'),
      logger.trace({ attempt: 1 }, 'trace with context'),
      logger.trace('trace with trailing context', { attempt: 1 }),
      logger.debug('debug'),
      logger.debug({ attempt: 1 }, 'debug with context'),
      logger.debug('debug with trailing context', { attempt: 1 }),
      logger.info('info'),
      logger.info({ attempt: 1 }, 'info with context'),
      logger.info('info with trailing context', { attempt: 1 }),
      logger.warn('warn'),
      logger.warn({ attempt: 1 }, 'warn with context'),
      logger.warn('warn with trailing context', { attempt: 1 }),
      logger.error('error'),
      logger.error({ attempt: 1 }, 'error with context'),
      logger.error('error with trailing context', { attempt: 1 }),
      logger.error(failure),
      logger.error(failure, 'error with cause'),
      logger.error({ attempt: 1 }, failure, 'error with context and cause'),
      logger.fatal('fatal'),
      logger.fatal({ attempt: 1 }, 'fatal with context'),
      logger.fatal('fatal with trailing context', { attempt: 1 }),
      logger.fatal(failure),
      logger.fatal(failure, 'fatal with cause'),
      logger.fatal({ attempt: 1 }, failure, 'fatal with context and cause'),
    ];

    expect(results).toHaveLength(24);
    expect(results.every((result) => result === undefined)).toBe(true);
  });

  it('writes nothing to any console channel at any level', () => {
    const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = channels.map((channel) => vi.spyOn(console, channel).mockImplementation(() => {}));
    const logger = new NoopLogger();

    logger.trace('trace');
    logger.debug('debug');
    logger.info({ shard: 1 }, 'info');
    logger.warn('warn', { shard: 1 });
    logger.error(new Error('boom'), 'error');
    logger.fatal({ shard: 1 }, new Error('boom'), 'fatal');
    logger.child({ shard: 2 }).info('from a child');

    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
