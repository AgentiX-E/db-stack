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
import type { FederationManagerConfig, OutboxStoreConfig } from '@agentix-e/db-federation';

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
    | 'done'
    // The CDC relay's answer to `release`, which lifts the receiver's `applyLimit`.
    | 'released'
    // The federation gateway's control-plane answers: a change adopted from the
    // local engine, a sweep the suite asked for, a heartbeat it sent or injected,
    // and the transfer id a bootstrap started with.
    | 'adopted'
    | 'swept'
    | 'beat'
    | 'heartbeat-sent'
    | 'bootstrap'
    // The edge CDC source's acknowledgement of a `push`: how many frames it
    // put on the real TLS socket, and whether each send was accepted.
    | 'pushed'
    // The fenced store's answer to a write and its report of what it holds, plus
    // the client it dropped because the CA did not vouch for it.
    | 'reply'
    | 'state'
    | 'rejected-client';
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

/**
 * First port the harness hands out.
 *
 * Below the range Linux picks ephemeral ports from (32768–60999) on purpose. Asking the
 * kernel for port 0 and then handing the number to a child is a promise this process
 * cannot keep: between the probe and the child's `listen`, any outbound connection on the
 * runner may take that port out of the ephemeral pool. That is not hypothetical — a CI run
 * lost its west gateway to `EADDRINUSE` on 127.0.0.1:38473, four cross-cluster cases timed
 * out behind it, and the failure read as a federation bug. A port the kernel never hands
 * out on its own cannot be taken that way.
 */
export const PORT_BASE = 20_000;

/** Ports reserved per worker. Six workers cover 20000–31999, all of it non-ephemeral. */
export const PORT_STRIDE = 2_000;

/** Ports reserved per allocation, so two calls in flight at once cannot collide. */
export const PORT_SLOT = 8;

/**
 * The window this worker draws from.
 *
 * Vitest gives each worker its own module instance, so a counter alone would restart at
 * `PORT_BASE` in every worker and hand two suites the same port. The worker id is what
 * makes two workers' windows disjoint — and the modulus keeps a seventh worker inside the
 * range instead of running off the end of it.
 */
function workerWindow(workerId: string | undefined): { start: number; end: number } {
  const parsed = Number(workerId ?? '1');
  const index = Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : 0;
  const start = PORT_BASE + (index % 6) * PORT_STRIDE;
  return { start, end: start + PORT_STRIDE };
}

/** What a probe learned about one port. */
export type PortProbe = 'free' | 'busy' | 'unreadable';

/**
 * Bind `port` once and report what the kernel said.
 *
 * `unreadable` is the case a real kernel never produces and a fake one can: a socket that
 * is listening and reports no address is not a port, so it is an error rather than "busy" —
 * retrying would walk the whole window and fail with a message about the window.
 */
export function probePort(port: number): Promise<PortProbe> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolvePort('busy'));
    server.listen(port, '127.0.0.1', () => {
      const bound = portFromAddress(server.address());
      server.close(() => resolvePort(bound === null ? 'unreadable' : 'free'));
    });
  });
}

let cursor: number | null = null;
let window: { start: number; end: number } | null = null;

/** Claim the next slot of ports synchronously, so concurrent callers never share one. */
function reserveSlot(): number {
  if (cursor === null || window === null) {
    window = workerWindow(process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID);
    cursor = window.start;
  }
  const base = cursor;
  cursor += PORT_SLOT;
  return base;
}

/**
 * Ask for a free TCP port (the socket is closed before the child binds).
 *
 * Drawn from this worker's own window rather than from the kernel's ephemeral pool, so the
 * number a child is given is still the number it gets to bind.
 */
export async function getFreePort(): Promise<number> {
  const base = reserveSlot();
  const limit = Math.min(base + PORT_SLOT, window?.end ?? base + PORT_SLOT);
  for (let port = base; port < limit; port += 1) {
    const probe = await probePort(port);
    if (probe === 'free') return port;
    if (probe === 'unreadable') throw new Error('failed to allocate port');
  }
  // Unreachable in a test on purpose: a slot is eight ports, and reaching this needs eight
  // sockets held by something other than this suite inside a window this suite owns. It is
  // here because "the allocator returned a port it never bound" is the failure this file
  // must not have, and a silent fallback to the ephemeral pool would be exactly that.
  throw new Error(`failed to allocate port: no free port in the harness window at ${base}`);
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

/**
 * One outstanding `waitFor`.
 *
 * The timer and the `reject` live here rather than in the promise closure so that
 * every path that settles a wait — the message arriving, the deadline passing, the
 * child exiting, the child declaring itself fatal — goes through one of two
 * functions and none of them can leave a timer behind.
 */
interface Waiter {
  predicate: (m: NodeMessage) => boolean;
  what: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (m: NodeMessage) => void;
  reject: (error: Error) => void;
}

/** Base class handling IPC plumbing, message buffering and lifecycle. */
export class ChildNode {
  readonly messages: NodeMessage[] = [];
  /** Rolling tail of the child's stderr — surfaced when a wait times out. */
  readonly stderrTail: string[] = [];
  /** Rolling tail of the child's stdout (its structured log). */
  readonly stdoutTail: string[] = [];
  private readonly waiters: Waiter[] = [];
  private exitCode: number | null = null;

  constructor(
    readonly label: string,
    readonly process: ChildProcess,
  ) {
    process.on('message', (msg) => this.dispatch(msg as NodeMessage));
    process.on('exit', (code) => {
      this.exitCode = code ?? 0;
      // A child that has exited can never send the message a waiter is waiting
      // for. Letting the waiter sit out its full deadline — 90 s for a gateway
      // that died during boot — hides the exit status and the stderr tail that
      // already explain the failure, and turns a five-second diagnosis into a
      // timed-out test. `setImmediate` lets the IPC channel deliver a message
      // the child sent just before it left.
      setImmediate(() => this.settleAfterExit());
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
    // Resolve first, then decide whether the message also ends the conversation:
    // a test that is *asserting* a fatal error waits for exactly this message, and
    // it must receive it rather than a rejection that pre-empts the assertion.
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(msg)) this.resolve(waiter, msg);
    }
    if (msg.type === 'error' && msg.fatal === true) {
      // Every harness child sends `{ type: 'error', fatal: true }` as its last
      // message before exiting, and nothing in this class used to read the flag:
      // a gateway that refused its configuration at boot looked exactly like a
      // gateway that was slow to boot, and the suite paid the full 90 s deadline
      // for a reason the child had already stated in a millisecond.
      const reason = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
      setImmediate(() =>
        this.failAll(
          `[${this.label}] reported a fatal error`,
          ` (fatal: ${reason}; stderr: ${this.stderrTail.slice(-5).join(' | ') || '<empty>'})`,
        ),
      );
    }
  }

  /** Remove a waiter from the book, so no path can settle it twice. */
  private forget(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    return true;
  }

  private resolve(waiter: Waiter, msg: NodeMessage): void {
    if (this.forget(waiter)) waiter.resolve(msg);
  }

  private fail(waiter: Waiter, message: string): void {
    if (this.forget(waiter)) waiter.reject(new Error(message));
  }

  /** Fail every outstanding wait with one reason. */
  private failAll(headline: string, detail: string): void {
    for (const waiter of [...this.waiters]) this.fail(waiter, `${headline} before ${waiter.what}${detail}`);
  }

  /**
   * Settle the waits an exited child can no longer answer.
   *
   * There is no message to look for here: a message the child sent before it left
   * is dispatched by the IPC channel before this handler runs, and a wait created
   * after the exit searches the buffer first. What is left is a wait whose message
   * is never coming, and the exit status is the whole explanation.
   */
  private settleAfterExit(): void {
    for (const waiter of [...this.waiters]) {
      this.fail(
        waiter,
        `[${this.label}] exited with code ${String(this.exitStatus)} before ${waiter.what}` +
          ` (stderr: ${this.stderrTail.slice(-5).join(' | ') || '<empty>'})`,
      );
    }
  }

  /** Resolve with the first message (past or future) matching `predicate`. */
  waitFor(predicate: (m: NodeMessage) => boolean, timeoutMs = 30_000, what = 'message'): Promise<NodeMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<NodeMessage>((resolveWaiter, rejectWaiter) => {
      const waiter: Waiter = {
        predicate,
        what,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        // The callback runs after this literal is assigned, so referring to the
        // waiter it belongs to is how `fail` gets the timer it must clear.
        timer: setTimeout(() => {
          this.fail(
            waiter,
            `[${this.label}] timed out after ${timeoutMs}ms waiting for ${what}` +
              ` (exit=${this.exitStatus ?? 'running'}; stderr: ${this.stderrTail.slice(-5).join(' | ') || '<empty>'})`,
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
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

/** Spawn the process that appends to a real audit trail. */
export function spawnAuditWriter(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'audit-writer.mjs')], {
    env: { ...process.env, AUDIT_WRITER_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn the process that reads a trail another process left behind. */
export function spawnAuditReader(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'audit-reader.mjs')], {
    env: { ...process.env, AUDIT_READER_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn one edge CDC source process (a real mTLS socket that pushes frames). */
export function spawnEdgeSource(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'edge-source.mjs')], {
    env: { ...process.env, EDGE_SOURCE_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/**
 * Spawn the fenced store process — a real resource that decides writes from its
 * own durable record of the highest fencing token it has accepted.
 */
export function spawnFencedStore(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'fenced-store.mjs')], {
    env: { ...process.env, FENCED_STORE_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn a writer process that presents a fencing token over mTLS. */
export function spawnFenceWriter(config: Record<string, unknown>, label: string): ChildNode {
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'fence-writer.mjs')], {
    env: { ...process.env, FENCE_WRITER_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Spawn one federation gateway process (Raft member + federation stack). */
export function spawnGateway(config: Record<string, unknown>, label: string): ChildNode {
  assertGatewayConfig(config);
  const child = spawn(process.execPath, [join(HARNESS_DIR, 'federation-gateway.mjs')], {
    env: {
      ...process.env,
      FEDERATION_GATEWAY_CONFIG: JSON.stringify(config),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

/** Outbox keys the gateway owns: a suite that sets them is configuring nothing. */
const GATEWAY_OWNED_OUTBOX_KEYS = ['dataDir', 'mapSize'];

/**
 * The `outbox` keys a suite may set, named against the store's own configuration
 * type so that a field the store renames stops compiling here instead of being
 * silently dropped at runtime.
 */
const OUTBOX_REQUEST_KEYS: ReadonlyArray<keyof OutboxStoreConfig> = [
  'ttlMs',
  'entryTtlMs',
  'retryWindowMs',
  'maxRetries',
  'retryBackoffMs',
  'retryBackoffMaxMs',
  'dedupMs',
  'deadLetterTtlMs',
];

/**
 * Refuse a gateway configuration whose `outbox` block cannot be honoured.
 *
 * The gateway used to copy four hand-picked keys out of `outbox` and drop the
 * rest, so a suite that set `retryBackoffMaxMs` (or misspelled a key) ran against
 * the production default and reported on a configuration it never asked for.
 * That is how a one-second retry window shipped next to the two-second default
 * backoff: the backoff was not dropped by the store, it was dropped here.
 *
 * Checked in the parent, before a process is spawned, because a refusal that
 * needs a boot to discover is a 90-second way to read a message this function
 * can produce immediately.
 */
/**
 * The `controlPlane` keys a suite may set, named against the manager's own
 * configuration type.
 *
 * Same rule as `OUTBOX_REQUEST_KEYS`: a field the manager renames stops compiling
 * here instead of being quietly replaced by a production default at boot. The
 * intervals are the point — a scenario that wants to see a heartbeat expire, or a
 * digest round trip complete inside the seconds it has, must set the interval the
 * protocol actually runs with, not the one the suite believes it set.
 */
const CONTROL_PLANE_REQUEST_KEYS: ReadonlyArray<keyof FederationManagerConfig> = [
  'antiEntropyIntervalMs',
  'antiEntropyExchangeTimeoutMs',
  'heartbeatIntervalMs',
  'bootstrapChunkSize',
  'bootstrapResumePath',
  'handoffLogLimit',
  'dlqScanIntervalMs',
  'outboxHousekeepingIntervalMs',
];

export function assertGatewayConfig(config: Record<string, unknown>): void {
  assertObjectBlock('outbox', config.outbox);
  assertObjectBlock('controlPlane', config.controlPlane);

  const outbox = config.outbox as Record<string, unknown> | undefined;
  if (outbox) {
    const unknown = Object.keys(outbox).filter(
      (key) => !(OUTBOX_REQUEST_KEYS as readonly string[]).includes(key) && !GATEWAY_OWNED_OUTBOX_KEYS.includes(key),
    );
    if (unknown.length > 0) {
      throw new Error(
        `gateway outbox has ${unknown.length === 1 ? 'a key' : 'keys'} the store does not read: ${unknown.join(', ')}` +
          ` (accepted: ${OUTBOX_REQUEST_KEYS.join(', ')})`,
      );
    }
    const owned = Object.keys(outbox).filter((key) => GATEWAY_OWNED_OUTBOX_KEYS.includes(key));
    if (owned.length > 0) {
      throw new Error(
        `gateway outbox.${owned.join(', ')} ${owned.length === 1 ? 'is' : 'are'} set by the gateway, not by the suite` +
          ' (the outbox directory comes from `outboxDir`)',
      );
    }
  }

  const controlPlane = config.controlPlane as Record<string, unknown> | undefined;
  if (controlPlane) {
    const unknown = Object.keys(controlPlane).filter(
      (key) => !(CONTROL_PLANE_REQUEST_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new Error(
        `gateway controlPlane has ${unknown.length === 1 ? 'a key' : 'keys'} the manager does not read: ` +
          `${unknown.join(', ')} (accepted: ${CONTROL_PLANE_REQUEST_KEYS.join(', ')})`,
      );
    }
  }
}

/** Refuse a block that is present but is not an object with keys. */
function assertObjectBlock(name: string, block: unknown): void {
  if (block === undefined) return;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    const shape = block === null ? 'null' : Array.isArray(block) ? 'an array' : typeof block;
    throw new Error(`gateway ${name} must be an object, got ${shape}`);
  }
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
