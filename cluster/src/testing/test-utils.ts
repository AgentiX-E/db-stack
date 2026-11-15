/**
 * Port allocation and temp-directory helpers shared by the integration
 * harnesses (in-process TestCluster and the multi-process TLS tests).
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Ask the OS for a currently free TCP port on localhost. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      // The listen callback runs only after a successful bind, so this socket is
      // bound to a TCP address and never reports a pipe name or no address.
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Reserve `count` distinct free ports. */
export async function getFreePorts(count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => getFreePort()));
}

/** Create an isolated temporary directory for Raft storage. */
export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `raft-test-${prefix}-`));
}

/** Best-effort recursive removal of a temporary directory. */
export function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort: a leaked tmpdir must never fail a test run.
  }
}
