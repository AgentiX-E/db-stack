/**
 * Sharding seams, as the `@agentix-e/db-cluster/shard` subpath.
 *
 * The subpath was published in `package.json` for as long as the exports map has
 * had one, and this file did not exist: `dist/interfaces/shard/index.js` was
 * never emitted, so `import … from '@agentix-e/db-cluster/shard'` failed with
 * `ERR_MODULE_NOT_FOUND`. A published path is a promise; `pnpm check:public-types`
 * now resolves every `exports` target back to a source file.
 */
export type { IShardStrategy } from './IShardStrategy';
export type { IShardManager } from './IShardManager';
export type { IReshardPlanner, ReshardPlan, IMigrationProgress } from './IReshardPlanner';
export type { IOnlineShardMigration, IMigrationConfig } from './IOnlineShardMigration';
