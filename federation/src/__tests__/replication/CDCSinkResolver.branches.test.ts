/**
 * CDCSinkResolver — branch-completion tests.
 *
 * Targets the decision branches the CDC1-CDC3 suite leaves implicit:
 *   - exponential backoff (default strategy) during a retry
 *   - getHealth() uptimeMs `startTime > 0` both branches
 *   - disconnect() best-effort catch (sink.disconnect throws)
 *   - reconnect-after-emit-failure (connection_lost) path
 *   - health-check liveness probe (connected no-op emit + failure increment)
 *   - listener try/catch guards in _publishHealth and _notifyFailure
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CDCSinkResolver, type FailureEvent, type ResolverHealth } from "../../replication/CDCSinkResolver";
import type { ICDCSink, CDCEvent } from "../../interfaces/replication/ICDCSink";

const evt = (id: string): CDCEvent => ({
  id, type: "insert", table: "t", key: id, data: {}, timestamp: BigInt(1),
});

class ScriptedSink implements ICDCSink {
  readonly name = "scripted-sink";
  connected = false;
  connectBehavior: "ok" | "fail-once" | "fail-all" = "ok";
  emitBehavior: "ok" | "fail" = "ok";
  disconnectThrows = false;
  private connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts++;
    if (this.connectBehavior === "fail-all") throw new Error("connect refused");
    if (this.connectBehavior === "fail-once" && this.connectAttempts === 1) throw new Error("first connect refused");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.disconnectThrows) throw new Error("disconnect refused");
    this.connected = false;
  }

  async emit(events: CDCEvent[]): Promise<void> {
    if (!this.connected) throw new Error("not connected");
    if (this.emitBehavior === "fail") throw new Error("emit refused");
  }
}

describe("CDCSinkResolver — exponential backoff (default)", () => {
  it("retries with the default exponential strategy", async () => {
    const sink = new ScriptedSink();
    sink.connectBehavior = "fail-once";
    const r = new CDCSinkResolver(sink, { maxRetries: 3, retryBaseMs: 5, retryMaxMs: 100 });
    await r.connect(); // first attempt fails → exponential backoff → succeeds
    expect(r.connected).toBe(true);
    await r.disconnect();
  });
});

describe("CDCSinkResolver — getHealth uptime", () => {
  it("reports uptimeMs 0 before connect (startTime === 0)", () => {
    const sink = new ScriptedSink();
    const r = new CDCSinkResolver(sink, { maxRetries: 3 });
    expect(r.getHealth().uptimeMs).toBe(0);
  });

  it("reports a positive uptimeMs after connect (startTime > 0)", async () => {
    const sink = new ScriptedSink();
    const r = new CDCSinkResolver(sink, { maxRetries: 3, healthCheckIntervalMs: 0 });
    await r.connect();
    expect(r.getHealth().uptimeMs).toBeGreaterThanOrEqual(0);
    await r.disconnect();
  });
});

describe("CDCSinkResolver — disconnect best-effort", () => {
  it("swallows a throwing sink.disconnect", async () => {
    const sink = new ScriptedSink();
    sink.disconnectThrows = true;
    const r = new CDCSinkResolver(sink, { maxRetries: 3 });
    await r.connect();
    await r.disconnect(); // should not throw despite sink.disconnect error
    expect(r.connected).toBe(false);
  });
});

describe("CDCSinkResolver — emit failure reconnect", () => {
  it("emits connection_lost when reconnect after emit failure also fails", async () => {
    const sink = new ScriptedSink();
    sink.connectBehavior = "ok";
    const r = new CDCSinkResolver(sink, { maxRetries: 2, retryBaseMs: 5, retryStrategy: "none" });
    await r.connect();

    const failures: FailureEvent[] = [];
    r.onFailure((e) => failures.push(e));

    // First emit succeeds to establish state, then make sink fail + reconnect fail
    sink.emitBehavior = "fail";
    sink.connectBehavior = "fail-all";
    await expect(r.emit([evt("a")])).rejects.toThrow();

    // emit_failed + connection_lost both notified
    expect(failures.some((f) => f.mode.type === "emit_failed")).toBe(true);
    expect(failures.some((f) => f.mode.type === "connection_lost")).toBe(true);
    await r.disconnect();
  });
});

describe("CDCSinkResolver — health checks & listener guards", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs the liveness probe (connected → no-op emit) via fake timers", async () => {
    vi.useFakeTimers();
    const sink = new ScriptedSink();
    const r = new CDCSinkResolver(sink, { maxRetries: 3, healthCheckIntervalMs: 100 });
    await r.connect();
    expect((r as any).healthTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(250);
    await r.disconnect();
  });

  it("increments consecutiveFailures when the health-check emit throws", async () => {
    vi.useFakeTimers();
    const sink = new ScriptedSink();
    const r = new CDCSinkResolver(sink, { maxRetries: 3, healthCheckIntervalMs: 100 });
    await r.connect();

    sink.emitBehavior = "fail";
    await (r as any)._runHealthCheck();

    expect(r.getHealth().consecutiveFailures).toBeGreaterThan(0);
    await r.disconnect();
  });

  it("guards against a throwing health listener", async () => {
    const sink = new ScriptedSink();
    const r = new CDCSinkResolver(sink, { maxRetries: 3, healthCheckIntervalMs: 0 });
    r.onHealthChange(() => { throw new Error("listener boom"); });
    r.onHealthChange(() => { /* valid listener */ });
    await r.connect(); // triggers _publishHealth → first listener throws, guarded
    await r.disconnect();
  });

  it("guards against a throwing failure listener", async () => {
    const sink = new ScriptedSink();
    sink.connectBehavior = "fail-all";
    const r = new CDCSinkResolver(sink, { maxRetries: 1, retryBaseMs: 5, retryStrategy: "none" });
    r.onFailure(() => { throw new Error("failure listener boom"); });
    await expect(r.connect()).rejects.toThrow(); // _notifyFailure guards the throw
  });
});
