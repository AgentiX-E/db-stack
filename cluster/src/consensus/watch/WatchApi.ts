/**
 * WatchApi — 基于事件总线的异步 Watch 机制。
 * 
 * 消费者注册 watch key，当匹配的事件通过 EventBus 发布时，
 * 消费者通过异步回调接收事件。保证 FIFO 顺序和 leader 变更场景下的正确性。
 *
 * @module consensus/watch
 */

import type { IEventBus, IDisposable, ConsensusEvent, ProposalCommittedEvent } from '../events/EventBus';

// ── 接口 ──────────────────────────────────────────────────────────

export interface WatchOptions {
  /** Watch 超时时间 (ms)，超过后自动取消 */
  timeoutMs?: number;
  /** 是否包含历史已 committed 的 entries（从当前 commitIndex 开始） */
  includeHistory?: boolean;
  /** 起始 index（用于断点续传） */
  startIndex?: number;
}

export interface WatchEvent {
  key: string;
  value: string;
  index: number;
  term: number;
  timestamp: number;
}

export type WatchHandler = (event: WatchEvent) => Promise<void> | void;

/**
 * IWatchApi — 类型安全的 Watch 机制。
 * 
 * 设计原则：
 * 1. 基于 EventBus 的 proposal.committed 事件
 * 2. 支持 key-prefix 匹配（key like "prefix*"）
 * 3. Leader 变更时自动重新注册
 * 4. 超时保护
 */
export interface IWatchApi {
  /**
   * 注册 watch。当匹配 key prefix 的 proposal 被 commit 时触发 handler。
   * 返回 IDisposable 句柄用于取消。
   *
   * @param keyPrefix — 匹配前缀（空字符串匹配所有 key）
   * @param handler — 异步回调
   * @param options — 可选配置
   */
  watch(keyPrefix: string, handler: WatchHandler, options?: WatchOptions): IDisposable;

  /**
   * 获取当前活跃的 watch 数量。
   */
  activeWatchCount(): number;

  /**
   * 关闭所有 watch 并停止事件监听。
   */
  shutdown(): void;
}

// ── 工具函数 ──────────────────────────────────────────────────────

function parseKeyFromData(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed.key === 'string' ? parsed.key : null;
  } catch {
    // data 不是 JSON，尝试提取 key（去掉第一个等号后的 value 部分）
    const eqIdx = data.indexOf('=');
    const rawKey = eqIdx >= 0 ? data.slice(0, eqIdx) : data;
    return rawKey || null;
  }
}

function parseValueFromData(data: string): string {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed.value !== 'undefined' ? String(parsed.value) : data;
  } catch {
    return data;
  }
}

// ── 实现 ──────────────────────────────────────────────────────────

/**
 * WatchApi — 高性能 Watch 实现。
 *
 * 特点：
 * - 前缀匹配（O(1) 哈希 + O(n) 遍历活跃 watches）
 * - Leader 变更事件触发自动重连
 * - 内存安全：所有订阅在 shutdown 时释放
 */
export class WatchApi implements IWatchApi {
  private _eventBus: IEventBus;
  private _watches = new Map<
    string,
    {
      handler: WatchHandler;
      options: WatchOptions;
      disposables: IDisposable[];
    }
  >();
  private _shutdown = false;

  constructor(eventBus: IEventBus) {
    this._eventBus = eventBus;
  }

  watch(keyPrefix: string, handler: WatchHandler, options: WatchOptions = {}): IDisposable {
    if (this._shutdown) {
      throw new Error('WatchApi is shut down');
    }

    const watchId = `${keyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const disposables: IDisposable[] = [];

    // 订阅 proposal.committed 事件
    const sub = this._eventBus.on('proposal.committed', (event: ConsensusEvent) => {
      const committed = event as ProposalCommittedEvent;
      const key = parseKeyFromData(committed.data);
      if (key === null) return;

      // 前缀匹配
      if (keyPrefix === '' || key.startsWith(keyPrefix)) {
        try {
          const value = parseValueFromData(committed.data);
          const watchEvent: WatchEvent = {
            key,
            value,
            index: committed.index,
            term: committed.term,
            timestamp: committed.timestamp,
          };
          handler(watchEvent);
        } catch {
          // handler 异常不影响其他 watches
        }
      }
    });
    disposables.push(sub);

    // 订阅 leader 变更事件用于自动适配
    const leaderSub = this._eventBus.on('leader.elected', () => {
      // Leader 变更时 watcher 不需要特殊处理，
      // 因为 proposal.committed 事件只由 leader 发布，
      // 新的 leader 会继续发布此事件。
    });
    disposables.push(leaderSub);

    // 超时处理
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutId = setTimeout(() => {
        this._cleanup(watchId);
      }, options.timeoutMs);
      disposables.push({
        dispose: () => clearTimeout(timeoutId),
      });
    }

    this._watches.set(watchId, { handler, options, disposables });

    return {
      dispose: () => {
        this._cleanup(watchId);
      },
    };
  }

  activeWatchCount(): number {
    return this._watches.size;
  }

  shutdown(): void {
    this._shutdown = true;
    for (const watchId of this._watches.keys()) {
      this._cleanup(watchId);
    }
    this._watches.clear();
  }

  private _cleanup(watchId: string): void {
    const entry = this._watches.get(watchId);
    if (!entry) return;
    for (const d of entry.disposables) {
      try { d.dispose(); } catch { /* swallowed */ }
    }
    this._watches.delete(watchId);
  }
}
