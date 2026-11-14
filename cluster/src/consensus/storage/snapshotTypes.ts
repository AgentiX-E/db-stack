/**
 * Snapshot types derived from the `@maboke123/raft-core` storage contract.
 *
 * raft-core re-exports `SnapshotStorage` from its root but not the
 * `SnapshotMetaData` / `Snapshot` interfaces it is built from, and its
 * `package.json` `exports` map forbids reaching into `dist/storage/...`.
 * Deriving the types from the interface we *are* allowed to import keeps a
 * single source of truth: if upstream widens the contract, these follow.
 */

import type { SnapshotStorage } from '@maboke123/raft-core';

/** Snapshot boundary metadata (`lastIncludedIndex` + `lastIncludedTerm`). */
export type SnapshotMetaData = NonNullable<Awaited<ReturnType<SnapshotStorage['readMetadata']>>>;

/** Full snapshot payload: metadata + serialized state + cluster config. */
export type Snapshot = NonNullable<Awaited<ReturnType<SnapshotStorage['load']>>>;
