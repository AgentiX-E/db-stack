/**
 * Process harness for the end-to-end suites.
 *
 * Every helper here spawns a *separate OS process* running the published
 * package build. There is no in-process shortcut, no mocked transport and no
 * shared memory between nodes: a node that dies is really gone, and every
 * peer-to-peer byte goes over a TLS 1.3 socket with mutual certificate
 * verification.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
// @ts-expect-error — plain ESM helper shared with the vitest setups.
import { useTestTmpRoot } from "../../scripts/test-tmpdir.mjs";
import { generateClusterCerts } from "@agentix-e/db-cluster/testing";
import type { TestClusterCerts } from "@agentix-e/db-cluster/testing";

const HARNESS_DIR = resolve(import.meta.dirname, ".");

export interface NodeMessage {
  type:
    | "ready"
    | "applied"
    | "proposed"
    | "status"
    | "error"
    | "leader"
    | "stopped"
    | "replicated"
    | "conflict"
    | "read";
  nodeId: number | string;
  data?: unknown;
  fatal?: boolean;
}

/** Ask the kernel for a free TCP port (the socket is closed before the child binds). */
export function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolvePort(port));
      } else {
        server.close(() => reject(new Error("failed to allocate port")));
      }
    });
  });
}

export async function getFreePorts(count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => getFreePort()));
}

/** Certificate bundle for a whole suite: one CA, per-node certs, one rogue cert. */
export function makeCertificates(nodeCount: number): TestClusterCerts {
  return generateClusterCerts(nodeCount);
}

/** Root for e2e scratch data: tmpfs when available (fsync-bound workloads). */
const TMP_ROOT = useTestTmpRoot("e2e") as string;

export function makeTempDir(label: string): string {
  return mkdtempSync(join(TMP_ROOT, `dbstack-e2e-${label}-`));
}

export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Base class handling IPC plumbing, message buffering and lifecycle. */
export class ChildNode {
  readonly messages: NodeMessage[] = [];
  /** Rolling tail of the child's stderr — surfaced when a wait times out. */
  readonly stderrTail: string[] = [];
  private readonly waiters: Array<{
    predicate: (m: NodeMessage) => boolean;
    resolve: (m: NodeMessage) => void;
  }> = [];
  private exitCode: number | null = null;

  constructor(
    readonly label: string,
    readonly process: ChildProcess,
  ) {
    process.on("message", (msg) => this.dispatch(msg as NodeMessage));
    process.on("exit", (code) => {
      this.exitCode = code ?? 0;
    });
    // A crashed child (SIGKILL in the failover tests) can tear down its stdio
    // and IPC pipes while the parent still has readers attached, which surfaces
    // as an unhandled `read ECONNRESET` and fails the whole run even though the
    // test assertion passed. Losing a dead child's pipe is expected: swallow it.
    const swallow = (): void => {};
    process.on("error", swallow);
    process.stdin?.on("error", swallow);
    process.stdout?.on("error", swallow);
    process.stderr?.on("error", swallow);
    if (process.channel) process.channel.on?.("error", swallow);

    process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      try {
        process.stderr.write(`[${label}] ${text}\n`);
      } catch {
        // Parent stderr already closed during teardown.
      }
    });
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  get exitStatus(): number | null {
    return this.exitCode;
  }

  private dispatch(msg: NodeMessage): void {
    if (!msg || !msg.type) return;
    this.messages.push(msg);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(msg)) {
        this.waiters.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  }

  /** Resolve with the first message (past or future) matching `predicate`. */
  waitFor(
    predicate: (m: NodeMessage) => boolean,
    timeoutMs = 30_000,
    what = "message",
  ): Promise<NodeMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<NodeMessage>((resolveWaiter, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `[${this.label}] timed out after ${timeoutMs}ms waiting for ${what}` +
              ` (exit=${this.exitStatus ?? "running"}; stderr: ${this.stderrTail.slice(-5).join(" | ") || "<empty>"})`,
          ),
        );
      }, timeoutMs);

      const wrapped = (msg: NodeMessage): void => {
        clearTimeout(timer);
        resolveWaiter(msg);
      };
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  waitForType(
    type: NodeMessage["type"],
    timeoutMs = 30_000,
  ): Promise<NodeMessage> {
    return this.waitFor(
      (m) => m.type === type,
      timeoutMs,
      `${type} from ${this.label}`,
    );
  }

  send(message: unknown): void {
    this.process.send?.(message);
  }

  /** Ask the node for a status snapshot. */
  async status<T = Record<string, unknown>>(timeoutMs = 15_000): Promise<T> {
    const before = this.messages.filter((m) => m.type === "status").length;
    this.send({ cmd: "status" });
    const msg = await this.waitFor(
      (m) =>
        m.type === "status" &&
        this.messages.filter((x) => x.type === "status").indexOf(m) >= before,
      timeoutMs,
      "status",
    );
    return msg.data as T;
  }

  async terminate(): Promise<void> {
    if (this.exited) return;
    this.send({ cmd: "stop" });
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolveExit();
      }, 5_000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  /** Hard kill — used to simulate a node crash. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    // Detach the IPC channel before killing: the child cannot flush it, and a
    // pending `read()` on the parent side becomes ECONNRESET.
    this.process.removeAllListeners("message");
    this.process.disconnect?.();
    this.process.kill(signal);
  }

  /** Wait until the child process is actually gone. */
  waitForExit(timeoutMs = 10_000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`[${this.label}] did not exit in ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}

export interface ClusterNodeSpec {
  id: number;
  host: string;
  port: number;
  dataDir: string;
  cert: { cert: string; key: string; ca: string };
  peers: Array<{ id: number; host: string; port: number }>;
  electionTick?: number;
  heartbeatTick?: number;
  /**
   * Entries between snapshots. Small values make snapshot behaviour observable in a
   * short acceptance run; the default (1000) is the production setting.
   */
  snapshotInterval?: number;
  /**
   * Let a follower that fell behind the compacted log receive a snapshot.
   * Without it a clustered snapshot discards entries a lagging peer still needs,
   * and that peer can never vote again.
   */
  enableInstallSnapshot?: boolean;
}

/** Spawn one Raft node process. */
export function spawnRaftNode(spec: ClusterNodeSpec): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, "raft-node.mjs")], {
    env: { ...process.env, RAFT_NODE_CONFIG: JSON.stringify(spec) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return new ChildNode(`node-${spec.id}@${spec.port}`, child);
}

/** Spawn one federation gateway process (Raft member + federation stack). */
export function spawnGateway(
  config: Record<string, unknown>,
  label: string,
): ChildNode {
  const child = spawn(
    process.execPath,
    [join(HARNESS_DIR, "federation-gateway.mjs")],
    {
      env: {
        ...process.env,
        FEDERATION_GATEWAY_CONFIG: JSON.stringify(config),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  return new ChildNode(label, child);
}

/** Poll until `probe` returns a value, then return it. */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  label: string,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}
