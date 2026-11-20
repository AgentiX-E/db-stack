/**
 * Process harness for the end-to-end suites.
 *
 * Every helper here spawns a *separate OS process* running the published
 * package build. There is no in-process shortcut, no mocked transport and no
 * shared memory between nodes: a node that dies is really gone, and every
 * peer-to-peer byte goes over a TLS 1.3 socket with mutual certificate
 * verification.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
// Plain ESM helper shared with the vitest setups; typed by scripts/test-tmpdir.d.mts.
import { useTestTmpRoot } from '../../scripts/test-tmpdir.mjs';
import { generateClusterCerts } from '@agentix-e/db-cluster/testing';
import type { TestClusterCerts } from '@agentix-e/db-cluster/testing';

const HARNESS_DIR = resolve(import.meta.dirname, '.');

/**
 * The harness's own output streams.
 *
 * Captured at module scope on purpose: `ChildNode`'s constructor parameter is named
 * `process` (it *is* the ChildProcess), so `process.stdout` inside those handlers is
 * the child's pipe, not the runner's console. Writing there sent every diagnostic
 * line down a pipe nobody reads — the log tail the harness keeps existed, but the
 * operator never saw it.
 */
const PARENT_OUT = process.stdout;
const PARENT_ERR = process.stderr;

export interface NodeMessage {
  type:
    | 'ready'
    | 'applied'
    | 'proposed'
    | 'status'
    | 'error'
    | 'leader'
    | 'stopped'
    | 'replicated'
    | 'conflict'
    | 'read'
    | 'membership'
    | 'written'
    | 'done';
  nodeId: number | string;
  data?: unknown;
  fatal?: boolean;
}

/**
 * A node's answer to "what is the committed configuration, in your view?".
 *
 * Structural rather than imported: this harness loads the *published* build, and a
 * type imported from the source tree would let the test agree with a declaration
 * the artefact does not have.
 */
export interface MembershipReport {
  voters: number[];
  learners: number[];
  source: 'persisted' | 'bootstrap';
}

/** What one node says about its ability to hear a majority. */
export interface QuorumHealthReport {
  size: number;
  majority: number;
  windowMs: number;
  hasQuorum: boolean;
  unheardPeers: number[];
}

/** One membership change, as the node that was asked reports it. */
export interface MembershipChangeReply {
  command: 'add' | 'promote' | 'remove';
  request: { nodeId: number; address?: string };
  result: { changed: boolean; reason?: string };
  elapsedMs: number;
  membership: MembershipReport;
}

/**
 * Extract the port from a listening socket's `address()`.
 *
 * Split out so the "no port to read" branch is a decision that can be tested
 * directly instead of a defensive `else` inside a callback that no test can reach.
 */
export function portFromAddress(address: { port: number } | string | null): number | null {
  return address && typeof address === 'object' ? address.port : null;
}

/** Ask the kernel for a free TCP port (the socket is closed before the child binds). */
export function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = portFromAddress(server.address());
      if (port === null) {
        server.close(() => reject(new Error('failed to allocate port')));
        return;
      }
      server.close(() => resolvePort(port));
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
const TMP_ROOT = useTestTmpRoot('e2e') as string;

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
  /** Rolling tail of the child's stdout (its structured log). */
  readonly stdoutTail: string[] = [];
  private readonly waiters: Array<{
    predicate: (m: NodeMessage) => boolean;
    resolve: (m: NodeMessage) => void;
  }> = [];
  private exitCode: number | null = null;

  constructor(
    readonly label: string,
    readonly process: ChildProcess,
  ) {
    process.on('message', (msg) => this.dispatch(msg as NodeMessage));
    process.on('exit', (code) => {
      this.exitCode = code ?? 0;
    });
    // A crashed child (SIGKILL in the failover tests) can tear down its stdio
    // and IPC pipes while the parent still has readers attached, which surfaces
    // as an unhandled `read ECONNRESET` and fails the whole run even though the
    // test assertion passed. Losing a dead child's pipe is expected: swallow it.
    const swallow = (): void => {};
    process.on('error', swallow);
    process.stdin?.on('error', swallow);
    process.stdout?.on('error', swallow);
    process.stderr?.on('error', swallow);
    if (process.channel) process.channel.on?.('error', swallow);

    process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      try {
        PARENT_ERR.write(`[${label}] ${text}\n`);
      } catch {
        // Parent stderr already closed during teardown.
      }
    });

    // The node's structured log goes to *stdout* (pino). Leaving it unread both
    // hides the only evidence a wedged node produces and, once the 64 KiB pipe
    // buffer fills, blocks the child inside `write`. Keep a tail and mirror it.
    process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      this.stdoutTail.push(text);
      if (this.stdoutTail.length > 200) this.stdoutTail.shift();
      try {
        PARENT_OUT.write(`[${label}] ${text}\n`);
      } catch {
        // Parent stdout already closed during teardown.
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
  waitFor(predicate: (m: NodeMessage) => boolean, timeoutMs = 30_000, what = 'message'): Promise<NodeMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<NodeMessage>((resolveWaiter, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `[${this.label}] timed out after ${timeoutMs}ms waiting for ${what}` +
              ` (exit=${this.exitStatus ?? 'running'}; stderr: ${this.stderrTail.slice(-5).join(' | ') || '<empty>'})`,
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

  waitForType(type: NodeMessage['type'], timeoutMs = 30_000): Promise<NodeMessage> {
    return this.waitFor((m) => m.type === type, timeoutMs, `${type} from ${this.label}`);
  }

  send(message: object): void {
    // `ChildProcess.send` takes a structured-clone-serialisable value; every message
    // this harness sends is a plain object, so widen only that far.
    this.process.send?.(message as Parameters<NonNullable<typeof this.process.send>>[0]);
  }

  /**
   * Send a command and wait for the reply it causes.
   *
   * The reply is matched from `messages.length` onward, not by identity: every
   * caller of `status` receives a `status` message, so a wait that matched the
   * first one in the buffer would answer this request with the previous request's
   * data — and every assertion built on it would be about a moment already past.
   */
  async request<T = Record<string, unknown>>(
    cmd: string,
    payload: Record<string, unknown>,
    replyType: NodeMessage['type'],
    timeoutMs = 15_000,
  ): Promise<T> {
    const start = this.messages.length;
    this.send({ cmd, ...payload });
    const msg = await this.waitFor(
      (m) => m.type === replyType && this.messages.indexOf(m) >= start,
      timeoutMs,
      replyType,
    );
    return msg.data as T;
  }

  /** Ask the node for a status snapshot. */
  async status<T = Record<string, unknown>>(timeoutMs = 15_000): Promise<T> {
    return this.request<T>('status', {}, 'status', timeoutMs);
  }

  /**
   * Propose a command and return the node's answer, whether it accepted it or not.
   *
   * `propose` answers with `proposed` or with `error`; a caller that waits only for
   * the first one turns "this node is no longer the leader" into a thirty-second
   * timeout with no diagnosis — which is exactly how the first run of the membership
   * suite reported a cluster that had simply moved its leader.
   */
  async propose(data: string, timeoutMs = 30_000): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
    const start = this.messages.length;
    this.send({ cmd: 'propose', data });
    const msg = await this.waitFor(
      (m) => (m.type === 'proposed' || m.type === 'error') && this.messages.indexOf(m) >= start,
      timeoutMs,
      'a proposal answer',
    );
    if (msg.type === 'error') return { ok: false, error: String(msg.data) };
    // No fallback for a missing index: the child answers a proposal with the index
    // raft assigned it, and a harness that invented `-1` would turn a broken reply
    // into a passing assertion about index -1.
    return { ok: true, index: (msg.data as { index: number }).index };
  }

  /** What this node believes the committed configuration is. */
  async membership(timeoutMs = 15_000): Promise<MembershipReport> {
    // Required, not optional: every node the harness spawns reports its configuration,
    // so an absent one is a broken child rather than a cluster with no members, and
    // substituting an empty set here would make that brokenness look like a fact.
    const status = await this.status<{ membership: MembershipReport }>(timeoutMs);
    return status.membership;
  }

  /**
   * Ask this node to change the cluster's membership, and read its answer.
   *
   * A refusal is data, not an error: "not the leader", "no quorum" and "the entry
   * did not commit" are three different facts, and a caller that only sees a
   * rejected promise cannot tell which one it is holding.
   */
  change(
    command: 'add' | 'promote' | 'remove',
    nodeId: number,
    options: { address?: string; asLearner?: boolean } = {},
  ): Promise<MembershipChangeReply> {
    // Thirty seconds, not the request default: raft-core's own commit budget is five
    // seconds, and a change that is waiting for it must be allowed to answer.
    return this.request<MembershipChangeReply>(
      command,
      { nodeId, address: options.address, asLearner: options.asLearner },
      'membership',
      30_000,
    );
  }

  async terminate(): Promise<void> {
    if (this.exited) return;
    this.send({ cmd: 'stop' });
    await new Promise<void>((resolveExit) => {
      // Escalate if the node does not honour the stop command. The promise resolves
      // on the *exit event*, not when the signal is sent: a caller that rebinds the
      // node's port right after `await terminate()` would otherwise race the corpse,
      // and SIGKILL delivery is asynchronous.
      const timer = setTimeout(() => this.process.kill('SIGKILL'), 5_000);
      this.process.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  /** Hard kill — used to simulate a node crash. */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    // Detach the IPC channel before killing: the child cannot flush it, and a
    // pending `read()` on the parent side becomes ECONNRESET.
    this.process.removeAllListeners('message');
    this.process.disconnect?.();
    this.process.kill(signal);
  }

  /** Wait until the child process is actually gone. */
  waitForExit(timeoutMs = 10_000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.label}] did not exit in ${timeoutMs}ms`)), timeoutMs);
      this.process.once('exit', () => {
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
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'raft-node.mjs')], {
    env: { ...process.env, RAFT_NODE_CONFIG: JSON.stringify(spec) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(`node-${spec.id}@${spec.port}`, child);
}

/** Spawn the process that writes the change log. */
export function spawnChangeWriter(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'change-writer.mjs')], {
    env: { ...process.env, CHANGE_WRITER_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn one CDC relay process (sender or receiver role). */
export function spawnCdcRelay(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'cdc-relay.mjs')], {
    env: { ...process.env, CDC_RELAY_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn the HTTP sink server process. */
export function spawnCdcSinkServer(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'cdc-sink-server.mjs')], {
    env: { ...process.env, CDC_SINK_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn one federation gateway process (Raft member + federation stack). */
export function spawnGateway(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'federation-gateway.mjs')], {
    env: {
      ...process.env,
      FEDERATION_GATEWAY_CONFIG: JSON.stringify(config),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/**
 * Poll until `probe` returns a value, then return it.
 *
 * On timeout the error carries everything the caller can cheaply supply: the
 * last error the probe threw, the last falsy value it returned, and whatever
 * `describe` reports about the live system. A wait that expires without saying
 * *what it saw* costs a second full run to explain — and a 60-second wait
 * against a real cluster is expensive enough that "it timed out" is not a
 * useful report.
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  label: string,
  intervalMs = 100,
  describe?: () => unknown | Promise<unknown>,
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
    `timed out after ${timeoutMs}ms waiting for ${label}` +
      (lastError ? ` (last error: ${String(lastError)})` : '') +
      (describe ? ` (${await safeDescribe(describe)})` : ''),
  );
}

/** One-line, bounded rendering of whatever a probe or a describer returned. */
function render(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

/**
 * Run the caller's timeout diagnostic without letting it replace the timeout.
 *
 * `describe` reaches into live clusters, so it can throw for the same reason the
 * wait timed out. Losing the "timed out after 60s" line to a secondary error is
 * how a stalled cluster gets reported as a broken status call.
 */
async function safeDescribe(describe: () => unknown | Promise<unknown>): Promise<string> {
  try {
    return render(await describe());
  } catch (err) {
    return `diagnostics unavailable: ${String(err)}`;
  }
}
