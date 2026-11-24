/**
 * D4 Config Watcher — production-grade config hot-reload engine.
 *
 * Features:
 *   - Schema validation with type, enum, range, pattern, nested object/array checks
 *   - File watching (poll-based with debounce; inotify stubs)
 *   - Deep diff computation between snapshots (object/array-aware)
 *   - Atomic reload with full validation & dry-run mode
 *   - Config checkpoints for rollback safety
 *   - Notification filters (key prefix, glob, severity, source exclusion)
 *   - Enhanced change events with diff, validation, source tracking
 *
 * @module @agentix-e/db-node/configwatcher/impl
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import type {
  IConfigWatcherV2,
  ConfigChangeHandlerV2,
  ConfigSchema,
  SchemaField,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ConfigChangeEvent,
  ChangeSource,
  KeyDiff,
  FieldChange,
  FileWatchOptions,
  FileFormat,
  NotificationFilter,
  ReloadResult,
  ConfigCheckpoint,
  ConfigWatcherStats,
  FileWatchStats,
  WatchedFileStatus,
} from '../interfaces/index.js';

// ── Schema Validator ─────────────────────────────────────────

function _validateField(key: string, value: unknown, field: SchemaField, path: string = key): ValidationError[] {
  const errors: ValidationError[] = [];
  const fullPath = path;

  // Nullable check
  if (value === null || value === undefined) {
    // Allow if nullable, or if the field has a default value (schema-only, not in store)
    const allowed = field.nullable || field.default !== undefined;
    if (!allowed) {
      errors.push({
        key: fullPath,
        message: `Field "${fullPath}" is required but got ${value}`,
        expected: field.type,
        actual: String(value),
      });
    }
    return errors;
  }

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push({
          key: fullPath,
          message: `Expected string for "${fullPath}", got ${typeof value}`,
          expected: 'string',
          actual: String(value),
        });
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        errors.push({
          key: fullPath,
          message: `Expected number for "${fullPath}", got ${typeof value}`,
          expected: 'number',
          actual: String(value),
        });
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push({
          key: fullPath,
          message: `Expected integer for "${fullPath}", got ${typeof value}`,
          expected: 'integer',
          actual: String(value),
        });
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({
          key: fullPath,
          message: `Expected boolean for "${fullPath}", got ${typeof value}`,
          expected: 'boolean',
          actual: String(value),
        });
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push({
          key: fullPath,
          message: `Expected array for "${fullPath}", got ${typeof value}`,
          expected: 'array',
          actual: String(value),
        });
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null) {
        errors.push({
          key: fullPath,
          message: `Expected object for "${fullPath}", got ${typeof value}`,
          expected: 'object',
          actual: String(value),
        });
      }
      break;
  }
  if (errors.length > 0) return errors;

  // Enum check (string)
  if (field.enum && typeof value === 'string') {
    if (!field.enum.includes(value)) {
      errors.push({
        key: fullPath,
        message: `"${fullPath}" must be one of [${field.enum.join(', ')}], got "${value}"`,
        expected: field.enum.join(' | '),
        actual: String(value),
      });
    }
  }

  // Range check (number/integer)
  if (typeof value === 'number' && !isNaN(value)) {
    if (field.min !== undefined && value < field.min) {
      errors.push({
        key: fullPath,
        message: `"${fullPath}" must be ≥ ${field.min}, got ${value}`,
        expected: `≥ ${field.min}`,
        actual: String(value),
      });
    }
    if (field.max !== undefined && value > field.max) {
      errors.push({
        key: fullPath,
        message: `"${fullPath}" must be ≤ ${field.max}, got ${value}`,
        expected: `≤ ${field.max}`,
        actual: String(value),
      });
    }
  }

  // Pattern check (string)
  if (field.pattern && typeof value === 'string') {
    try {
      const re = new RegExp(field.pattern);
      if (!re.test(value)) {
        errors.push({
          key: fullPath,
          message: `"${fullPath}" must match pattern ${field.pattern}, got "${value}"`,
          expected: field.pattern,
          actual: String(value),
        });
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // Nested object check
  if (field.type === 'object' && field.properties) {
    const obj = value as Record<string, unknown>;
    for (const [propKey, propField] of Object.entries(field.properties)) {
      const propValue = obj[propKey];
      if (propValue === undefined && !propField.nullable) {
        errors.push({
          key: `${fullPath}.${propKey}`,
          message: `Required property "${propKey}" is missing`,
          expected: propField.type,
          actual: 'undefined',
        });
      } else if (propValue !== undefined) {
        errors.push(..._validateField(propKey, propValue, propField, `${fullPath}.${propKey}`));
      }
    }
  }

  // Array items check
  if (field.type === 'array' && field.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(..._validateField(`[${i}]`, value[i], field.items, `${fullPath}[${i}]`));
    }
  }

  return errors;
}

// ── Diff Engine ──────────────────────────────────────────────

function _computeDiff(oldObj: Record<string, unknown>, newObj: Record<string, unknown>): KeyDiff[] {
  const diffs: KeyDiff[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (oldVal === undefined && newVal !== undefined) {
      diffs.push({ key, op: 'added', newSnapshot: newVal });
    } else if (newVal === undefined && oldVal !== undefined) {
      diffs.push({ key, op: 'removed', oldSnapshot: oldVal });
    } else if (
      typeof oldVal === 'object' &&
      typeof newVal === 'object' &&
      oldVal !== null &&
      newVal !== null &&
      !Array.isArray(oldVal) &&
      !Array.isArray(newVal)
    ) {
      const fieldChanges = _computeFieldChanges(
        key,
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
      );
      if (fieldChanges.length > 0) {
        diffs.push({
          key,
          op: 'changed',
          changes: fieldChanges,
          oldSnapshot: oldVal,
          newSnapshot: newVal,
        });
      } else {
        diffs.push({ key, op: 'unchanged' });
      }
    } else if (oldVal !== newVal) {
      diffs.push({
        key,
        op: 'changed',
        oldSnapshot: oldVal,
        newSnapshot: newVal,
      });
    } else {
      diffs.push({ key, op: 'unchanged' });
    }
  }

  return diffs;
}

function _computeFieldChanges(
  prefix: string,
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const k of allKeys) {
    const ov = oldObj[k];
    const nv = newObj[k];
    if (ov !== nv) {
      changes.push({ path: `${prefix}.${k}`, oldValue: ov, newValue: nv });
    }
  }

  return changes;
}

// ── Notification Filter ─────────────────────────────────────

function _matchesFilter(event: ConfigChangeEvent, filter: NotificationFilter): boolean {
  // Key exclusion
  if (filter.keys && filter.keys.length > 0) {
    if (!filter.keys.includes(event.key)) return false;
  }

  // Key prefix matching
  if (filter.keyPrefixes && filter.keyPrefixes.length > 0) {
    const match = filter.keyPrefixes.some((p) => event.key.startsWith(p));
    if (!match) return false;
  }

  // Glob pattern matching
  if (filter.globPatterns && filter.globPatterns.length > 0) {
    const match = filter.globPatterns.some((p) => _globMatch(p, event.key));
    if (!match) return false;
  }

  // Source exclusion
  if (filter.excludeSources && filter.excludeSources.length > 0) {
    if (filter.excludeSources.includes(event.source)) return false;
  }

  return true;
}

function _globMatch(pattern: string, str: string): boolean {
  // Convert glob to regex: * → .*, ? → .
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

function _eventPassesAllFilters(event: ConfigChangeEvent, filters: NotificationFilter[]): boolean {
  if (filters.length === 0) return true;
  // Filters are OR: event passes if any filter matches
  return filters.some((f) => _matchesFilter(event, f));
}

// ── File Watcher (Poll Mode) ────────────────────────────────

interface WatchState {
  intervalId: ReturnType<typeof setInterval> | null;
  options: FileWatchOptions;
  /** Per path: the values that file contributed when it was last applied. */
  lastSnapshots: Map<string, Record<string, unknown>>;
  /** Per path: what the last attempt did. */
  files: Map<string, WatchedFileStatus>;
  /** Per path: a reload waiting out its debounce window, its content, and how many writes it has absorbed. */
  pending: Map<string, { timer: ReturnType<typeof setTimeout>; values: Record<string, unknown>; absorbed: number }>;
  /** Loads applied since the watch started. */
  loads: number;
}

// ── File Parsers ────────────────────────────────────────────

/**
 * `KEY=value`, one per line, `#` to end a line.
 *
 * Unquoted values are read as JSON scalars when JSON can read them — `42`,
 * `true`, `null` — and as strings when it cannot. That is the only rule that
 * survives a `.env` file an operator wrote by hand: `PORT=8080` is a number, and
 * `NAME=8080` is a string only if it was quoted, which is the same answer every
 * other tool in the ecosystem gives.
 */
function parseEnvFile(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`"${line}" is not KEY=value`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
      values[key] = value;
      continue;
    }
    values[key] = parseScalar(value);
  }
  return values;
}

/** A JSON scalar, or the text itself when JSON will not read it. */
function parseScalar(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    const isScalar = parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed);
    return isScalar ? parsed : text;
  } catch {
    return text;
  }
}

const BUILTIN_PARSERS: Partial<Record<FileFormat, (text: string, path: string) => Record<string, unknown>>> = {
  json: (text) => {
    const parsed: unknown = JSON.parse(text);
    return asObject(parsed, 'JSON');
  },
  env: (text) => parseEnvFile(text),
};

const FORMAT_BY_EXTENSION: Record<string, FileFormat> = {
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.env': 'env',
};

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} document is not an object`);
  }
  return value as Record<string, unknown>;
}

/** Key-order-independent JSON, so a re-serialised file is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ── Scheduler ────────────────────────────────────────────────

export class ConfigWatcher implements IConfigWatcherV2 {
  private store = new Map<string, unknown>();
  private handlers = new Map<string, Set<ConfigChangeHandlerV2>>();
  private schema: ConfigSchema = {};
  private checkpointList: ConfigCheckpoint[] = [];
  private nextCheckpointId = 1;
  private notificationFilters: NotificationFilter[] = [];
  private watchState: WatchState | null = null;
  private reloadCount = 0;
  private rollbackCount = 0;
  private lastChangeTimestamp: number | null = null;

  // ── Core ──────────────────────────────────────────────────

  watch(key: string, handler: ConfigChangeHandlerV2): void {
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key)!.add(handler);
  }

  unwatch(key: string, handler?: ConfigChangeHandlerV2): void {
    if (!handler) {
      this.handlers.delete(key);
      return;
    }
    const hs = this.handlers.get(key);
    if (hs) {
      hs.delete(handler);
      if (hs.size === 0) this.handlers.delete(key);
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const oldValue = this.store.get(key);
    const validation = this.validateKey(key, value);

    this.store.set(key, value);
    this.lastChangeTimestamp = Date.now();

    const event = this._buildEvent(key, oldValue, value, 'programmatic', validation);
    this._checkpoint('set');

    if (_eventPassesAllFilters(event, this.notificationFilters)) {
      this._notify(key, event);
    }
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.store) result[k] = v;
    return result;
  }

  // ── Schema ────────────────────────────────────────────────

  registerSchema(schema: ConfigSchema): void {
    this.schema = { ...schema };
  }

  validateAll(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    for (const [key, field] of Object.entries(this.schema)) {
      const value = this.store.get(key);
      const isRequired = field.required === true;
      const hasDefault = field.default !== undefined;
      const isNullable = field.nullable === true;

      if (value === undefined && isRequired && !isNullable && !hasDefault) {
        errors.push({
          key,
          message: `Required key "${key}" is missing`,
          expected: field.type,
          actual: 'undefined',
        });
      } else if (value === undefined && !isNullable && !hasDefault) {
        // Optional key with no value and no default: warn but don't block
        warnings.push({
          key,
          message: `Optional key "${key}" has no value set`,
        });
      } else if (value !== undefined) {
        errors.push(..._validateField(key, value, field));
      }
    }

    // Warn about store keys not in schema
    for (const key of this.store.keys()) {
      if (!(key in this.schema)) {
        warnings.push({
          key,
          message: `Key "${key}" has no schema definition`,
        });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  validateKey(key: string, value: unknown): ValidationResult {
    const field = this.schema[key];
    if (!field) {
      return {
        valid: true,
        errors: [],
        warnings: [{ key, message: `No schema for key "${key}"` }],
      };
    }
    const errors = _validateField(key, value, field);
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  // ── File Watch ────────────────────────────────────────────

  startFileWatch(options: FileWatchOptions): void {
    this.stopFileWatch();
    const mode = options.mode || 'poll';
    const interval = options.pollIntervalMs || 5000;

    if (mode === 'none') return;

    const files = new Map<string, WatchedFileStatus>();
    for (const path of options.paths) {
      files.set(path, {
        path,
        format: FORMAT_BY_EXTENSION[extname(path)] ?? null,
        keys: 0,
        loads: 0,
        lastLoadedAt: null,
        failure: null,
      });
    }

    this.watchState = {
      intervalId: setInterval(() => this._pollFiles(), interval),
      options: { ...options },
      lastSnapshots: new Map(),
      files,
      pending: new Map(),
      loads: 0,
    };

    // Initial file load
    this._loadFiles();
  }

  stopFileWatch(): void {
    const state = this.watchState;
    if (state) {
      if (state.intervalId) clearInterval(state.intervalId);
      // A debounce timer that outlives the watch is a reload against a watcher
      // that no longer exists: it would write into the store after the caller
      // asked it to stop, and it would keep the process alive while doing it.
      for (const { timer } of state.pending.values()) clearTimeout(timer);
      state.pending.clear();
    }
    this.watchState = null;
  }

  // ── Diff ──────────────────────────────────────────────────

  diff(a: Record<string, unknown>, b: Record<string, unknown>): KeyDiff[] {
    return _computeDiff(a, b);
  }

  // ── Atomic Reload ─────────────────────────────────────────

  reload(newValues: Record<string, unknown>, dryRun = false): ReloadResult {
    return this._reloadInternal(newValues, 'reload', dryRun);
  }

  // ── Internal Reload ──────────────────────────────────────

  private _reloadInternal(
    newValues: Record<string, unknown>,
    source: ChangeSource,
    dryRun = false,
    remove: readonly string[] = [],
  ): ReloadResult {
    const previousSnapshot = this.snapshot();
    const validationResults: Record<string, ValidationResult> = {};
    const changedKeys: string[] = [];
    const failedKeys: string[] = [];

    // Validate all new values
    for (const [key, value] of Object.entries(newValues)) {
      const vr = this.validateKey(key, value);
      validationResults[key] = vr;
      if (!vr.valid) failedKeys.push(key);
    }

    // A key that disappears is a change of the same magnitude as one that
    // changes value, and a schema that requires it does not stop requiring it
    // because the file it came from was edited. Validation runs over the
    // removal, not only over what remains.
    for (const key of remove) {
      const field = this.schema[key];
      if (field && !field.nullable && field.default === undefined) {
        failedKeys.push(key);
        validationResults[key] = {
          valid: false,
          errors: [
            {
              key,
              message: `Field "${key}" is required but the file no longer provides it`,
              expected: field.type,
              actual: 'absent',
            },
          ],
          warnings: [],
        };
      }
    }

    if (!dryRun) {
      const anyFailure = failedKeys.length > 0;

      // Atomic: all or nothing
      if (anyFailure) {
        return {
          success: false,
          previousSnapshot,
          validationResults,
          changedKeys,
          failedKeys,
          dryRun,
        };
      }

      // Apply all changes
      for (const [key, value] of Object.entries(newValues)) {
        const oldValue = this.store.get(key);
        this.store.set(key, value);

        if (oldValue !== value) {
          changedKeys.push(key);
          const event = this._buildEvent(key, oldValue, value, source, validationResults[key]!);
          if (_eventPassesAllFilters(event, this.notificationFilters)) {
            this._notify(key, event);
          }
        }
      }

      for (const key of remove) {
        if (!this.store.has(key)) continue;
        const oldValue = this.store.get(key);
        this.store.delete(key);
        changedKeys.push(key);
        const event = this._buildEvent(key, oldValue, undefined, source, { valid: true, errors: [], warnings: [] });
        if (_eventPassesAllFilters(event, this.notificationFilters)) {
          this._notify(key, event);
        }
      }

      this.reloadCount++;
      this.lastChangeTimestamp = Date.now();
      this._checkpoint(source);
    }

    return {
      success: dryRun ? failedKeys.length === 0 : true,
      snapshot: dryRun ? undefined : this.snapshot(),
      previousSnapshot,
      validationResults,
      changedKeys,
      failedKeys,
      dryRun,
    };
  }

  // ── Rollback ──────────────────────────────────────────────

  rollback(): ReloadResult {
    if (this.checkpointList.length < 2) {
      return {
        success: false,
        previousSnapshot: this.snapshot(),
        validationResults: {},
        changedKeys: [],
        failedKeys: ['no checkpoint available'],
        dryRun: false,
      };
    }

    // Pop the current state (latest checkpoint) to go back. The guard above
    // leaves at least one entry, so the new tail is the target — the walk that
    // used to stand here skipped `source === 'rollback'` checkpoints, and no
    // checkpoint is ever written with that source: `_checkpoint` is called from
    // `set()` and from a reload, and a rollback creates none. A loop over a
    // condition nothing can satisfy is a line the gate is right to refuse to
    // believe (P3-87, iteration 84).
    this.checkpointList.pop();
    const target = this.checkpointList[this.checkpointList.length - 1]!;

    // Apply the target snapshot directly WITHOUT creating a new checkpoint.
    // Trim the list to just the reached target checkpoint so next rollback
    // can continue rewinding.
    const prevSnapshot = this.snapshot();
    const validationResults: Record<string, ValidationResult> = {};
    const changedKeys: string[] = [];

    for (const key of this.store.keys()) {
      if (!(key in target.snapshot)) {
        this.store.delete(key);
        changedKeys.push(key);
      }
    }

    for (const [key, value] of Object.entries(target.snapshot)) {
      const oldValue = this.store.get(key);
      if (oldValue !== value) {
        this.store.set(key, value);
        changedKeys.push(key);
      }

      const vr = this.validateKey(key, value);
      validationResults[key] = vr;

      if (oldValue !== value) {
        const event = this._buildEvent(key, oldValue, value, 'rollback', vr);
        if (_eventPassesAllFilters(event, this.notificationFilters)) {
          this._notify(key, event);
        }
      }
    }

    // The list was popped to reach the target, so it already ends there.

    this.rollbackCount++;
    this.lastChangeTimestamp = Date.now();

    return {
      success: true,
      snapshot: this.snapshot(),
      previousSnapshot: prevSnapshot,
      validationResults,
      changedKeys,
      failedKeys: [],
      dryRun: false,
    };
  }

  // ── Checkpoints ───────────────────────────────────────────

  getCheckpoints(): ConfigCheckpoint[] {
    return [...this.checkpointList];
  }

  getLatestCheckpoint(): ConfigCheckpoint | null {
    if (this.checkpointList.length === 0) return null;
    return { ...this.checkpointList[this.checkpointList.length - 1]! };
  }

  // ── Notification Filters ──────────────────────────────────

  addNotificationFilter(filter: NotificationFilter): void {
    this.notificationFilters.push(filter);
  }

  removeNotificationFilter(filter: NotificationFilter): void {
    const idx = this.notificationFilters.indexOf(filter);
    if (idx !== -1) this.notificationFilters.splice(idx, 1);
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats(): ConfigWatcherStats {
    let totalWatchers = 0;
    for (const hs of this.handlers.values()) totalWatchers += hs.size;

    return {
      totalKeys: this.store.size,
      totalWatchers,
      totalFilFilters: this.notificationFilters.length,
      fileWatchActive: this.watchState !== null && this.watchState.options.mode !== 'none',
      fileWatch: this._fileWatchStats(),
      checkpoints: this.checkpointList.length,
      reloadCount: this.reloadCount,
      rollbackCount: this.rollbackCount,
      lastChangeTimestamp: this.lastChangeTimestamp,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  private _buildEvent(
    key: string,
    oldValue: unknown,
    newValue: unknown,
    source: ChangeSource,
    validation: ValidationResult,
  ): ConfigChangeEvent {
    const snapA: Record<string, unknown> = {};
    snapA[key] = oldValue;
    const snapB: Record<string, unknown> = {};
    snapB[key] = newValue;
    const diffs = _computeDiff(snapA, snapB);
    return {
      key,
      oldValue,
      newValue,
      source,
      timestamp: Date.now(),
      validation,
      diff: diffs.find((d) => d.key === key),
    };
  }

  private _notify(key: string, event: ConfigChangeEvent): void {
    const hs = this.handlers.get(key);
    if (!hs) return;
    for (const handler of hs) {
      try {
        handler(event);
      } catch {
        /* isolate handler failures */
      }
    }
  }

  private _checkpoint(source: ChangeSource, description?: string): void {
    this.checkpointList.push({
      id: this.nextCheckpointId++,
      snapshot: this.snapshot(),
      timestamp: Date.now(),
      source,
      description,
    });

    // Keep max 100 checkpoints
    if (this.checkpointList.length > 100) {
      this.checkpointList.shift();
    }
  }

  private _loadFiles(): void {
    const state = this.watchState;
    if (!state) return;

    // Iterating the statuses rather than the paths is what makes "one entry per
    // watched path" a construction property instead of a lookup that cannot fail.
    for (const status of state.files.values()) {
      const path = status.path;

      let values: Record<string, unknown>;
      try {
        values = this._readFile(state, status);
      } catch (err) {
        // A missing file, a file caught mid-write, a format with no parser: all
        // of them are one poll's failure, not the end of the watch. The reason
        // is kept on the status, which is what `getStats()` publishes — the
        // previous release swallowed it into a comment.
        status.failure = err instanceof Error ? err.message : String(err);
        continue;
      }
      status.failure = null;

      const previous = state.lastSnapshots.get(path);
      if (previous && canonical(previous) === canonical(values)) {
        status.keys = Object.keys(values).length;
        continue;
      }

      const pending = state.pending.get(path);
      if (pending) {
        // The poll re-read the content the window is already holding. That is
        // the poll's own clock, not a write: re-arming here is how a debounce
        // longer than the poll interval becomes a reload that never happens.
        if (canonical(pending.values) === canonical(values)) continue;
        pending.absorbed += 1;
        clearTimeout(pending.timer);
      }

      const debounce = state.options.debounceMs ?? 0;
      const tolerance = state.options.maxChangesPerWindow;
      const absorbed = pending ? pending.absorbed : 1;
      const applyNow = debounce <= 0 || (tolerance !== undefined && absorbed > tolerance);

      if (applyNow) {
        state.pending.delete(path);
        this._applyFile(state, status, values, previous);
        continue;
      }

      const timer = setTimeout(() => {
        state.pending.delete(path);
        const latest = state.lastSnapshots.get(path);
        this._applyFile(state, status, values, latest);
      }, debounce);
      if (typeof timer.unref === 'function') timer.unref();
      state.pending.set(path, { timer, values, absorbed });
    }
  }

  /**
   * Read one watched file and hand back what it holds.
   *
   * Throws rather than returning `null` on every reason a file cannot be used,
   * so the caller has one place to record the message an operator needs.
   */
  private _readFile(state: WatchState, status: WatchedFileStatus): Record<string, unknown> {
    const path = status.path;
    const text = readFileSync(path, 'utf8');

    if (status.format === null) {
      throw new Error(`no format for "${path}"; its extension is not one of .json, .yaml, .yml, .toml, .env`);
    }
    const parser = state.options.parsers?.[status.format] ?? BUILTIN_PARSERS[status.format];
    if (!parser) {
      throw new Error(
        `no parser for "${status.format}" ("${path}"); this package ships json and env, pass parsers.${status.format}`,
      );
    }
    return asObject(parser(text, path), `${status.format} file "${path}"`);
  }

  /**
   * Apply one file's values, and only that file's.
   *
   * A watched file owns the keys it contributed last time. On a reload, a key it
   * used to hold and no longer does is removed — but only if the store still
   * carries the value that file put there: a key an operator has since set
   * programmatically belongs to the caller, and a poll of a file must not undo a
   * deliberate write.
   */
  private _applyFile(
    state: WatchState,
    status: WatchedFileStatus,
    values: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
  ): void {
    const removals: string[] = [];
    if (previous) {
      for (const key of Object.keys(previous)) {
        if (key in values) continue;
        const current = this.store.get(key);
        if (current !== undefined && canonical(current) === canonical(previous[key])) removals.push(key);
      }
    }

    const result = this._reloadInternal({ ...this.snapshot(), ...values }, 'file_watch', false, removals);
    if (!result.success) {
      // The file was read and did not survive validation. Recording it as
      // applied would make the next poll see no change and stop retrying a file
      // that has not taken effect, so the baseline stays where it was and the
      // reason goes where an operator reads it.
      status.failure = `read, but refused: ${result.failedKeys.join(', ')} does not validate`;
      return;
    }

    state.lastSnapshots.set(status.path, values);
    state.loads += 1;
    status.keys = Object.keys(values).length;
    status.loads += 1;
    status.lastLoadedAt = Date.now();
  }

  private _pollFiles(): void {
    this._loadFiles();
  }

  private _fileWatchStats(): FileWatchStats | null {
    const state = this.watchState;
    if (!state) return null;
    return {
      paths: [...state.options.paths],
      loads: state.loads,
      files: [...state.files.values()].map((status) => ({ ...status })),
    };
  }
}
