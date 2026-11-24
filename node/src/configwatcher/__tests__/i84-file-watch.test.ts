/**
 * Iteration 84 — `_loadFiles()` reads the directory.
 *
 * The watcher shipped for a release with a `startFileWatch()` that armed an
 * interval, reported `fileWatchActive: true`, and read nothing: `_loadFiles()`
 * was a comment. Every case here fails against that: the store stays empty, and
 * `getStats().fileWatch` does not exist to ask.
 *
 * Timers are driven, not waited for. A debounce test that sleeps is a test whose
 * verdict depends on how busy the machine is.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigWatcher } from '../impl/ConfigWatcher.js';

let dir: string;

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfw84-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('FW: the file half reads what it watches', () => {
  it('FW.1 — a JSON file reaches the store, and says it came from a file', () => {
    const path = write('app.json', '{"poolSize": 8, "mode": "fast"}');
    const watcher = new ConfigWatcher();
    const seen: Array<{ key: string; source: string; value: unknown }> = [];
    watcher.watch('poolSize', (event) => seen.push({ key: event.key, source: event.source, value: event.newValue }));

    watcher.startFileWatch({ paths: [path] });

    expect(watcher.snapshot()).toEqual({ poolSize: 8, mode: 'fast' });
    expect(seen).toEqual([{ key: 'poolSize', source: 'file_watch', value: 8 }]);
    watcher.stopFileWatch();
  });

  it('FW.2 — stats say which files were read, how often, and how many keys', () => {
    const path = write('app.json', '{"a": 1, "b": 2}');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    const fileWatch = watcher.getStats().fileWatch;
    expect(fileWatch).not.toBeNull();
    expect(fileWatch?.paths).toEqual([path]);
    expect(fileWatch?.loads).toBe(1);
    expect(fileWatch?.files).toEqual([
      {
        path,
        format: 'json',
        keys: 2,
        loads: 1,
        lastLoadedAt: expect.any(Number) as unknown as number,
        failure: null,
      },
    ]);
    watcher.stopFileWatch();
  });

  it('FW.3 — a rewrite within one poll is applied on the next poll', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    write('app.json', '{"a": 2}');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ a: 2 });
    expect(watcher.getStats().fileWatch?.loads).toBe(2);
    watcher.stopFileWatch();
  });

  it('FW.4 — a poll that reads the same bytes is not a load', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    // Same content, different whitespace: canonical comparison, not bytes.
    write('app.json', '{ "a": 1 }');
    vi.advanceTimersByTime(100);

    expect(watcher.getStats().fileWatch?.loads).toBe(1);
    expect(watcher.getStats().reloadCount).toBe(1);
    watcher.stopFileWatch();
  });

  it('FW.5 — a key the file drops is removed from the store', () => {
    const path = write('app.json', '{"a": 1, "b": 2}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    write('app.json', '{"a": 1}');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ a: 1 });
    watcher.stopFileWatch();
  });

  it('FW.6 — a key the caller has since overwritten is not removed by a poll', () => {
    const path = write('app.json', '{"a": 1, "b": 2}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    // The operator takes ownership of `b`; the file no longer mentions it.
    void watcher.set('b', 99);
    write('app.json', '{"a": 1}');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ a: 1, b: 99 });
    watcher.stopFileWatch();
  });

  it('FW.7 — a .env file is parsed by its own rules: numbers, flags, quotes, comments', () => {
    const path = write(
      'app.env',
      ['# a comment', 'PORT=8080', 'DEBUG=true', 'NAME="8080"', 'EMPTY=', 'NOTHING=null', ''].join('\n'),
    );
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.snapshot()).toEqual({ PORT: 8080, DEBUG: true, NAME: '8080', EMPTY: '', NOTHING: null });
    watcher.stopFileWatch();
  });
});

describe('FW: a file that cannot be read is reported, not skipped', () => {
  it('FW.8 — a missing file is a named failure, and appears when it is created', () => {
    const path = join(dir, 'later.json');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    expect(watcher.getStats().fileWatch?.files[0]?.failure).toMatch(/ENOENT/);
    expect(watcher.snapshot()).toEqual({});

    write('later.json', '{"a": 1}');
    vi.advanceTimersByTime(10);

    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBeNull();
    expect(watcher.snapshot()).toEqual({ a: 1 });
    watcher.stopFileWatch();
  });

  it('FW.9 — malformed JSON keeps the last good values and names the parse error', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    write('app.json', '{"a": ');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ a: 1 });
    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBeTruthy();
    watcher.stopFileWatch();
  });

  it('FW.10 — a format with no parser says so, and says what to pass', () => {
    const path = write('app.yaml', 'a: 1\n');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBe(
      `no parser for "yaml" ("${path}"); this package ships json and env, pass parsers.yaml`,
    );
    watcher.stopFileWatch();
  });

  it('FW.11 — a supplied parser is used, so yaml works without a dependency', () => {
    const path = write('app.yaml', 'a: 1\n');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({
      paths: [path],
      parsers: {
        yaml: (text) =>
          Object.fromEntries(
            text
              .split('\n')
              .filter((line) => line.includes(':'))
              .map((line) => {
                const [key = '', value = ''] = line.split(':');
                return [key.trim(), Number(value.trim())];
              }),
          ),
      },
    });

    expect(watcher.snapshot()).toEqual({ a: 1 });
    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBeNull();
    watcher.stopFileWatch();
  });

  it('FW.12 — an extension nothing knows is a failure, not a silent skip', () => {
    const path = write('app.conf', 'a=1');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.getStats().fileWatch?.files[0]?.format).toBeNull();
    expect(watcher.getStats().fileWatch?.files[0]?.failure).toContain('no format');
    watcher.stopFileWatch();
  });

  it('FW.13 — a document that is not an object is refused by name', () => {
    const path = write('app.json', '[1, 2, 3]');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.getStats().fileWatch?.files[0]?.failure).toContain('is not an object');
    expect(watcher.snapshot()).toEqual({});
    watcher.stopFileWatch();
  });

  it('FW.18 — a .env line that is not KEY=value is a failure with the line in it', () => {
    const path = write('app.env', 'GOOD=1\nthis is not a pair\n');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBe('"this is not a pair" is not KEY=value');
    watcher.stopFileWatch();
  });

  it('FW.19 — a list is compared by its contents, not by the whitespace it was written with', () => {
    const path = write('app.json', '{"hosts": ["a", "b"]}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    write('app.json', '{"hosts":["a","b"]}');
    vi.advanceTimersByTime(50);
    expect(watcher.getStats().fileWatch?.loads).toBe(1);

    write('app.json', '{"hosts":["a","b","c"]}');
    vi.advanceTimersByTime(10);
    expect(watcher.snapshot()).toEqual({ hosts: ['a', 'b', 'c'] });
    watcher.stopFileWatch();
  });
});

describe('FW: a reload the schema refuses does not take effect', () => {
  it('FW.20 — a key the schema requires cannot be dropped by editing the file', () => {
    const path = write('app.json', '{"required": 1}');
    const watcher = new ConfigWatcher();
    watcher.registerSchema({ required: { type: 'number' } });
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });
    expect(watcher.snapshot()).toEqual({ required: 1 });

    write('app.json', '{}');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ required: 1 });
    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBe('read, but refused: required does not validate');
    // The baseline did not move, so the next poll tries again rather than
    // accepting a file that never took effect.
    expect(watcher.getStats().fileWatch?.loads).toBe(1);
    watcher.stopFileWatch();
  });

  it('FW.21 — a value the schema refuses leaves the previous value in place', () => {
    const path = write('app.json', '{"port": 1}');
    const watcher = new ConfigWatcher();
    watcher.registerSchema({ port: { type: 'number' } });
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10 });

    write('app.json', '{"port": "not-a-number"}');
    vi.advanceTimersByTime(10);

    expect(watcher.snapshot()).toEqual({ port: 1 });
    expect(watcher.getStats().fileWatch?.files[0]?.failure).toBe('read, but refused: port does not validate');
    watcher.stopFileWatch();
  });
});

describe('FW: the debounce window', () => {
  it('FW.14 — a write waits out the window before it is applied', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10, debounceMs: 200 });

    // The initial read waits out the window too: a half-written file at startup
    // is the same hazard as one at any other time.
    expect(watcher.snapshot()).toEqual({});
    vi.advanceTimersByTime(200);
    expect(watcher.snapshot()).toEqual({ a: 1 });

    write('app.json', '{"a": 2}');
    vi.advanceTimersByTime(60);
    expect(watcher.snapshot()).toEqual({ a: 1 });

    vi.advanceTimersByTime(200);
    expect(watcher.snapshot()).toEqual({ a: 2 });
    watcher.stopFileWatch();
  });

  it('FW.15 — a file written faster than its window is applied once the cap is passed', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10, debounceMs: 500, maxChangesPerWindow: 1 });
    vi.advanceTimersByTime(500);

    write('app.json', '{"a": 2}');
    vi.advanceTimersByTime(10);
    write('app.json', '{"a": 3}');
    vi.advanceTimersByTime(10);
    // Two writes absorbed: the second exceeds the tolerance, so the reload is
    // applied now rather than postponed for another half second.
    expect(watcher.snapshot()).toEqual({ a: 3 });

    watcher.stopFileWatch();
  });

  it('FW.16 — stopping the watch cancels a reload that is still waiting', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    vi.useFakeTimers();
    watcher.startFileWatch({ paths: [path], pollIntervalMs: 10, debounceMs: 100 });
    vi.advanceTimersByTime(100);

    write('app.json', '{"a": 2}');
    vi.advanceTimersByTime(10);
    watcher.stopFileWatch();
    vi.advanceTimersByTime(1_000);

    expect(watcher.snapshot()).toEqual({ a: 1 });
    expect(watcher.getStats().fileWatch).toBeNull();
  });

  it('FW.17 — the watch can be restarted, and starts from what is on disk', () => {
    const path = write('app.json', '{"a": 1}');
    const watcher = new ConfigWatcher();
    watcher.startFileWatch({ paths: [path] });
    watcher.stopFileWatch();

    write('app.json', '{"a": 7}');
    watcher.startFileWatch({ paths: [path] });

    expect(watcher.snapshot()).toEqual({ a: 7 });
    expect(watcher.getStats().fileWatch?.loads).toBe(1);
    watcher.stopFileWatch();
  });
});
