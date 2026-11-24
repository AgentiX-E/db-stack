/**
 * D4 Config Watcher — production-grade configuration lifecycle manager.
 *
 * Types for schema validation, file watching, diff computation,
 * change events, notification filtering, and reload safety.
 *
 * @module @agentix-e/db-node/configwatcher/interfaces
 */

// ── Schema ──────────────────────────────────────────────────

/** Primitive schema type. */
export type SchemaType = 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';

/** Schema definition for a single config key. */
export interface SchemaField {
  /** Field type. */
  type: SchemaType;
  /** If true, null/undefined is acceptable. */
  nullable?: boolean;
  /** Comma-separated enum values (for string fields). */
  enum?: string[];
  /** Minimum value (number/integer). */
  min?: number;
  /** Maximum value (number/integer). */
  max?: number;
  /** Regex pattern (string). */
  pattern?: string;
  /** If true, value must be present. */
  required?: boolean;
  /** Default value if not provided. */
  default?: unknown;
  /** Human-readable description. */
  description?: string;
  /** Nested schema for 'object' type. */
  properties?: Record<string, SchemaField>;
  /** Item schema for 'array' type. */
  items?: SchemaField;
}

/** Top-level config schema as a map of key → field definition. */
export type ConfigSchema = Record<string, SchemaField>;

/** Human-readable validation result. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** Single validation error. */
export interface ValidationError {
  key: string;
  message: string;
  /** Expected type or value. */
  expected: string;
  /** Actual value found. */
  actual: string;
}

/** Soft warning (does not block). */
export interface ValidationWarning {
  key: string;
  message: string;
}

// ── File Watcher ────────────────────────────────────────────

/** Watch mode. */
export type WatchMode = 'poll' | 'inotify' | 'none';

/** Options for file-system watching. */
export interface FileWatchOptions {
  /** File paths to watch. */
  paths: string[];
  /** Watch mode. */
  mode?: WatchMode;
  /** Poll interval in ms (only for poll mode). */
  pollIntervalMs?: number;
  /** File formats to parse. */
  formats?: FileFormat[];
  /** Debounce ms before processing change (multiple writes). */
  debounceMs?: number;
  /**
   * Changes tolerated inside one debounce window before the reload is applied
   * rather than postponed again.
   *
   * A debounce with no ceiling is a reload that can be starved: a file written
   * more often than the window is long would never be read. The default is no
   * ceiling, which is right for a file edited by a human and wrong for one
   * rewritten by a sidecar — which is why the option exists at all.
   */
  maxChangesPerWindow?: number;
  /**
   * Parsers for the formats this package does not ship.
   *
   * `json` and `env` have built-in parsers and no dependencies, because this
   * package has no runtime dependencies. `yaml` and `toml` do not, and a file
   * whose format has no parser is reported as a failure rather than skipped:
   * "your watcher ignores this file" is something an operator has to be told,
   * not left to discover.
   */
  parsers?: Partial<Record<FileFormat, (text: string, path: string) => Record<string, unknown>>>;
}

/** Supported file formats. */
export type FileFormat = 'json' | 'yaml' | 'toml' | 'env';

// ── Change Event ────────────────────────────────────────────

/** Carrier of a detected config change. */
export interface ConfigChangeEvent {
  /** Config key that changed. */
  key: string;
  /** Previous value (undefined for new keys). */
  oldValue: unknown;
  /** New value (undefined for deleted keys). */
  newValue: unknown;
  /** Source of the change. */
  source: ChangeSource;
  /** Timestamp of change detection (ms since epoch). */
  timestamp: number;
  /** Key-level schema validation result. */
  validation: ValidationResult;
  /** Computed diff for complex objects. */
  diff?: KeyDiff;
}

/** Origin of the change. */
export type ChangeSource = 'file_watch' | 'programmatic' | 'reload' | 'rollback' | 'initial_load' | 'set';

// ── Diff ────────────────────────────────────────────────────

/** A patch diff for a single key. */
export interface KeyDiff {
  key: string;
  /** Type of change. */
  op: 'added' | 'removed' | 'changed' | 'unchanged';
  /** For changed: list of nested path changes. */
  changes?: FieldChange[];
  /** For objects: old and new snapshots. */
  oldSnapshot?: unknown;
  newSnapshot?: unknown;
}

/** A single field-level change within an object. */
export interface FieldChange {
  /** Dot-separated path within the object. */
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

// ── Notification Filter ─────────────────────────────────────

/** Filter for config change notifications. */
export interface NotificationFilter {
  /** Only watch specific key prefixes. */
  keyPrefixes?: string[];
  /** Only watch specific keys (exact match). */
  keys?: string[];
  /** Only watch keys matching glob patterns. */
  globPatterns?: string[];
  /** Minimum change severity to notify. */
  minSeverity?: ChangeSeverity;
  /** Suppress events from these sources. */
  excludeSources?: ChangeSource[];
}

/** Severity of a config change. */
export type ChangeSeverity = 'info' | 'warning' | 'critical';

// ── Reload Config ───────────────────────────────────────────

/** Outcome of an atomic reload. */
export interface ReloadResult {
  /** Whether the reload succeeded. */
  success: boolean;
  /** New config snapshot (only if successful). */
  snapshot?: Record<string, unknown>;
  /** Previous config snapshot (for rollback). */
  previousSnapshot: Record<string, unknown>;
  /** Per-key validation results. */
  validationResults: Record<string, ValidationResult>;
  /** List of keys that changed. */
  changedKeys: string[];
  /** List of keys that failed validation. */
  failedKeys: string[];
  /** Dry-run mode: changes computed but not applied. */
  dryRun: boolean;
}

// ── Config Snapshot Reference ───────────────────────────────

/** A stored checkpoint of config state. */
export interface ConfigCheckpoint {
  /** Checkpoint ID (auto-incrementing). */
  id: number;
  /** Full snapshot at this point. */
  snapshot: Record<string, unknown>;
  /** When the checkpoint was created. */
  timestamp: number;
  /** What caused the checkpoint (set, reload, rollback). */
  source: ChangeSource;
  /** Description / reason. */
  description?: string;
}

// ── Extended Watcher Interface ──────────────────────────────

/** Extended config watcher with schema, file watch, diff, and reload. */
export interface IConfigWatcherV2 {
  // ── Core (existing) ──
  watch(key: string, handler: ConfigChangeHandlerV2): void;
  unwatch(key: string, handler?: ConfigChangeHandlerV2): void;
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string): T | undefined;
  snapshot(): Record<string, unknown>;

  // ── Schema ──
  /** Register a schema for validation. */
  registerSchema(schema: ConfigSchema): void;
  /** Validate the current snapshot against the schema. */
  validateAll(): ValidationResult;
  /** Validate a single key. */
  validateKey(key: string, value: unknown): ValidationResult;

  // ── File Watch ──
  /** Start watching files for external changes. */
  startFileWatch(options: FileWatchOptions): void;
  /** Stop file watching. */
  stopFileWatch(): void;

  // ── Diff ──
  /** Compute diff between two snapshots. */
  diff(a: Record<string, unknown>, b: Record<string, unknown>): KeyDiff[];

  // ── Atomic Reload ──
  /** Atomic reload with validation. If dryRun=true, validate without applying. */
  reload(newValues: Record<string, unknown>, dryRun?: boolean): ReloadResult;

  // ── Rollback ──
  /** Rollback to the previous config checkpoint. */
  rollback(): ReloadResult;

  // ── Checkpoints ──
  /** Get all config checkpoints. */
  getCheckpoints(): ConfigCheckpoint[];
  /** Get the latest checkpoint. */
  getLatestCheckpoint(): ConfigCheckpoint | null;

  // ── Notification Filters ──
  /** Add a notification filter (filtered events won't fire handlers). */
  addNotificationFilter(filter: NotificationFilter): void;
  /** Remove a notification filter. */
  removeNotificationFilter(filter: NotificationFilter): void;

  // ── Stats ──
  /** Get watcher statistics. */
  getStats(): ConfigWatcherStats;
}

/** Core change handler: key plus the previous and new value. */
export type ConfigChangeHandler = (key: string, oldValue: unknown, newValue: unknown) => void;

/** Core (V1) config-watcher contract: watch / unwatch / set / get / snapshot. */
export interface IConfigWatcher {
  watch(key: string, handler: ConfigChangeHandler): void;
  unwatch(key: string, handler?: ConfigChangeHandler): void;
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string): T | undefined;
  snapshot(): Record<string, unknown>;
}

/** Enhanced change handler with metadata. */
export type ConfigChangeHandlerV2 = (event: ConfigChangeEvent) => void;

/** What one watched file has contributed, and what it last cost. */
export interface WatchedFileStatus {
  path: string;
  /** Format the watcher chose for the path, from its extension. `null` if it has none it knows. */
  format: FileFormat | null;
  /** Keys the file's most recent successful load contributed. */
  keys: number;
  /** Loads that found content different from the last one. The first read counts. */
  loads: number;
  /** When the file was last read and found different, or `null` before that. */
  lastLoadedAt: number | null;
  /** Why the last attempt to read this file failed, or `null` if it did not. */
  failure: string | null;
}

/**
 * What the watcher's file half is doing.
 *
 * Every field is a count of something that happened rather than a flag saying
 * the feature exists: a watcher that starts, polls, and reads nothing is exactly
 * the state this package shipped in — `_loadFiles()` was a comment — and a
 * `fileWatchActive: true` said so in the affirmative for a whole release.
 */
export interface FileWatchStats {
  /** Paths the watcher is polling. */
  paths: string[];
  /** Polls that found new content, summed over the watched files. */
  loads: number;
  /** One entry per path, whether or not it has ever loaded. */
  files: WatchedFileStatus[];
}

/** Statistics for the config watcher. */
export interface ConfigWatcherStats {
  totalKeys: number;
  totalWatchers: number;
  totalFilFilters: number;
  fileWatchActive: boolean;
  /** What the file half read, or `null` when no watch is running. */
  fileWatch: FileWatchStats | null;
  checkpoints: number;
  reloadCount: number;
  rollbackCount: number;
  lastChangeTimestamp: number | null;
}
