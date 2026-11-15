/**
 * test-utils — the port and temp-directory helpers every cluster harness
 * builds on.
 *
 * These are published through `@agentix-e/db-cluster/testing`, so the
 * guarantees a downstream harness relies on are asserted here: a returned port
 * can actually be bound, reserved ports do not collide, temporary directories
 * are isolated, and cleanup never fails a run.
 */

import { describe, it, expect } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFreePort, getFreePorts, createTempDir, cleanupTempDir } from '../../testing/test-utils';

function bind(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('getFreePort', () => {
  it('returns a port the caller can bind', async () => {
    const port = await getFreePort();

    const server = await bind(port);
    await close(server);
    expect(port).toBeGreaterThan(0);
  });
});

describe('getFreePorts', () => {
  it('reserves the requested number of distinct ports', async () => {
    const ports = await getFreePorts(4);

    expect(ports).toHaveLength(4);
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) expect(port).toBeGreaterThan(0);
  });

  it('reserves nothing when asked for nothing', async () => {
    expect(await getFreePorts(0)).toEqual([]);
  });
});

describe('createTempDir', () => {
  it('creates a fresh existing directory for every call', () => {
    const first = createTempDir('unit');
    const second = createTempDir('unit');

    try {
      expect(fs.statSync(first).isDirectory()).toBe(true);
      expect(fs.statSync(second).isDirectory()).toBe(true);
      expect(first).not.toBe(second);
      expect(path.dirname(first)).toBe(os.tmpdir());
      expect(path.basename(first).startsWith('raft-test-unit-')).toBe(true);
    } finally {
      cleanupTempDir(first);
      cleanupTempDir(second);
    }
  });
});

describe('cleanupTempDir', () => {
  it('removes a directory together with its contents', () => {
    const dir = createTempDir('cleanup');
    fs.mkdirSync(path.join(dir, 'node-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node-1', 'raft.db'), 'log');

    cleanupTempDir(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('is a no-op for a directory that is already gone', () => {
    const dir = createTempDir('cleanup-missing');
    cleanupTempDir(dir);

    expect(() => cleanupTempDir(dir)).not.toThrow();
  });

  it('does not fail a run when the path cannot be removed', () => {
    // A path below a regular file can never be removed (ENOTDIR). Cleanup is
    // best-effort by contract, so a leaked directory must not surface here.
    const dir = createTempDir('cleanup-unremovable');
    const file = path.join(dir, 'not-a-directory');
    fs.writeFileSync(file, 'x');

    try {
      expect(() => cleanupTempDir(path.join(file, 'nested'))).not.toThrow();
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
