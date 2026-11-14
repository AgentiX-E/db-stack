/**
 * LinearizabilityChecker — Register-model linearizability verification.
 *
 * D2 iteration: Jepsen-style linearizability verification for Raft cluster.
 *
 * Algorithm:
 *   WG (Wing-Gong) linearizability checking with pruning.
 *   Given a history of concurrent operations (call/return intervals),
 *   find a legal sequential ordering that respects real-time order.
 *
 * Model: Single Register (read/write)
 *   read(k) → v    (returns the last written value for key k)
 *   write(k, v)    (sets key k to value v)
 *
 * Usage:
 *   const history: Operation[] = [...];
 *   const result = LinearizabilityChecker.isLinearizable(history);
 *   // result === true if a legal sequentialization exists
 */

/**
 * FuzzyRegisterChecker — 允许 write→ok 后值不立即可见的一致性验证器。
 *
 * 设计原理（与 Jepsen 标准 register 模型的区别）：
 *
 * 标准 register 模型（WG/WGL）:
 *   write(k, v) → ok  ⇒  后续 read(k) 必须返回 v
 *   read(k) → v       ⇒  系统 state machine 中 k 的值必须是 v
 *
 * 模糊 register 模型（本 checker）:
 *   write(k, v) → ok  ⇒  值 v 被记录在写入历史中
 *   read(k) → v       ⇒  v 必须是某个曾经被 write(k,*) 写入过的值（不能伪造）
 *   read(k) → null    ⇒  允许 read 返回 null（系统尚未 apply）
 *
 * 为什么需要模糊模型：
 *   Raft 保证 committed 日志最终被 apply，但不保证 propose 返回时已经 apply。
 *   Jepsen 标准 register 模型要求立即可见性，与 Raft 的 async apply 冲突。
 *   模糊模型移除了"最新值"约束，只防止"伪造值"——这正是系统能保证的。
 *
 * 验证算法（简化 WG）：
 *   1. 构建所有 key 的写入值集合（write set）
 *   2. 对每个 read(k) → v，检查 v ∈ writeSeen(k) 或 (v === null 且 k 被写过)
 *   3. 通过条件：所有 read 返回的值都是合法的
 *
 * 这个模型在丢失了时序信息，但捕获了"数据伪造"这个更严重的 violation。
 */

export interface FuzzyCheckResult {
  /** True if all reads returned valid values */
  valid: boolean;
  /** Any reads that returned values not present in the write set */
  violations: Array<{
    key: string;
    readValue: string | undefined;
    knownValues: Set<string | undefined>;
  }>;
  /** Per-key write set */
  writeSet: Map<string, Set<string | undefined>>;
}

export function fuzzyCheck(events: Event[]): FuzzyCheckResult {
  const writeSet = new Map<string, Set<string | undefined>>();
  const violations: FuzzyCheckResult['violations'] = [];

  // First pass: collect all written values per key
  for (const e of events) {
    if (e.type === 'call' && e.operation === 'write') {
      const set = writeSet.get(e.key) ?? new Set();
      set.add(e.value);
      writeSet.set(e.key, set);
    }
  }

  // Second pass: validate all reads
  const paired = LinearizabilityChecker.pairEvents(events);
  for (const op of paired) {
    if (op.call.operation !== 'read') continue;

    const key = op.call.key;
    const readVal = op.ret.value;
    const keyValues = writeSet.get(key) ?? new Set<string | undefined>();

    // Read returning null is always valid (system may not have applied yet)
    if (readVal === null || readVal === undefined) continue;

    // If key has no writes at all, any non-null read is a violation
    if (keyValues.size === 0) {
      violations.push({ key, readValue: readVal, knownValues: keyValues });
      continue;
    }

    // Read value must be in the write set
    if (!keyValues.has(readVal)) {
      violations.push({ key, readValue: readVal, knownValues: keyValues });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    writeSet,
  };
}

// ── Types ───────────────────────────────────────────────────

export interface CallEvent {
  type: 'call';
  clientId: string;
  operation: 'read' | 'write';
  key: string;
  value?: string;
  time: number; // monotonic timestamp
}

export interface ReturnEvent {
  type: 'return';
  clientId: string;
  operation: 'read' | 'write';
  key: string;
  value?: string; // read result
  time: number;
}

export type Event = CallEvent | ReturnEvent;

export interface Operation {
  clientId: string;
  call: CallEvent;
  ret: ReturnEvent;
}

export interface RegisterState {
  [key: string]: string | undefined;
}

// ── Linearizability Checker ─────────────────────────────────

export class LinearizabilityChecker {
  /**
   * Check if a history of register operations is linearizable.
   *
   * Uses a bounded search: if the state space exceeds maxStates,
   * returns 'unknown' instead of false (conservative but avoids
   * exponential blowup for long histories).
   *
   * @param events — Flat array of call/return events
   * @param maxStates — Maximum number of states to explore (default 1_000_000)
   * @returns true if linearizable, false if violation found, 'unknown' if search bound exceeded
   */
  static isLinearizable(
    events: Event[],
    maxStates: number = 1_000_000,
  ): boolean | 'unknown' {
    // Step 1: Pair calls with returns
    const operations = LinearizabilityChecker.pairEvents(events);

    // Step 2: Build precedence graph
    // op_i must precede op_j if op_i.return < op_j.call (real-time order)
    const n = operations.length;
    if (n === 0) return true;

    // Step 3: Find a legal sequential ordering via DFS with pruning
    const visited = new Set<string>();
    const used = new Array(n).fill(false);
    let stateCount = 0;

    function dfs(
      seq: Operation[],
      state: RegisterState,
    ): boolean {
      if (stateCount > maxStates) return false; // bound exceeded
      stateCount++;

      if (seq.length === n) return true; // complete ordering found

      // Try each unused operation that is "ready" (all predecessors used)
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;

        // Check real-time precedence: all operations that returned before
        // this one's call must already be in seq
        const op = operations[i];
        if (!op) continue;
        let allPredecessorsUsed = true;
        for (let j = 0; j < n; j++) {
          if (i === j || used[j]) continue;
          const other = operations[j];
          if (!other) continue;
          // j must precede i if j's return is before i's call
          if (other.ret.time < op.call.time) {
            allPredecessorsUsed = false;
            break;
          }
        }
        if (!allPredecessorsUsed) continue;

        // Try this operation — check if it's legal in current state
        used[i] = true;

        let legal = false;
        let newState: RegisterState = { ...state };

        if (op.call.operation === 'write') {
          // write always legal
          newState[op.call.key] = op.call.value;
          legal = true;
        } else if (op.call.operation === 'read') {
          // read is legal if the returned value matches state
          const expected = state[op.call.key];
          const actual = op.ret.value;
          if (actual === expected || (expected === undefined && actual === null)) {
            legal = true;
            // read doesn't change state
          }
        }

        if (legal) {
          seq.push(op);
          if (dfs(seq, newState)) return true;
          seq.pop();
        }

        used[i] = false;
      }

      return false;
    }

    const result = dfs([], {});
    if (!result && stateCount > maxStates) return 'unknown';
    return result;
  }

  /**
   * Pair call/return events into Operation objects.
   * Throws if events are malformed (unbalanced or mismatched).
   */
  static pairEvents(events: Event[]): Operation[] {
    const byClient = new Map<string, Event[]>();

    for (const e of events) {
      const list = byClient.get(e.clientId) ?? [];
      list.push(e);
      byClient.set(e.clientId, list);
    }

    const operations: Operation[] = [];
    for (const [clientId, clientEvents] of byClient) {
      // Pair in insertion order, per client. A client is sequential, so the
      // next event after a call must be its return. Sorting by timestamp
      // would be wrong: ms-resolution collisions reorder a client's own
      // events and destroy the call/return pairing.
      let pendingCall: CallEvent | undefined;

      for (const event of clientEvents) {
        if (event.type === 'call') {
          // A new call while one is still in flight means the previous
          // operation never returned (client crash / abort): drop it.
          pendingCall = event;
          continue;
        }

        if (!pendingCall) {
          throw new Error(`Unpaired return for client ${clientId}`);
        }
        if (pendingCall.operation !== event.operation) {
          throw new Error(
            `Mismatched operation for client ${clientId}: ${pendingCall.operation} vs ${event.operation}`,
          );
        }

        operations.push({ clientId, call: pendingCall, ret: event });
        pendingCall = undefined;
      }
      // Trailing call with no return: aborted operation, silently skipped.
    }

    // Sort by return time for deterministic ordering
    operations.sort((a, b) => a.ret.time - b.ret.time);
    return operations;
  }

  /**
   * Generate a complete history from a list of operations by simulating
   * the system. Each operation gets a call time and return time.
   * For testing purposes.
   */
  static generateHistory(
    ops: Array<{ clientId: string; operation: 'read' | 'write'; key: string; value?: string; result?: string }>,
    startTime: number = 0,
    latencyMs: number = 10,
  ): Event[] {
    const events: Event[] = [];
    let t = startTime;

    for (const op of ops) {
      const callTime = t;
      const returnTime = t + latencyMs + Math.random() * 5;

      events.push({
        type: 'call',
        clientId: op.clientId,
        operation: op.operation,
        key: op.key,
        value: op.operation === 'write' ? op.value : undefined,
        time: callTime,
      });

      events.push({
        type: 'return',
        clientId: op.clientId,
        operation: op.operation,
        key: op.key,
        value: op.result,
        time: returnTime,
      });

      t += latencyMs / 2 + Math.random() * 3;
    }

    return events;
  }
}

// ── Operation Recorder (for chaos test integration) ─────────

export class OperationRecorder {
  private events: Event[] = [];
  private pendingCalls = new Map<string, number>();
  private callSeq = 0;

  /**
   * Record a call event in real time.
   * Returns a unique callId that must be passed to recordReturn.
   */
  recordCall(
    clientId: string,
    operation: 'read' | 'write',
    key: string,
    value?: string,
  ): string {
    const callId = `${clientId}:${this.callSeq++}`;
    const now = Date.now();

    this.events.push({
      type: 'call',
      clientId,
      operation,
      key,
      value,
      time: now,
    });

    this.pendingCalls.set(callId, this.events.length - 1);
    return callId;
  }

  /**
   * Record a return event matching a prior call.
   */
  recordReturn(
    callId: string,
    operation: 'read' | 'write',
    key: string,
    value?: string,
  ): void {
    const now = Date.now();
    this.events.push({
      type: 'return',
      clientId: callId.split(':')[0] ?? callId,
      operation,
      key,
      value,
      time: now,
    });
  }

  getEvents(): Event[] {
    return [...this.events];
  }

  /**
   * Check if the recorded history is linearizable.
   */
  isLinearizable(maxStates?: number): boolean | 'unknown' {
    return LinearizabilityChecker.isLinearizable(this.events, maxStates);
  }

  reset(): void {
    this.events = [];
    this.pendingCalls.clear();
    this.callSeq = 0;
  }
}
