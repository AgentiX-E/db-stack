/**
 * Port allocation, tested as a primitive.
 *
 * Why this file exists
 * --------------------
 * `getFreePort` asked the OS for a free port: bind, read the number, close. The
 * answer is "free *now*", and the next caller is offered the same port — which is
 * how `raft-multishard` failed on CI-shaped parallelism with
 * `EADDRINUSE: address already in use 127.0.0.1:46315` while six of its own nodes
 * were still binding. Every test file in one process shares that window, and a suite
 * with dozens of clusters opens it dozens of times.
 *
 * The lease is a file created with `wx`, which fails atomically for the second
 * claimant, so the port is exclusive for the run and the directory is keyed by pid —
 * the thread pool workers share a pid, a later run does not.
 *
 * Acceptance criteria:
 *   AC 52.1  a port can be claimed once, and the second claim is refused
 *   AC 52.2  claims are independent per port
 *   AC 52.3  a released port can be claimed again
 *   AC 52.4  releasing a port nobody claimed is not an error
 *   AC 52.5  allocation never returns the same port twice, which is the defect
 *   AC 52.6  the lease directory is the process's, so workers in one run share it
 *   AC 52.7  a lease directory left by an older run is swept; a recent one is left alone
 *   AC 52.8  a sweep that cannot read its directory is housekeeping, not a failure
 *   AC 52.9  allocation gives up with a named error when every answer is already claimed
 *   AC 52.10 the lease base honours `DBSTACK_PORT_LEASE_DIR`, because the harness
 *            redirects `TMPDIR` per worker thread
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PortLeases, getFreePort, getFreePorts } from '../../testing/test-utils';

function scratchDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `port-leases-${name}-`));
}

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PortLeases', () => {
  it('AC 52.1 — a port can be claimed once, and the second claim is refused', () => {
    const dir = scratchDir('claim');
    created.push(dir);
    const leases = new PortLeases(dir);

    expect(leases.claim(20001)).toBe(true);
    expect(leases.claim(20001)).toBe(false);
  });

  it('AC 52.2 — claims are independent per port', () => {
    const dir = scratchDir('independent');
    created.push(dir);
    const leases = new PortLeases(dir);

    expect(leases.claim(20010)).toBe(true);
    expect(leases.claim(20011)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['20010', '20011']);
  });

  it('AC 52.3 — a released port can be claimed again', () => {
    const dir = scratchDir('release');
    created.push(dir);
    const leases = new PortLeases(dir);

    leases.claim(20020);
    leases.release(20020);
    expect(leases.claim(20020)).toBe(true);
  });

  it('AC 52.4 — releasing a port nobody claimed is not an error', () => {
    const dir = scratchDir('idempotent');
    created.push(dir);
    const leases = new PortLeases(dir);

    expect(() => leases.release(20030)).not.toThrow();
    leases.claim(20030);
    leases.releaseAll();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('AC 52.7 — a lease directory left by an older run is swept; a recent one is left alone', () => {
    const tmpRoot = scratchDir('sweep');
    created.push(tmpRoot);
    const stale = path.join(tmpRoot, 'db-stack-ports-999901');
    const recent = path.join(tmpRoot, 'db-stack-ports-999902');
    fs.mkdirSync(stale);
    fs.mkdirSync(recent);
    const dayAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, dayAgo, dayAgo);

    // A third directory, so `mine` is neither of the two under test.
    const leases = new PortLeases(path.join(tmpRoot, 'db-stack-ports-mine'), tmpRoot);
    expect(leases.claim(20050)).toBe(true);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('AC 52.8 — a sweep that cannot read its directory is housekeeping, not a failure', () => {
    // /tmp may be unreadable in a hardened container. A lease still has to work.
    const dir = scratchDir('unreadable');
    created.push(dir);
    const leases = new PortLeases(dir, path.join(os.tmpdir(), 'does-not-exist-sweep'));

    expect(leases.claim(20060)).toBe(true);
  });

  it('AC 52.9 — allocation gives up with a named error when every answer is already claimed', async () => {
    const alwaysTaken = { claim: () => false };

    await expect(getFreePort(2, alwaysTaken)).rejects.toThrow(/no unleased free port after 2 attempts/);
  });

  it('AC 52.5 — allocation never returns the same port twice', async () => {
    // The defect, directly: fifty simultaneous allocations used to be fifty
    // independent answers from the OS with nothing preventing a repeat.
    const ports = await getFreePorts(50);

    expect(new Set(ports).size).toBe(50);
    expect(ports.every((port) => port > 0)).toBe(true);
  });

  it('AC 52.6 — the lease directory is the process’s, so workers in one run share it', () => {
    // Thread-pool workers share a pid and an /tmp, and a later run gets a new
    // directory: that is what makes the lease visible to every test file at once
    // without outliving the run. The default directory is deliberately *not*
    // released here — other files in this run hold leases in it.
    const leases = new PortLeases();
    const base = process.env.DBSTACK_PORT_LEASE_DIR ?? os.tmpdir();
    const expected = path.join(base, `db-stack-ports-${process.pid}`);

    expect(leases.claim(20040)).toBe(true);
    expect(fs.existsSync(path.join(expected, '20040'))).toBe(true);
    expect(path.basename(expected)).toBe(`db-stack-ports-${process.pid}`);
  });

  it('AC 52.10 — the lease base follows DBSTACK_PORT_LEASE_DIR', () => {
    // The harness gives every worker thread its own TMPDIR so that one test's
    // deletion cannot damage another's scratch space. A port pool with the same
    // treatment would hand the same port to two threads, so the base is pinned
    // through the environment instead.
    const base = scratchDir('env-base');
    created.push(base);
    const saved = process.env.DBSTACK_PORT_LEASE_DIR;
    try {
      process.env.DBSTACK_PORT_LEASE_DIR = base;
      const leases = new PortLeases();
      expect(leases.claim(20050)).toBe(true);
      const dir = path.join(base, `db-stack-ports-${process.pid}`);
      expect(fs.existsSync(path.join(dir, '20050'))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.DBSTACK_PORT_LEASE_DIR;
      else process.env.DBSTACK_PORT_LEASE_DIR = saved;
    }
  });
});
