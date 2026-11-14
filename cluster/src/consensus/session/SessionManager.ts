/**
 * SessionManager — consensus session manager.
 *
 * Provides highly concurrent session lifecycle management:
 * - O(1) create / get / delete
 * - configurable TTL with sliding expiry
 * - exactly-once expiry callbacks
 * - memory-safe bulk cleanup
 *
 * @module consensus/session
 */

// ── Interfaces ─────────────────────────────────────────────────────

export interface SessionConfig {
  /** Session time-to-live (ms) */
  ttlMs: number;
  /** Whether sliding expiry is enabled (every access resets the TTL) */
  slidingExpiry?: boolean;
  /** Periodic cleanup interval (ms); 0 disables automatic cleanup */
  cleanupIntervalMs?: number;
  /** Maximum number of concurrent sessions; creation is rejected beyond it */
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
   * Create a new session.
   * @param id — unique identifier
   * @param metadata — caller-supplied metadata
   * @returns SessionEntry
   * @throws if the id already exists or maxSessions is exceeded
   */
  create(id: string, metadata?: Record<string, unknown>): SessionEntry;

  /**
   * Fetch a session if it exists and has not expired.
   * With slidingExpiry enabled the expiry is extended automatically.
   */
  get(id: string): SessionEntry | null;

  /**
   * Delete a session.
   * @returns the removed session (if it existed and had not expired)
   */
  delete(id: string): SessionEntry | null;

  /**
   * Extend the expiry of a session.
   */
  extend(id: string): boolean;

  /**
   * Register an expiry callback (fires at most once per session).
   */
  onExpiry(handler: SessionExpiryHandler): () => void;

  /**
   * Number of currently active sessions.
   */
  activeCount(): number;

  /**
   * Force a sweep of every expired session.
   */
  cleanup(): number;

  /**
   * Close the session manager (stops the timer and releases all resources).
   */
  shutdown(): void;
}

// ── Implementation ─────────────────────────────────────────────────

export class SessionManager implements ISessionManager {
  private _sessions = new Map<string, SessionEntry>();
  private _config: Required<SessionConfig>;
  private _expiryHandlers: SessionExpiryHandler[] = [];
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _shutdown = false;
  private _expiredIds = new Set<string>(); // exactly-once guarantee

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
      // A Node.js timer must not keep the process alive
      if (this._cleanupTimer && typeof this._cleanupTimer === 'object') {
        (this._cleanupTimer as any).unref?.();
      }
    }
  }

  create(id: string, metadata: Record<string, unknown> = {}): SessionEntry {
    if (this._shutdown) {
      throw new Error('SessionManager is shut down');
    }

    // Drop any previous session with the same id first
    if (this._sessions.has(id)) {
      throw new Error(`Session '${id}' already exists`);
    }

    // Enforce capacity
    if (this._config.maxSessions > 0 && this._sessions.size >= this._config.maxSessions) {
      // Try to reclaim expired sessions first
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
    this._expiredIds.delete(id); // the id is being created again
    return { ...entry };
  }

  get(id: string): SessionEntry | null {
    if (this._shutdown) return null;

    const entry = this._sessions.get(id);
    if (!entry) return null;

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      this._expireOne(entry);
      return null;
    }

    // Sliding expiry: reset the TTL
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
    // exactly-once: the expiry callback fires once per session
    if (this._expiredIds.has(entry.id)) return;
    this._expiredIds.add(entry.id);

    for (const handler of this._expiryHandlers) {
      try {
        handler({ ...entry });
      } catch {
        // A throwing callback must not block the rest of the sweep
      }
    }
  }
}
