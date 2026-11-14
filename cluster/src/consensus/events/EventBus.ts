/**
 * IEventBus — 类型安全共识事件总线
 * 
 * 所有 Raft 状态转换事件通过此总线发布，支持同步和异步订阅者。
 * 遵循 Disposable 模式确保零内存泄漏。
 * 
 * @module consensus/events
 */

// ── 事件类型定义 ───────────────────────────────────────────────────

export type RaftRole = 'follower' | 'candidate' | 'leader';

export interface RaftEvent {
  type: string;
  timestamp: number;
  nodeId: number;
}

export interface LeaderElectedEvent extends RaftEvent {
  type: 'leader.elected';
  term: number;
  leaderId: number;
}

export interface LeaderLostEvent extends RaftEvent {
  type: 'leader.lost';
  term: number;
  reason: 'election_timeout' | 'step_down' | 'transfer';
}

export interface StepDownEvent extends RaftEvent {
  type: 'leader.step_down';
  term: number;
}

export interface ProposalCommittedEvent extends RaftEvent {
  type: 'proposal.committed';
  index: number;
  term: number;
  data: string;
}

export interface ProposalAppliedEvent extends RaftEvent {
  type: 'proposal.applied';
  index: number;
  term: number;
}

export interface SnapshotCreatedEvent extends RaftEvent {
  type: 'snapshot.created';
  index: number;
  term: number;
}

export interface SnapshotRestoredEvent extends RaftEvent {
  type: 'snapshot.restored';
  index: number;
  term: number;
}

export interface RoleChangedEvent extends RaftEvent {
  type: 'role.changed';
  from: RaftRole;
  to: RaftRole;
  term: number;
}

export interface MembershipChangedEvent extends RaftEvent {
  type: 'membership.changed';
  added: number[];
  removed: number[];
  newConfig: number[];
}

export type ConsensusEvent =
  | LeaderElectedEvent
  | LeaderLostEvent
  | StepDownEvent
  | ProposalCommittedEvent
  | ProposalAppliedEvent
  | SnapshotCreatedEvent
  | SnapshotRestoredEvent
  | RoleChangedEvent
  | MembershipChangedEvent;

// ── 订阅者接口 ─────────────────────────────────────────────────────
// 使用函数类型而非 class 以减少运行时开销

/**
 * IDisposable — 订阅释放句柄。
 * 调用 dispose() 取消订阅，防止内存泄漏。
 */
export interface IDisposable {
  dispose(): void;
}

/** 异步事件处理器 */
export type AsyncEventHandler<T extends ConsensusEvent = ConsensusEvent> = (event: T) => Promise<void> | void;

/** 同步事件处理器（性能敏感路径） */
export type SyncEventHandler<T extends ConsensusEvent = ConsensusEvent> = (event: T) => void;

// ── 事件总线实现 ───────────────────────────────────────────────────

export interface IEventBus {
  /**
   * 发布事件到所有匹配类型的订阅者。
   * 异步订阅者在微任务队列中执行（不阻塞发布线程）。
   * 同步订阅者立即执行。
   */
  emit<T extends ConsensusEvent>(event: T): void;

  /**
   * 订阅事件（默认同步模式，保证事件顺序）。
   * 返回 IDisposable 句柄用于取消订阅。
   */
  on<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable;

  /**
   * 异步订阅（事件按 FIFO 顺序在微任务队列中处理）。
   * 适用于需要长时间处理的事件消费者。
   */
  onAsync<T extends ConsensusEvent>(type: T['type'], handler: AsyncEventHandler<T>): IDisposable;

  /**
   * 一次性订阅。事件触发后自动取消订阅。
   */
  once<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable;

  /**
   * 获取当前订阅者数量（诊断用）。
   */
  subscriberCount(type?: string): number;

  /** 清空所有订阅（用于测试重置）。 */
  reset(): void;
}

// ── 实现 ──────────────────────────────────────────────────────────

/**
 * EventBus — 高性能共识事件总线。
 * 
 * 设计要点：
 * 1. 同步订阅者立即执行（保证顺序事件）
 * 2. 异步订阅者通过 setImmediate 延迟（不阻塞关键路径）
 * 3. 每个回调包装在 try-catch 中（一个订阅者崩溃不影响其他）
 * 4. Disposable 模式（测试中零泄漏验证）
 */
export class EventBus implements IEventBus {
  // 用 Map<eventType, Set<{handler, async}>>
  private _subscribers = new Map<string, Set<{ handler: Function; async: boolean; once: boolean }>>();
  private _emitInProgress = new Map<string, boolean>();

  emit(event: ConsensusEvent): void {
    const subs = this._subscribers.get(event.type);
    if (!subs || subs.size === 0) return;

    // 防止递归 emit 死循环
    if (this._emitInProgress.get(event.type)) return;
    this._emitInProgress.set(event.type, true);

    const toRemove: Function[] = [];

    try {
      for (const sub of subs) {
        try {
          if (sub.async) {
            setImmediate(() => { try { sub.handler(event); } catch { /* swallowed */ } });
          } else {
            sub.handler(event);
          }
        } catch {
          // 一个订阅者崩溃不影响其他
          continue;
        }
        if (sub.once) {
          toRemove.push(sub.handler);
        }
      }
    } finally {
      this._emitInProgress.set(event.type, false);
    }

    for (const h of toRemove) {
      for (const s of subs) {
        if (s.handler === h) subs.delete(s);
      }
    }
  }

  on<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, false, false);
  }

  onAsync<T extends ConsensusEvent>(type: T['type'], handler: AsyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, true, false);
  }

  once<T extends ConsensusEvent>(type: T['type'], handler: SyncEventHandler<T>): IDisposable {
    return this._subscribe(type, handler, false, true);
  }

  private _subscribe(
    type: string,
    handler: Function,
    async: boolean,
    once: boolean,
  ): IDisposable {
    if (!this._subscribers.has(type)) {
      this._subscribers.set(type, new Set());
    }
    const subs = this._subscribers.get(type)!;
    const entry = { handler, async, once };
    subs.add(entry);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        subs.delete(entry);
        if (subs.size === 0) {
          this._subscribers.delete(type);
        }
      },
    };
  }

  subscriberCount(type?: string): number {
    if (type) {
      return this._subscribers.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const subs of this._subscribers.values()) {
      total += subs.size;
    }
    return total;
  }

  reset(): void {
    this._subscribers.clear();
    this._emitInProgress.clear();
  }
}
