/**
 * Port allocation and temp-directory helpers shared by the integration
 * harnesses (in-process TestCluster and the multi-process TLS tests).
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Leases over the ports handed out in one test run.
 *
 * `getFreePort` asks the OS for a free port, which answers "free *now*": it binds,
 * reads the number, and closes, leaving a window in which the next caller is offered
 * the same port. Inside one process every test file shares that window, and a suite
 * with dozens of clusters opens it dozens of times — which is how
 * `raft-multishard` failed with `EADDRINUSE` while six of its own nodes were still
 * binding. A lease makes the answer exclusive for the run: the port is claimed by
 * creating a file, which fails atomically for the second claimant.
 *
 * The directory is keyed by pid, so workers in a thread pool — which share a pid —
 * see each other's claims, and a later run starts from an empty directory.
 */
/**
 * Where lease directories live.
 *
 * `os.tmpdir()` by default — but the test harness redirects `TMPDIR` per worker
 * thread, and a port pool that is per thread hands the same port to two of them.
 * `DBSTACK_PORT_LEASE_DIR` therefore points every worker at one directory, and
 * `pid` keeps one run's claims out of the next.
 */
function portLeaseBase(): string {
  const override = process.env.DBSTACK_PORT_LEASE_DIR;
  return override !== undefined && override !== '' ? override : os.tmpdir();
}

export class PortLeases {
  private readonly dir: string;
  private swept = false;

  constructor(
    dir: string = path.join(portLeaseBase(), `db-stack-ports-${process.pid}`),
    /** Where lease directories live. A parameter so the sweep can be tested. */
    private readonly tmpRoot: string = portLeaseBase(),
  ) {
    this.dir = dir;
  }

  /** Claim `port` for this run. False when another caller already holds it. */
  claim(port: number): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!this.swept) {
        this.sweepStaleRuns();
        this.swept = true;
      }
      fs.writeFileSync(path.join(this.dir, String(port)), '', { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  /** Give a port back, so a later caller may be offered it. */
  release(port: number): void {
    try {
      fs.unlinkSync(path.join(this.dir, String(port)));
    } catch {
      // Releasing a port nobody claimed is not an error.
    }
  }

  /** Drop every lease this run holds. Called on process exit. */
  releaseAll(): void {
    bestEffort(() => fs.rmSync(this.dir, { recursive: true, force: true }));
  }

  /** Remove lease directories left by runs that are no longer alive. */
  private sweepStaleRuns(): void {
    bestEffort(() => {
      const tmp = this.tmpRoot;
      const mine = path.basename(this.dir);
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of fs.readdirSync(tmp)) {
        if (!entry.startsWith('db-stack-ports-') || entry === mine) continue;
        const full = path.join(tmp, entry);
        if (fs.statSync(full).mtimeMs > dayAgo) continue;
        fs.rmSync(full, { recursive: true, force: true });
      }
    });
  }
}

/**
 * Run housekeeping that must never fail a test run.
 *
 * Removing a temp directory, sweeping a lease directory and unlinking a stale file
 * are all cleanup: an unreadable `/tmp` in a hardened container must not turn a green
 * suite red. Stated once, in one place, so every caller means the same thing by it.
 */
export function bestEffort(work: () => void): void {
  try {
    work();
  } catch {
    // Housekeeping only.
  }
}

/** Leases for this process, shared by every port allocation in the run. */
const portLeases = new PortLeases();
process.once('exit', () => portLeases.releaseAll());

/**
 * Ask the OS for a free TCP port on localhost that no other caller in this run holds.
 *
 * `attempts` and `leases` are parameters for the same reason the lease exists: a
 * caller that needs to prove what happens when every answer is already claimed
 * should not have to occupy the whole ephemeral range to do it.
 */
export function getFreePort(attempts = 25, leases: Pick<PortLeases, 'claim'> = portLeases): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (remaining: number): void => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        // The listen callback runs only after a successful bind, so this socket is
        // bound to a TCP address and never reports a pipe name or no address.
        const { port } = server.address() as net.AddressInfo;
        server.close(() => {
          if (leases.claim(port)) {
            resolve(port);
            return;
          }
          // The OS offered a port another caller in this run already owns. Asking again
          // is cheap and deterministic; failing here would make the suite depend on
          // scheduling order.
          if (remaining <= 1) {
            reject(new Error(`no unleased free port after ${attempts} attempts`));
            return;
          }
          attempt(remaining - 1);
        });
      });
      server.on('error', reject);
    };
    attempt(attempts);
  });
}

/** Reserve `count` distinct free ports. */
export async function getFreePorts(count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => getFreePort()));
}

/**
 * Whether `port` on loopback can be bound right now.
 *
 * Used to wait out the gap between "the node was told to stop" and "the OS
 * released its listening socket": a restart inside that window fails with
 * EADDRINUSE, and the symptom is a node that never receives anything rather than
 * a bind error at the call site.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/** Create an isolated temporary directory for Raft storage. */
export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `raft-test-${prefix}-`));
}

/** Best-effort recursive removal of a temporary directory. */
export function cleanupTempDir(dir: string): void {
  bestEffort(() => fs.rmSync(dir, { recursive: true, force: true }));
}
