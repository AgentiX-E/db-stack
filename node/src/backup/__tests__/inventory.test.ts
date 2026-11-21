/**
 * The inventory record's reader, one refused shape at a time.
 *
 * `AC 94` proves a manager keeps working with a damaged record in its bucket. This file
 * is the other half: every field of the format is validated because every field is
 * *used* — `facts` is dereferenced by `pitr(targetLsn)`, `createdAt` by
 * `pitr(targetTime)`, `location` by a restore — and a reader that let a `facts: 42`
 * through would fail somewhere else, later, with a stack trace instead of a reason.
 *
 * The cases are a table because the claim is uniform: a record that is not a record is
 * refused, and the refusal names the field and the value. What differs between them is
 * only which sentence an operator gets to read.
 *
 *   IR.1  a round trip keeps every field, optional ones included
 *   IR.2  a round trip of a record with no optional fields leaves them absent
 *   IR.3  every malformed record is refused, with the sentence that names the problem
 *   IR.4  a key that is not a record key names no snapshot
 *   IR.5  the key and the record have to agree about which snapshot this is
 */

import { describe, it, expect } from 'vitest';

import {
  INVENTORY_FORMAT,
  InventoryRecordError,
  inventoryIdOf,
  inventoryKey,
  inventoryPrefix,
  parseRecord,
  serializeRecord,
} from '../impl/inventory.js';
import type { BackupMetadata } from '../../core/types.js';

const FULL: BackupMetadata = {
  snapshotId: 'snap-1',
  type: 'full',
  state: 'completed',
  createdAt: '2026-11-21T12:00:00.000Z',
  completedAt: '2026-11-21T12:00:01.000Z',
  sizeBytes: 4096,
  fileCount: 3,
  parentSnapshotId: 'snap-0',
  location: 'backups/full/snap-1.artifact',
  checksum: 'a'.repeat(64),
  facts: { lsn: '16/B374D848', 'dir.files': '3' },
};

/** A record holding `snapshot`, which the cases below bend one field at a time. */
function record(snapshot: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: INVENTORY_FORMAT, snapshot: { snapshotId: 'snap-1', ...snapshot } });
}

/**
 * A record whose `sizeBytes` is the given JSON number literal.
 *
 * `JSON.stringify` rewrites `Infinity` and `NaN` as `null`, so a row that needs one of
 * them on the wire has to write the literal itself. Only the number is spliced in; every
 * other field still goes through `record`, so a row cannot pass for the wrong reason.
 */
function rawSize(literal: string): string {
  return record({
    type: 'full',
    state: 'completed',
    createdAt: 'x',
    sizeBytes: 0,
    fileCount: 0,
    location: 'k',
  }).replace('"sizeBytes":0', `"sizeBytes":${literal}`);
}

describe('AC 98 — the inventory record', () => {
  it('IR.1: a round trip keeps every field, optional ones included', () => {
    expect(parseRecord('snap-1', serializeRecord(FULL))).toEqual(FULL);
  });

  it('IR.2: a record with no optional fields leaves them absent, not undefined', () => {
    const bare: BackupMetadata = {
      snapshotId: 'snap-1',
      type: 'incremental',
      state: 'completed',
      createdAt: '2026-11-21T12:00:00.000Z',
      sizeBytes: 0,
      fileCount: 0,
      location: 'backups/incremental/snap-1.artifact',
    };
    const parsed = parseRecord('snap-1', serializeRecord(bare));
    expect(parsed).toEqual(bare);
    // Absent rather than present-and-undefined: the difference is whether
    // `'parentSnapshotId' in snapshot` is true, and retention asks that question.
    expect('parentSnapshotId' in parsed).toBe(false);
    expect('checksum' in parsed).toBe(false);
    expect('facts' in parsed).toBe(false);
    // `completedAt` too: a record that carried the key with an `undefined` value would
    // satisfy `toEqual`, because the comparison ignores an undefined property — and a
    // reader that asked `'completedAt' in snapshot` would then say a snapshot is still
    // running when it has finished.
    expect('completedAt' in parsed).toBe(false);
    // A zero-length snapshot is valid metadata: an empty directory backs up to an
    // artefact with a manifest and no files.
    expect(parsed.sizeBytes).toBe(0);
  });

  it('IR.3: every malformed record is refused, with the sentence that names the problem', () => {
    const cases: Array<{ name: string; raw: string; reason: RegExp }> = [
      { name: 'not JSON at all', raw: '{"format":', reason: /not JSON \(SyntaxError/ },
      { name: 'a JSON scalar', raw: '5', reason: /not an object/ },
      { name: 'a JSON array', raw: '[]', reason: /not an object/ },
      { name: 'null', raw: 'null', reason: /not an object/ },
      {
        name: 'no format',
        raw: JSON.stringify({ snapshot: { snapshotId: 'snap-1' } }),
        reason: /format undefined is not/,
      },
      {
        name: 'another format version',
        raw: JSON.stringify({ format: 'db-node/backup/inventory/v2', snapshot: { snapshotId: 'snap-1' } }),
        reason: /format db-node\/backup\/inventory\/v2 is not/,
      },
      { name: 'no snapshot', raw: JSON.stringify({ format: INVENTORY_FORMAT }), reason: /carries no snapshot/ },
      {
        name: 'a null snapshot',
        raw: JSON.stringify({ format: INVENTORY_FORMAT, snapshot: null }),
        reason: /carries no snapshot/,
      },
      { name: 'no snapshotId', raw: record({ snapshotId: undefined }), reason: /the snapshot has no snapshotId/ },
      { name: 'a numeric snapshotId', raw: record({ snapshotId: 7 }), reason: /snapshotId is not a non-empty string/ },
      { name: 'an unknown type', raw: record({ type: 'differential' }), reason: /type differential is not known/ },
      { name: 'no state', raw: record({ type: 'full' }), reason: /the snapshot has no state/ },
      {
        name: 'a numeric state',
        raw: record({ type: 'full', state: 3 }),
        reason: /state is not a non-empty string/,
      },
      {
        name: 'an unknown state',
        raw: record({ type: 'full', state: 'done' }),
        reason: /state done is not known/,
      },
      {
        name: 'no createdAt',
        raw: record({ type: 'full', state: 'completed' }),
        reason: /the snapshot has no createdAt/,
      },
      {
        name: 'a negative size, which is not a length',
        raw: record({ type: 'full', state: 'completed', createdAt: 'x', sizeBytes: -1, fileCount: 0, location: 'k' }),
        reason: /sizeBytes is not a length \(-1\)/,
      },
      {
        name: 'a size that is not a number',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: '4096',
          fileCount: 0,
          location: 'k',
        }),
        reason: /sizeBytes is not a number \(4096\)/,
      },
      {
        name: 'a size that is null, which `typeof` calls an object',
        raw: record({ type: 'full', state: 'completed', createdAt: 'x', sizeBytes: null, fileCount: 0, location: 'k' }),
        reason: /sizeBytes is not a number \(null\)/,
      },
      {
        name: 'a size above the double range, which JSON parses to Infinity',
        // `JSON.stringify` writes `Infinity` as `null`, so the literal goes in by hand:
        // this is the one row that can tell `Number.isInteger` from a range check.
        raw: rawSize('1e999'),
        reason: /sizeBytes is not a length \(Infinity\)/,
      },
      {
        name: 'a fractional size, which is not a count of bytes',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 4096.5,
          fileCount: 0,
          location: 'k',
        }),
        reason: /sizeBytes is not a length \(4096\.5\)/,
      },
      {
        name: 'no fileCount',
        raw: record({ type: 'full', state: 'completed', createdAt: 'x', sizeBytes: 1, location: 'k' }),
        reason: /the snapshot has no fileCount/,
      },
      {
        name: 'no location',
        raw: record({ type: 'full', state: 'completed', createdAt: 'x', sizeBytes: 1, fileCount: 0 }),
        reason: /the snapshot has no location/,
      },
      {
        name: 'a completedAt that is not a string',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          completedAt: 0,
        }),
        reason: /completedAt is not a non-empty string/,
      },
      {
        name: 'a parentSnapshotId that is not a string',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          parentSnapshotId: {},
        }),
        reason: /parentSnapshotId is not a non-empty string/,
      },
      {
        name: 'an empty checksum, which is no checksum',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          checksum: '',
        }),
        reason: /checksum is not a non-empty string/,
      },
      {
        name: 'facts that are an array',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          facts: [],
        }),
        reason: /facts is not an object/,
      },
      {
        name: 'facts that are null, which `typeof` calls an object',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          facts: null,
        }),
        reason: /facts is not an object/,
      },
      {
        name: 'facts that are a string',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          facts: 'lsn=1',
        }),
        reason: /facts is not an object/,
      },
      {
        name: 'a fact whose value is not a string',
        raw: record({
          type: 'full',
          state: 'completed',
          createdAt: 'x',
          sizeBytes: 1,
          fileCount: 0,
          location: 'k',
          facts: { lsn: 16 },
        }),
        reason: /fact lsn is not a string/,
      },
    ];

    for (const { name, raw, reason } of cases) {
      // The message is the assertion: a reader that said "invalid record" would leave
      // an operator with a bucket, a key and nothing to do next.
      expect(() => parseRecord('snap-1', raw), name).toThrow(reason);
      // Every refusal is the same type, so a caller can tell damage from a bug.
      expect(() => parseRecord('snap-1', raw), name).toThrow(InventoryRecordError);
    }
  });

  it('IR.4: a key that is not a record key names no snapshot', () => {
    expect(inventoryPrefix('backups')).toBe('backups/inventory/');
    expect(inventoryKey('backups', 'snap-1')).toBe('backups/inventory/snap-1.json');
    expect(inventoryIdOf('backups', 'backups/inventory/snap-1.json')).toBe('snap-1');

    // Everything a listing under that prefix could contain that is not one of ours.
    expect(inventoryIdOf('backups', 'backups/inventory/notes.txt')).toBeNull();
    expect(inventoryIdOf('backups', 'backups/full/snap-1.artifact')).toBeNull();
    // A nested key is not a record: deriving an id from its last segment would turn
    // `backups/inventory/old/snap-1.json` into a snapshot called `snap-1`.
    expect(inventoryIdOf('backups', 'backups/inventory/old/snap-1.json')).toBeNull();
    // `.json` with nothing in front of it is not a name.
    expect(inventoryIdOf('backups', 'backups/inventory/.json')).toBeNull();
  });

  it('IR.6: the error names itself and the record it was reading', () => {
    // A caller distinguishes damage from a bug by the class, and an operator
    // distinguishes one damaged record from another by the message.
    const error = new InventoryRecordError('backups/inventory/x.json', 'the snapshot has no type');
    expect(error.name).toBe('InventoryRecordError');
    expect(error.key).toBe('backups/inventory/x.json');
    expect(error.message).toBe('backups/inventory/x.json: the snapshot has no type');
    expect(error).toBeInstanceOf(Error);
  });

  it('IR.5: the key and the record have to agree about which snapshot this is', () => {
    // A record copied or renamed under another id: trusting the record would make
    // `restoreFromSnapshot(a)` restore b's bytes, and trusting the key would restore
    // a's from b's record. Neither half is worth a coin toss, so it is refused.
    expect(() => parseRecord('snap-2', serializeRecord(FULL))).toThrow(
      /snap-2: this record names snap-1, not the snapshot its key names/,
    );
  });
});
