/**
 * Type declarations for the plain-ESM test helper shared by every vitest setup.
 *
 * The implementation is `.mjs` on purpose: it is loaded by the vitest setup
 * files of four different packages and by the e2e harness, all of which run it
 * through Node's own ESM loader rather than through a TypeScript build. Declaring
 * the surface here keeps those call sites type-checked without `@ts-expect-error`.
 */

/** Absolute path of the scratch root used by `label`, created if missing. */
export declare function resolveTestTmpRoot(label: string): string;

/** Point `TMPDIR`/`TMP`/`TEMP` at the scratch root for `label` and return it. */
export declare function useTestTmpRoot(label: string): string;

/** Re-create `TMPDIR` if it was removed; returns the path that now exists. */
export declare function ensureTestTmpRoot(): string;

/**
 * A directory shared by every worker thread of this process, created if missing.
 *
 * Coordination, not scratch: the port pool must be visible to every thread, or
 * two of them lease the same port.
 */
export declare function resolveSharedTempDir(kind: string): string;
