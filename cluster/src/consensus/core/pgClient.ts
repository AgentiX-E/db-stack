/**
 * pgClient — the single place the optional `pg` dependency is obtained.
 *
 * `pg` is an *optional* dependency: a cluster that never forwards writes over
 * the PostgreSQL wire protocol must install and start without it. That rules
 * out a static `import`, so the module is loaded on demand.
 *
 * The on-demand load cannot use a bare `require`: this package is published as
 * ESM (`"type": "module"`), where `require` does not exist. A bare `require`
 * survives the test run — the test transform supplies one — and then throws
 * `ReferenceError: require is not defined in ES module scope` for every
 * consumer of the published artefact. `createRequire` is the ESM-blessed way to
 * reach a CommonJS module and is what makes the call legal in both places.
 *
 * Keeping the load here rather than inline at the call site has two further
 * consequences that are worth the file:
 *
 *   - The failure is *named*. "Cannot find module 'pg'" arriving from three
 *     frames deep inside a write path reads like a broken installation; the
 *     error below says which optional dependency is missing and what feature
 *     needed it.
 *   - Callers get a seam. The forwarding path takes the constructor from here,
 *     so a test can substitute a fake client without rewriting anything under
 *     `node_modules` (which is what the previous harness did, and which raced
 *     across worker threads).
 */

import { createRequire } from 'node:module';
import type { ClientConfig } from 'pg';

/** Connection settings accepted by the `pg` client. */
export type PgClientConfig = ClientConfig;

/**
 * The slice of `pg.Client` this package uses.
 *
 * Deliberately narrow: it is the whole surface multi-leader write forwarding
 * touches, so a fake needs five methods rather than a full driver.
 */
export interface PgClientLike {
  /** Register a connection-level error handler. */
  on(event: 'error', listener: (err: Error) => void): unknown;
  /** Open the TCP connection and complete authentication. */
  connect(): Promise<unknown>;
  /** Run one statement. */
  query(sql: string): Promise<unknown>;
  /** Close the connection. */
  end(): Promise<unknown>;
}

/** Constructor shape of `pg.Client`. */
export type PgClientConstructor = new (config: PgClientConfig) => PgClientLike;

/**
 * Resolves the `pg` module object. Replaced in tests to exercise the failure
 * modes without uninstalling a package.
 */
export type PgModuleResolver = () => unknown;

const nodeRequire = createRequire(import.meta.url);

function defaultResolver(): unknown {
  return nodeRequire('pg');
}

/**
 * Return the `pg` client constructor, or throw an error that names the cause.
 *
 * @param resolveModule - Module resolver; defaults to `require('pg')`.
 * @throws Error when `pg` is not installed, or when the module it resolves to
 *   has no usable `Client` export (a partially installed or shadowed package).
 */
export function loadPgClientConstructor(resolveModule: PgModuleResolver = defaultResolver): PgClientConstructor {
  let loaded: unknown;
  try {
    loaded = resolveModule();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Write forwarding to the shard leader needs the optional "pg" (node-postgres) dependency, ' +
        `and it could not be loaded: ${detail}. Install "pg" on every node that terminates the ` +
        'PostgreSQL protocol, or disable forwarding.',
      { cause: err },
    );
  }

  const client = (loaded as { Client?: unknown } | null | undefined)?.Client;
  if (typeof client !== 'function') {
    throw new Error(
      'The "pg" (node-postgres) module loaded, but it does not export a Client constructor. ' +
        'This usually means a partial installation or another package shadowing "pg"; ' +
        'reinstall the dependency.',
    );
  }
  return client as PgClientConstructor;
}
