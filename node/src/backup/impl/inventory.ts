/**
 * The inventory record — how a bucket remembers what it holds.
 *
 * A `BackupManager` used to keep its snapshots in a `Map` on the instance. Everything
 * about that map was right except its lifetime: the artefacts stayed in the bucket,
 * the digest that proves them stayed in the bucket, and the one thing that could name
 * them was in the heap of the process that took them. Restart the process and
 * `restoreFromSnapshot` answered `not found` for a backup this same binary had written
 * an hour earlier.
 *
 * The record is the fix, and it is deliberately one object per snapshot rather than
 * one manifest for the bucket:
 *
 *   - **one manifest is a read-modify-write.** Two workers taking backups at the same
 *     time would each read it, each add their entry, and the second write would erase
 *     the first — a lost snapshot under a green test, which is the failure mode this
 *     whole package exists to not have.
 *   - **a record is write-once and immutable.** The key is derived from the snapshot
 *     id, so two writers cannot collide, and nobody ever rewrites one. A listing is
 *     the bucket's own `list`, which is the only authority there is.
 *
 * What a record does *not* defend against is stated rather than implied: it carries
 * the artefact's SHA-256, so a corrupted record makes a restore fail the digest check
 * rather than succeed against the wrong bytes. It is not signed — an actor who can
 * rewrite the record can also rewrite the digest — and the same limit the audit
 * trail's chain has applies here.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import type { BackupMetadata, SnapshotState, SnapshotType } from '../../core/types.js';

/**
 * Format marker, and the version of the record's shape.
 *
 * A record written by a future build must be *rejected*, not half-read: `parseRecord`
 * compares this exactly, so a build that does not know a field's meaning says so
 * instead of silently dropping it.
 */
export const INVENTORY_FORMAT = 'db-node/backup/inventory/v1';

/** Directory under the backup prefix that holds the records. */
export const INVENTORY_DIR = 'inventory';

const TYPES: readonly SnapshotType[] = ['full', 'incremental', 'logical'];
const STATES: readonly SnapshotState[] = ['pending', 'in-progress', 'completed', 'failed', 'verifying', 'verified'];

/** Key of the record for a snapshot. */
export function inventoryKey(prefix: string, snapshotId: string): string {
  return `${prefix}/${INVENTORY_DIR}/${snapshotId}.json`;
}

/** Prefix every record key starts with, which is what a hydrate lists. */
export function inventoryPrefix(prefix: string): string {
  return `${prefix}/${INVENTORY_DIR}/`;
}

/**
 * The snapshot id a record key names, or `null` if the key is not one.
 *
 * `null` rather than a guess: a listing under the inventory prefix that is not a
 * record is a file somebody put there, and deriving an id from its last path segment
 * would turn `notes.json` into a snapshot called `notes`.
 */
export function inventoryIdOf(prefix: string, key: string): string | null {
  const head = inventoryPrefix(prefix);
  if (!key.startsWith(head) || !key.endsWith('.json')) return null;
  const id = key.slice(head.length, -'.json'.length);
  if (id.length === 0 || id.includes('/')) return null;
  return id;
}

/** Why a record could not be read. */
export class InventoryRecordError extends Error {
  constructor(
    readonly key: string,
    detail: string,
  ) {
    super(`${key}: ${detail}`);
    this.name = 'InventoryRecordError';
  }
}

/** The bytes of a record. */
export function serializeRecord(snapshot: BackupMetadata): string {
  // Pretty-printed because a record is ten lines and the person reading one is
  // usually reading it with `cat` at three in the morning.
  return `${JSON.stringify({ format: INVENTORY_FORMAT, snapshot }, null, 2)}\n`;
}

function field(source: Record<string, unknown>, name: string, key: string): unknown {
  if (!(name in source)) throw new InventoryRecordError(key, `the snapshot has no ${name}`);
  return source[name];
}

function text(source: Record<string, unknown>, name: string, key: string): string {
  const value = field(source, name, key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new InventoryRecordError(key, `${name} is not a non-empty string`);
  }
  return value;
}

function optionalText(source: Record<string, unknown>, name: string, key: string): string | undefined {
  if (!(name in source)) return undefined;
  return text(source, name, key);
}

/**
 * A length: a whole, non-negative number of bytes or files.
 *
 * The two refusals are separate sentences because they are separate problems — a size
 * that is the string `"4096"` is a record written by something that did not serialise a
 * number, and `-1` is a record whose arithmetic went wrong — and an operator triaging a
 * bucket acts differently on each. `Number.isInteger` is false for `4096.5`, for `NaN`
 * and for `Infinity` as well as for a string, so it is the range check *and* the type
 * check for the second sentence, while the first exists to narrow the type for it.
 */
function count(source: Record<string, unknown>, name: string, key: string): number {
  const value = field(source, name, key);
  if (typeof value !== 'number') {
    throw new InventoryRecordError(key, `${name} is not a number (${String(value)})`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new InventoryRecordError(key, `${name} is not a length (${String(value)})`);
  }
  return value;
}

/**
 * Read a record back into metadata, refusing anything that is not one.
 *
 * The checks are per field rather than a schema library's, so the error names the
 * field and the value that failed — a damaged record is a thing an operator has to be
 * able to find and delete, and "invalid record" is not enough to act on. Every field
 * is validated because every field is *used*: `facts` is dereferenced by
 * `pitr(targetLsn)`, `createdAt` by `pitr(targetTime)`, `location` by a restore.
 */
export function parseRecord(id: string, raw: string): BackupMetadata {
  const key = id;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // `String(error)` on a `SyntaxError` reads `SyntaxError: Unexpected end of JSON
    // input`, which names the parser as well as the problem.
    throw new InventoryRecordError(key, `not JSON (${String(error)})`);
  }
  // An array is an object to `typeof`, and a record is not an array: without this,
  // `[]` would be reported as a record with no format, which sends a reader looking
  // for a field in something that never had one.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InventoryRecordError(key, 'not an object');
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope['format'] !== INVENTORY_FORMAT) {
    throw new InventoryRecordError(key, `format ${String(envelope['format'])} is not ${INVENTORY_FORMAT}`);
  }
  const snapshot = envelope['snapshot'];
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new InventoryRecordError(key, 'the record carries no snapshot');
  }
  const source = snapshot as Record<string, unknown>;

  const snapshotId = text(source, 'snapshotId', key);
  // The key is the identity. A record that names a different snapshot is one that was
  // copied or renamed, and trusting either half of it is a coin toss.
  if (snapshotId !== id) {
    throw new InventoryRecordError(key, `this record names ${snapshotId}, not the snapshot its key names`);
  }

  const type = text(source, 'type', key);
  if (!TYPES.includes(type as SnapshotType)) throw new InventoryRecordError(key, `type ${type} is not known`);
  const state = text(source, 'state', key);
  if (!STATES.includes(state as SnapshotState)) throw new InventoryRecordError(key, `state ${state} is not known`);

  const record: BackupMetadata = {
    snapshotId,
    type: type as SnapshotType,
    state: state as SnapshotState,
    createdAt: text(source, 'createdAt', key),
    sizeBytes: count(source, 'sizeBytes', key),
    fileCount: count(source, 'fileCount', key),
    location: text(source, 'location', key),
  };
  const completedAt = optionalText(source, 'completedAt', key);
  if (completedAt !== undefined) record.completedAt = completedAt;
  const parentSnapshotId = optionalText(source, 'parentSnapshotId', key);
  if (parentSnapshotId !== undefined) record.parentSnapshotId = parentSnapshotId;
  const checksum = optionalText(source, 'checksum', key);
  if (checksum !== undefined) record.checksum = checksum;

  if ('facts' in source) {
    const facts = source['facts'];
    if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
      throw new InventoryRecordError(key, 'facts is not an object');
    }
    const recorded: Record<string, string> = {};
    for (const [name, value] of Object.entries(facts as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new InventoryRecordError(key, `fact ${name} is not a string`);
      recorded[name] = value;
    }
    record.facts = recorded;
  }

  return record;
}
