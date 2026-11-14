/**
 * Typed access to the CRC32 implementation used by the WAL integrity checks.
 *
 * `buffer-crc32` ships an `export =` declaration inside `dist/index.d.mts`
 * (and points its `exports.types` at it). `export =` is not valid in a module
 * declared as ESM, so TypeScript reports TS1192 ("no default export") for the
 * obvious `import crc32 from 'buffer-crc32'`. Loading the CJS build through
 * `createRequire` sidesteps the broken declaration while keeping a single,
 * fully typed call site for the storage layer.
 */

import { createRequire } from 'node:module';

export interface Crc32 {
  (input: Buffer | string, partialCrc?: Buffer | number): Buffer;
  signed(input: Buffer | string): number;
  unsigned(input: Buffer | string, partialCrc?: number): number;
}

const nodeRequire = createRequire(import.meta.url);

/** CRC32 of a buffer; `unsigned` returns the classic 32-bit integer form. */
export const crc32 = nodeRequire('buffer-crc32') as Crc32;
