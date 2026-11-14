/**
 * InMemoryLogger.test.ts — Tests for InMemoryLogger.
 *
 * Covers: entry retention, child logger, all log levels,
 * Error object handling, maxEntries eviction, clear().
 */

import { describe, it, expect } from 'vitest';
import { InMemoryLogger } from '../impl/InMemoryLogger.js';

describe('InMemoryLogger', () => {
  it('retains entries for assertion', () => {
    const logger = new InMemoryLogger();
    logger.info('hello world');

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('hello world');
    expect(entries[0].level).toBe('info');
  });

  it('child logger inherits bindings', () => {
    const parent = new InMemoryLogger('test');
    const child = parent.child({ component: 'child-component' });

    child.info('from child');

    const entries = child.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toHaveProperty('component', 'child-component');
  });

  it('child logger add own bindings', () => {
    const parent = new InMemoryLogger('test');
    const child = parent.child({ module: 'http' });

    child.info('test');
    const entries = child.getEntries();
    expect(entries[0].context).toHaveProperty('module', 'http');
  });

  it('child logger entries merged context', () => {
    const parent = new InMemoryLogger('app');
    // Note: InMemoryLogger child starts fresh but with inherited context
    // Per the implementation, child copies parent context
    const child = parent.child({ env: 'production' });

    child.info('child message');
    const entries = child.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].component).toBe('app');
    expect(entries[0].context).toHaveProperty('env', 'production');
  });

  it('info/error/warn all log with correct level', () => {
    const logger = new InMemoryLogger();

    logger.trace('trace msg');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    logger.fatal('fatal msg');

    const entries = logger.getEntries();
    expect(entries).toHaveLength(6);
    expect(entries[0].level).toBe('trace');
    expect(entries[1].level).toBe('debug');
    expect(entries[2].level).toBe('info');
    expect(entries[3].level).toBe('warn');
    expect(entries[4].level).toBe('error');
    expect(entries[5].level).toBe('fatal');
  });

  it('error accepts Error object', () => {
    const logger = new InMemoryLogger();
    const err = new Error('something broke');

    logger.error(err);

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('error');
    expect(entries[0].error).toBeDefined();
    expect(entries[0].error!.message).toBe('something broke');
    expect(entries[0].error!.name).toBe('Error');
  });

  it('error accepts Error with message override', () => {
    const logger = new InMemoryLogger();
    const err = new Error('original message');

    logger.error(err, 'custom message');

    const entries = logger.getEntries();
    expect(entries[0].message).toBe('custom message');
    expect(entries[0].error!.message).toBe('original message');
  });

  it('error accepts context + Error', () => {
    const logger = new InMemoryLogger();
    const err = new Error('db error');

    logger.error({ db: 'primary' }, err);

    const entries = logger.getEntries();
    expect(entries[0].level).toBe('error');
    expect(entries[0].context).toHaveProperty('db', 'primary');
    expect(entries[0].error).toBeDefined();
    expect(entries[0].error!.message).toBe('db error');
  });

  it('error accepts context + Error + message', () => {
    const logger = new InMemoryLogger();
    const err = new Error('underlying error');

    logger.error({ service: 'api' }, err, 'Request failed');

    const entries = logger.getEntries();
    expect(entries[0].message).toBe('Request failed');
    expect(entries[0].context).toHaveProperty('service', 'api');
    expect(entries[0].error!.message).toBe('underlying error');
  });

  it('error accepts context + message', () => {
    const logger = new InMemoryLogger();

    logger.error({ requestId: 'abc-123' }, 'Something went wrong');

    const entries = logger.getEntries();
    expect(entries[0].level).toBe('error');
    expect(entries[0].message).toBe('Something went wrong');
    expect(entries[0].context).toHaveProperty('requestId', 'abc-123');
  });

  it('fatal accepts Error object', () => {
    const logger = new InMemoryLogger();
    const err = new Error('fatal error');

    logger.fatal(err);

    const entries = logger.getEntries();
    expect(entries[0].level).toBe('fatal');
    expect(entries[0].error!.message).toBe('fatal error');
  });

  it('respects max entries capacity', () => {
    const logger = new InMemoryLogger('test', 3);

    logger.info('entry 1');
    logger.info('entry 2');
    logger.info('entry 3');
    logger.info('entry 4');

    const entries = logger.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].message).toBe('entry 2');
    expect(entries[1].message).toBe('entry 3');
    expect(entries[2].message).toBe('entry 4');
  });

  it('clear() resets entries', () => {
    const logger = new InMemoryLogger();

    logger.info('test');
    expect(logger.getEntries()).toHaveLength(1);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('fatal level log entry', () => {
    const logger = new InMemoryLogger();

    logger.fatal({ critical: true }, 'System failure');

    const entries = logger.getEntries();
    expect(entries[0].level).toBe('fatal');
    expect(entries[0].message).toBe('System failure');
    expect(entries[0].context).toHaveProperty('critical', true);
  });

  it('trace/debug logs are recorded', () => {
    const logger = new InMemoryLogger();

    logger.trace('trace');
    logger.debug('debug');

    expect(logger.getByLevel('trace')).toHaveLength(1);
    expect(logger.getByLevel('debug')).toHaveLength(1);
  });

  it('getByLevel filters correctly', () => {
    const logger = new InMemoryLogger();

    logger.info('info1');
    logger.warn('warn1');
    logger.info('info2');

    expect(logger.getByLevel('info')).toHaveLength(2);
    expect(logger.getByLevel('warn')).toHaveLength(1);
    expect(logger.getByLevel('error')).toHaveLength(0);
  });

  it('log entries have timestamp', () => {
    const logger = new InMemoryLogger();
    logger.info('timed');

    const entry = logger.getEntries()[0];
    expect(entry.timestamp).toBeDefined();
    expect(() => new Date(entry.timestamp)).not.toThrow();
  });

  it('log entries have component', () => {
    const logger = new InMemoryLogger('my-app');
    logger.info('test');

    expect(logger.getEntries()[0].component).toBe('my-app');
  });

  it('child logger does not share entry array with parent', () => {
    const parent = new InMemoryLogger('parent');
    const child = parent.child({});

    parent.info('parent msg');
    child.info('child msg');

    expect(parent.getEntries()).toHaveLength(1);
    expect(child.getEntries()).toHaveLength(1);
  });
});
