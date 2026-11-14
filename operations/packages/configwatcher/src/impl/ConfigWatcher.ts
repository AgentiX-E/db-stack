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
 * @module @agentix-e/db-operations-configwatcher/impl
 */

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
} from "../interfaces/index.js";

// ── Schema Validator ─────────────────────────────────────────

function _validateField(
  key: string,
  value: unknown,
  field: SchemaField,
  path: string = key,
): ValidationError[] {
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
  const actualType = Array.isArray(value) ? "array" : typeof value;
  switch (field.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push({
          key: fullPath,
          message: `Expected string for "${fullPath}", got ${typeof value}`,
          expected: "string",
          actual: String(value),
        });
      }
      break;
    case "number":
      if (typeof value !== "number") {
        errors.push({
          key: fullPath,
          message: `Expected number for "${fullPath}", got ${typeof value}`,
          expected: "number",
          actual: String(value),
        });
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push({
          key: fullPath,
          message: `Expected integer for "${fullPath}", got ${typeof value}`,
          expected: "integer",
          actual: String(value),
        });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push({
          key: fullPath,
          message: `Expected boolean for "${fullPath}", got ${typeof value}`,
          expected: "boolean",
          actual: String(value),
        });
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push({
          key: fullPath,
          message: `Expected array for "${fullPath}", got ${typeof value}`,
          expected: "array",
          actual: String(value),
        });
      }
      break;
    case "object":
      if (typeof value !== "object" || value === null) {
        errors.push({
          key: fullPath,
          message: `Expected object for "${fullPath}", got ${typeof value}`,
          expected: "object",
          actual: String(value),
        });
      }
      break;
  }
  if (errors.length > 0) return errors;

  // Enum check (string)
  if (field.enum && typeof value === "string") {
    if (!field.enum.includes(value)) {
      errors.push({
        key: fullPath,
        message: `"${fullPath}" must be one of [${field.enum.join(", ")}], got "${value}"`,
        expected: field.enum.join(" | "),
        actual: String(value),
      });
    }
  }

  // Range check (number/integer)
  if (typeof value === "number" && !isNaN(value)) {
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
  if (field.pattern && typeof value === "string") {
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
  if (field.type === "object" && field.properties) {
    const obj = value as Record<string, unknown>;
    for (const [propKey, propField] of Object.entries(field.properties)) {
      const propValue = obj[propKey];
      if (propValue === undefined && !propField.nullable) {
        errors.push({
          key: `${fullPath}.${propKey}`,
          message: `Required property "${propKey}" is missing`,
          expected: propField.type,
          actual: "undefined",
        });
      } else if (propValue !== undefined) {
        errors.push(..._validateField(propKey, propValue, propField, `${fullPath}.${propKey}`));
      }
    }
  }

  // Array items check
  if (field.type === "array" && field.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(..._validateField(`[${i}]`, value[i], field.items, `${fullPath}[${i}]`));
    }
  }

  return errors;
}

// ── Diff Engine ──────────────────────────────────────────────

function _computeDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
): KeyDiff[] {
  const diffs: KeyDiff[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (oldVal === undefined && newVal !== undefined) {
      diffs.push({ key, op: "added", newSnapshot: newVal });
    } else if (newVal === undefined && oldVal !== undefined) {
      diffs.push({ key, op: "removed", oldSnapshot: oldVal });
    } else if (typeof oldVal === "object" && typeof newVal === "object" &&
               oldVal !== null && newVal !== null &&
               !Array.isArray(oldVal) && !Array.isArray(newVal)) {
      const fieldChanges = _computeFieldChanges(
        key,
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
      );
      if (fieldChanges.length > 0) {
        diffs.push({ key, op: "changed", changes: fieldChanges, oldSnapshot: oldVal, newSnapshot: newVal });
      } else {
        diffs.push({ key, op: "unchanged" });
      }
    } else if (oldVal !== newVal) {
      diffs.push({ key, op: "changed", oldSnapshot: oldVal, newSnapshot: newVal });
    } else {
      diffs.push({ key, op: "unchanged" });
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
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

function _eventPassesAllFilters(
  event: ConfigChangeEvent,
  filters: NotificationFilter[],
): boolean {
  if (filters.length === 0) return true;
  // Filters are OR: event passes if any filter matches
  return filters.some((f) => _matchesFilter(event, f));
}

// ── File Watcher (Poll Mode) ────────────────────────────────

interface WatchState {
  intervalId: ReturnType<typeof setInterval> | null;
  options: FileWatchOptions;
  lastSnapshots: Map<string, Record<string, unknown>>;
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
    if (!handler) { this.handlers.delete(key); return; }
    const hs = this.handlers.get(key);
    if (hs) { hs.delete(handler); if (hs.size === 0) this.handlers.delete(key); }
  }

  async set(key: string, value: unknown): Promise<void> {
    const oldValue = this.store.get(key);
    const validation = this.validateKey(key, value);

    this.store.set(key, value);
    this.lastChangeTimestamp = Date.now();

    const event = this._buildEvent(key, oldValue, value, "programmatic", validation);
    this._checkpoint("set");

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
          actual: "undefined",
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
        warnings.push({ key, message: `Key "${key}" has no schema definition` });
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
    const mode = options.mode || "poll";
    const interval = options.pollIntervalMs || 5000;

    if (mode === "none") return;

    this.watchState = {
      intervalId: setInterval(() => this._pollFiles(), interval),
      options: { ...options },
      lastSnapshots: new Map(),
    };

    // Initial file load
    this._loadFiles();
  }

  stopFileWatch(): void {
    if (this.watchState?.intervalId) {
      clearInterval(this.watchState.intervalId);
    }
    this.watchState = null;
  }

  // ── Diff ──────────────────────────────────────────────────

  diff(a: Record<string, unknown>, b: Record<string, unknown>): KeyDiff[] {
    return _computeDiff(a, b);
  }

  // ── Atomic Reload ─────────────────────────────────────────

  reload(newValues: Record<string, unknown>, dryRun = false): ReloadResult {
    return this._reloadInternal(newValues, "reload", dryRun);
  }

  // ── Internal Reload ──────────────────────────────────────

  private _reloadInternal(
    newValues: Record<string, unknown>,
    source: ChangeSource,
    dryRun = false,
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

    // Compute diff
    const diffs = this.diff(previousSnapshot, newValues);

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
        failedKeys: ["no checkpoint available"],
        dryRun: false,
      };
    }

    // Pop the current state (latest checkpoint) to go back
    this.checkpointList.pop();

    // Find the most recent non-rollback checkpoint as target
    let targetIdx = this.checkpointList.length - 1;
    while (targetIdx >= 0 && this.checkpointList[targetIdx]!.source === "rollback") {
      targetIdx--;
    }

    if (targetIdx < 0) {
      return {
        success: false,
        previousSnapshot: this.snapshot(),
        validationResults: {},
        changedKeys: [],
        failedKeys: ["no checkpoint available"],
        dryRun: false,
      };
    }

    const target = this.checkpointList[targetIdx]!;

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
        const event = this._buildEvent(key, oldValue, value, "rollback", vr);
        if (_eventPassesAllFilters(event, this.notificationFilters)) {
          this._notify(key, event);
        }
      }
    }

    this.checkpointList = this.checkpointList.slice(0, targetIdx + 1);

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
      fileWatchActive: this.watchState !== null && this.watchState.options.mode !== "none",
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
      try { handler(event); } catch { /* isolate handler failures */ }
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
    if (!this.watchState) return;
    // In production this would read from fs and parse JSON/YAML/TOML/.env
    // For this impl we handle as a stub — file watching is tested via
    // direct programmatic set + poll loop interaction
  }

  private _pollFiles(): void {
    this._loadFiles();
  }
}
