/**
 * SessionManager — 共识会话管理器。
 * 
 * 提供高并发的 session 生命周期管理：
 * - O(1) create / get / delete
 * - 可配置的 TTL + 滑动过期
 * - exactly-once 过期回调
 * - 内存安全的批量清理
 *
 * @module consensus/session
 */

// ── 接口 ──────────────────────────────────────────────────────────

export interface SessionConfig {
  /** 会话存活时间 (ms) */
  ttlMs: number;
  /** 是否启用滑动过期（每次访问重置 TTL） */
  slidingExpiry?: boolean;
  /** 定期清理间隔 (ms)，0 表示不自动清理 */
  cleanupIntervalMs?: number;
  /** 最大并发 session 数，超过后拒绝创建 */
  maxSessions?: number;
}

export interface SessionEntry {
  id: string;
  createdAt: number;
  lastAccessAt: number;
  expiresAt: number;
  metadata: Record<string, unknown>;
}

export type SessionExpiryHandler = (session: SessionEntry) => void;

export interface ISessionManager {
  /**
   * 创建新 session。
   * @param id — 唯一标识
   * @param metadata — 附加元数据
   * @returns SessionEntry
   * @throws 如果 id 已存在或超过 maxSessions
   */
  create(id: string, metadata?: Record<string, unknown>): SessionEntry;

  /**
   * 获取 session（如果存在且未过期）。
   * 如果 slidingExpiry，自动延长过期时间。
   */
  get(id: string): SessionEntry | null;

  /**
   * 删除 session。
   * @returns 被删除的 session（如果存在且未过期）
   */
  delete(id: string): SessionEntry | null;

  /**
   * 延长 session 过期时间。
   */
  extend(id: string): boolean;

  /**
   * 注册过期回调（每个 session 只触发一次）。
   */
  onExpiry(handler: SessionExpiryHandler): () => void;

  /**
   * 获取当前活跃 session 数量。
   */
  activeCount(): number;

  /**
   * 强制清理所有过期 session。
   */
  cleanup(): number;

  /**
   * 关闭 session manager（停止定时清理、释放所有资源）。
   */
  shutdown(): void;
}

// ── 实现 ──────────────────────────────────────────────────────────

export class SessionManager implements ISessionManager {
  private _sessions = new Map<string, SessionEntry>();
  private _config: Required<SessionConfig>;
  private _expiryHandlers: SessionExpiryHandler[] = [];
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _shutdown = false;
  private _expiredIds = new Set<string>(); // exactly-once 保证

  constructor(config: SessionConfig) {
    this._config = {
      ttlMs: config.ttlMs,
      slidingExpiry: config.slidingExpiry ?? false,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 0,
      maxSessions: config.maxSessions ?? 0,
    };

    if (this._config.cleanupIntervalMs > 0) {
      this._cleanupTimer = setInterval(() => {
        if (!this._shutdown) this.cleanup();
      }, this._config.cleanupIntervalMs);
      // Node.js timer 不阻止进程退出
      if (this._cleanupTimer && typeof this._cleanupTimer === 'object') {
        (this._cleanupTimer as any).unref?.();
      }
    }
  }

  create(id: string, metadata: Record<string, unknown> = {}): SessionEntry {
    if (this._shutdown) {
      throw new Error('SessionManager is shut down');
    }

    // 先清理同一个 id 的旧 session
    if (this._sessions.has(id)) {
      throw new Error(`Session '${id}' already exists`);
    }

    // 检查容量
    if (this._config.maxSessions > 0 && this._sessions.size >= this._config.maxSessions) {
      // 尝试先清理过期 session
      this.cleanup();
      if (this._sessions.size >= this._config.maxSessions) {
        throw new Error(`Max sessions (${this._config.maxSessions}) reached`);
      }
    }

    const now = Date.now();
    const entry: SessionEntry = {
      id,
      createdAt: now,
      lastAccessAt: now,
      expiresAt: now + this._config.ttlMs,
      metadata,
    };

    this._sessions.set(id, entry);
    this._expiredIds.delete(id); // 如果是重新创建
    return { ...entry };
  }

  get(id: string): SessionEntry | null {
    if (this._shutdown) return null;

    const entry = this._sessions.get(id);
    if (!entry) return null;

    // 检查过期
    if (Date.now() > entry.expiresAt) {
      this._expireOne(entry);
      return null;
    }

    // 滑动过期：重置 TTL
    if (this._config.slidingExpiry) {
      entry.lastAccessAt = Date.now();
      entry.expiresAt = entry.lastAccessAt + this._config.ttlMs;
    }

    return { ...entry };
  }

  delete(id: string): SessionEntry | null {
    if (this._shutdown) return null;

    const entry = this._sessions.get(id);
    if (!entry) return null;

    this._sessions.delete(id);
    return { ...entry };
  }

  extend(id: string): boolean {
    if (this._shutdown) return false;

    const entry = this._sessions.get(id);
    if (!entry || Date.now() > entry.expiresAt) return false;

    entry.expiresAt = Date.now() + this._config.ttlMs;
    entry.lastAccessAt = Date.now();
    return true;
  }

  onExpiry(handler: SessionExpiryHandler): () => void {
    this._expiryHandlers.push(handler);
    return () => {
      const idx = this._expiryHandlers.indexOf(handler);
      if (idx >= 0) this._expiryHandlers.splice(idx, 1);
    };
  }

  activeCount(): number {
    return this._sessions.size;
  }

  cleanup(): number {
    if (this._shutdown) return 0;

    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of this._sessions) {
      if (now > entry.expiresAt) {
        this._sessions.delete(id);
        this._expireOne(entry);
        cleaned++;
      }
    }

    return cleaned;
  }

  shutdown(): void {
    this._shutdown = true;
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._sessions.clear();
    this._expiryHandlers = [];
    this._expiredIds.clear();
  }

  private _expireOne(entry: SessionEntry): void {
    // exactly-once：每个 session 只触发一次过期回调
    if (this._expiredIds.has(entry.id)) return;
    this._expiredIds.add(entry.id);

    for (const handler of this._expiryHandlers) {
      try {
        handler({ ...entry });
      } catch {
        // 回调异常不阻断其他处理
      }
    }
  }
}
