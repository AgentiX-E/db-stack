/**
 * Harness contract — the process harness is code too, so it is tested like code.
 *
 * The e2e suites trust three things about `harness/support.ts`: that a wait fails
 * loudly (with the child's own log tail) instead of hanging, that a kill is a real
 * kill, and that teardown is idempotent. When any of those silently changed, the
 * suites would not fail — they would pass for the wrong reason or hang the runner,
 * which is precisely how a green pipeline stops meaning anything.
 *
 * These tests drive the harness itself with a throwaway child process, so they cost
 * a few hundred milliseconds and no Raft cluster.
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ChildNode,
  getFreePorts,
  PORT_BASE,
  PORT_STRIDE,
  portFromAddress,
  probePort,
  removeTempDir,
  waitUntil,
} from '../harness/support';

/** A child that prints one line and then sleeps until it is killed. */
function spawnSleeper(label = 'sleeper'): ChildNode {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('hello\\n'); setInterval(() => {}, 1000);"], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new ChildNode(label, child);
}

describe('harness contract', () => {
  it("waitFor rejects with the label, the deadline and the child's log tail", async () => {
    const node = spawnSleeper('quiet-node');
    try {
      // Give the child a moment to emit its line, so the stderr/stdout context the
      // message promises is actually populated.
      await waitUntil(async () => node.messages.length >= 0 && true, 2_000, 'spawn');
      const error = await node
        .waitForType('status', 200)
        .then(() => undefined)
        .catch((err: Error) => err);

      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain('[quiet-node]');
      expect(error!.message).toContain('timed out after 200ms');
      expect(error!.message).toContain('status');
    } finally {
      node.kill();
      await node.waitForExit();
    }
  }, 20_000);

  it('kill followed by waitForExit resolves once the process is gone', async () => {
    const node = spawnSleeper('killed-node');
    expect(node.exited).toBe(false);
    node.kill();
    await node.waitForExit();
    expect(node.exited).toBe(true);
    // Idempotent: waiting again, or terminating an already-dead child, is a no-op.
    await expect(node.waitForExit()).resolves.toBeUndefined();
    await expect(node.terminate()).resolves.toBeUndefined();
  }, 20_000);

  it('terminate() escalates to SIGKILL when the child ignores the stop message', async () => {
    // A child with no IPC handler for `cmd: 'stop'`: the graceful path cannot
    // complete, so the 5 s escalation is the only thing that ends it. Shortened here
    // by killing immediately — the point is that terminate resolves, not the timing.
    const node = spawnSleeper('stubborn-node');
    const started = Date.now();
    node.kill();
    await node.terminate();
    expect(node.exited).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('waitForExit rejects when the child outlives the deadline', async () => {
    const node = spawnSleeper('slow-exit');
    try {
      const error = await node
        .waitForExit(50)
        .then(() => undefined)
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain('did not exit in 50ms');
    } finally {
      node.kill();
      await node.waitForExit();
    }
  }, 20_000);

  it('terminate() escalates to SIGKILL when the child never handles the stop command', async () => {
    // A child with an IPC channel but no handler for `cmd: 'stop'`: the graceful
    // path cannot complete, so the escalation timer is the only thing that ends it.
    const node = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const wrapped = new ChildNode('ignores-stop', node);
    const started = Date.now();
    await wrapped.terminate();
    expect(wrapped.exited).toBe(true);
    // The escalation is bounded by the harness's own deadline, not by luck.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('works for a child with no stdio pipes and no IPC channel', async () => {
    // The optional chains around stdin/stdout/stderr/channel exist for exactly this
    // shape; without a test they would be dead defensive code.
    const child = spawn(process.execPath, ['-e', ''], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const node = new ChildNode('pipesless', child);
    await node.waitForExit();
    expect(node.exited).toBe(true);
    // Sending to a child without a channel must not throw.
    expect(() => node.send({ cmd: 'status' })).not.toThrow();
    await expect(node.terminate()).resolves.toBeUndefined();
  }, 20_000);

  it('ignores an IPC message that carries no type', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.send({ nope: 1 }); process.send({ type: 'ready' }); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const node = new ChildNode('garbage-ipc', child);
    try {
      await node.waitForType('ready', 5_000);
      // The typeless message is dropped rather than dispatched as a waiter match.
      expect(node.messages.every((m) => Boolean(m.type))).toBe(true);
      expect(node.messages).toHaveLength(1);
    } finally {
      node.kill();
      await node.waitForExit();
    }
  }, 20_000);

  it('waitUntil reports the last error a failing probe threw', async () => {
    const error = await waitUntil(
      async () => {
        throw new Error('probe-boom');
      },
      120,
      'a probe that always fails',
      20,
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('a probe that always fails');
    expect(error!.message).toContain('probe-boom');
  }, 10_000);

  it('removeTempDir swallows a path it cannot remove', async () => {
    // Teardown runs in `afterAll`, where a throw would mask the real failure, so the
    // cleanup is best-effort by design. A file addressed as a directory is the
    // deterministic way to make `rmSync` throw (ENOTDIR) without relying on
    // permissions — which root ignores.
    const file = join(mkdtempSync(join(tmpdir(), 'dbstack-harness-')), 'not-a-dir');
    writeFileSync(file, 'x');
    expect(() => removeTempDir(`${file}/`)).not.toThrow();
    expect(() => removeTempDir('/nonexistent/dbstack-e2e-never-created')).not.toThrow();
    expect(existsSync(file)).toBe(true);
    rmSync(dirname(file), { recursive: true, force: true });
  }, 10_000);

  it('getFreePort rejects rather than returning a bogus port', async () => {
    // A socket that reports no address is not something a real kernel does, so it is
    // faked here: the alternative is a defensive branch that no test can reach and
    // that therefore rots silently. `node:net` is mocked only for this import.
    vi.resetModules();
    vi.doMock('node:net', () => ({
      createServer: () => {
        const fake: any = new EventEmitter();
        fake.unref = () => undefined;
        fake.listen = (_port: number, _host: string, cb: () => void) => cb();
        fake.address = () => null;
        fake.close = (cb?: () => void) => cb?.();
        return fake;
      },
    }));
    try {
      const fresh = await import('../harness/support');
      await expect(fresh.getFreePort()).rejects.toThrow('failed to allocate port');
    } finally {
      vi.doUnmock('node:net');
      vi.resetModules();
    }
  }, 10_000);

  it('ports are drawn from the harness window, never from the ephemeral range', async () => {
    // The reason the window exists: a port the kernel may hand to any outbound
    // connection is a port a child can lose between the probe and its own listen.
    // Linux picks ephemeral ports from 32768 up, so everything handed out is below it.
    const ports = await getFreePorts(6);
    expect(new Set(ports).size).toBe(6);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(PORT_BASE);
      expect(port).toBeLessThan(32_768);
      expect(port).toBeLessThan(PORT_BASE + PORT_STRIDE * 6);
    }
  }, 10_000);

  it('a port somebody already holds is reported busy, then free once it is released', async () => {
    // The probe, not the promise: the allocator can only skip a taken port if the
    // probe tells it the truth about one.
    const port = (await getFreePorts(1))[0]!;
    const holding = createServer();
    await new Promise<void>((listening) => holding.listen(port, '127.0.0.1', listening));
    try {
      expect(await probePort(port)).toBe('busy');
    } finally {
      await new Promise<void>((closed) => holding.close(() => closed()));
    }
    expect(await probePort(port)).toBe('free');
  }, 10_000);

  it('portFromAddress reads the port of a listening socket and rejects anything else', () => {
    expect(portFromAddress({ port: 4321 })).toBe(4321);
    expect(portFromAddress(null)).toBeNull();
  }, 10_000);

  it("survives a closed parent stream while mirroring a child's output", async () => {
    // Teardown can close the parent's stdout while a child is still logging. The
    // mirror swallows that write failure — otherwise a passing suite would fail in
    // its final milliseconds, which is the worst possible time to fail.
    const node = spawnSleeper('noisy-close');
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('parent stdout closed');
    });
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('parent stderr closed');
    });
    try {
      node.process.stdout!.emit('data', Buffer.from('child log line'));
      node.process.stderr!.emit('data', Buffer.from('child error line'));
      expect(node.stdoutTail).toContain('child log line');
      expect(node.stderrTail).toContain('child error line');
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      node.kill();
      await node.waitForExit();
    }
  }, 20_000);

  it('drops blank output and caps the log tail it keeps', async () => {
    // Two rules that only matter under load: a chunk that trims to nothing must not
    // occupy a slot in the tail (a node that ends every line with a newline emits
    // plenty of them), and the tail must stay bounded when a wedged node spews
    // thousands of lines. Both are driven deterministically here rather than left to
    // whichever child happens to be chatty on a given platform — coverage that varies
    // by runner is a flaky gate, which is worse than no gate.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const node = new ChildNode('blank-lines', child);
    try {
      child.stdout!.emit('data', Buffer.from('   \n'));
      child.stderr!.emit('data', Buffer.from('\n'));
      expect(node.stdoutTail).toEqual([]);
      expect(node.stderrTail).toEqual([]);

      for (let i = 0; i < 210; i += 1) child.stdout!.emit('data', Buffer.from(`line ${i}`));
      for (let i = 0; i < 45; i += 1) child.stderr!.emit('data', Buffer.from(`err ${i}`));
      expect(node.stdoutTail).toHaveLength(200);
      expect(node.stdoutTail.at(-1)).toBe('line 209');
      expect(node.stderrTail).toHaveLength(40);
      expect(node.stderrTail.at(-1)).toBe('err 44');

      // A dead child's stdin can raise EPIPE after it exits; that must be swallowed
      // rather than crash the suite that is busy asserting something else.
      expect(() => child.stdin!.emit('error', new Error('EPIPE'))).not.toThrow();
    } finally {
      node.kill();
      await node.waitForExit();
    }
  }, 20_000);

  it('waitUntil gives up with a message naming the condition', async () => {
    const error = await waitUntil(async () => undefined, 150, 'an impossible condition', 25)
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('timed out after 150ms');
    expect(error!.message).toContain('an impossible condition');
  }, 10_000);

  it('waitUntil appends whatever the describe callback reports', async () => {
    const error = await waitUntil(
      async () => undefined,
      120,
      'a described condition',
      20,
      async () => ({
        nodes: [{ id: 2, stateSize: 3 }],
      }),
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('a described condition');
    expect(error!.message).toContain('stateSize');
    expect(error!.message).toContain('"id":2');
  }, 10_000);

  it('waitUntil truncates a verbose diagnostic instead of printing all of it', async () => {
    const error = await waitUntil(
      async () => undefined,
      120,
      'a verbose condition',
      20,
      () => 'x'.repeat(2_000),
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('a verbose condition');
    expect(error!.message).toMatch(/x{1200}…/);
    expect(error!.message).not.toContain('x'.repeat(1_400));
  }, 10_000);

  it('waitUntil renders a diagnostic it cannot serialise', async () => {
    // A live cluster status object can hold a circular reference (a node that
    // points at its own transport). `JSON.stringify` throws on that, and losing
    // the timeout message to a serialisation error would be an own goal.
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;
    const error = await waitUntil(
      async () => undefined,
      120,
      'a circular condition',
      20,
      () => circular,
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('a circular condition');
    expect(error!.message).toContain('[object Object]');
  }, 10_000);

  it('waitUntil renders a diagnostic that serialises to nothing', async () => {
    // `JSON.stringify(fn)` is `undefined`, not a string; printing "undefined"
    // would be worse than printing the function's own source.
    const error = await waitUntil(
      async () => undefined,
      120,
      'an unserialisable condition',
      20,
      () => () => 42,
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('an unserialisable condition');
    expect(error!.message).toContain('42');
  }, 10_000);

  it('waitUntil keeps the timeout when the describe callback itself throws', async () => {
    // Reaching into a live cluster is exactly the thing that fails when the wait
    // failed. A secondary error must not replace "timed out after 120ms".
    const error = await waitUntil(
      async () => undefined,
      120,
      'a condition with broken diagnostics',
      20,
      () => {
        throw new Error('diagnostics-boom');
      },
    )
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(error!.message).toContain('timed out after 120ms');
    expect(error!.message).toContain('diagnostics unavailable');
    expect(error!.message).toContain('diagnostics-boom');
  }, 10_000);
});
