/**
 * pgClient — the one place the optional `pg` dependency is obtained.
 *
 * Why this file exists
 * --------------------
 * Multi-leader write forwarding talks to the leader through the PostgreSQL wire
 * protocol, which means a driver. `pg` is declared as an *optional* dependency:
 * a cluster that only ever writes to its own leader must install and run
 * without it. Optional means "load it when needed", and the way the code loaded
 * it — a bare `require('pg')` — does not exist in this package's module system.
 *
 * The failure was invisible for the length of a release cycle because the test
 * transform supplies a `require`: every test passed, and every *consumer* got
 * `ReferenceError: require is not defined in ES module scope` on the first
 * forwarded write. A test that runs in an environment more capable than the
 * runtime proves nothing about the runtime.
 *
 * Acceptance criteria:
 *   AC 55.1  the default resolver returns the installed `pg` Client constructor
 *   AC 55.2  a missing dependency is reported as a missing optional dependency,
 *            naming the feature that needed it and preserving the cause
 *   AC 55.3  a module without a Client constructor is reported differently from
 *            a module that could not be loaded at all
 *   AC 55.4  a resolver that yields nothing at all is the same failure as
 *            AC 55.3, not a crash on property access
 *   AC 55.5  the constructor that comes back is usable: it produces a client
 *            with the four methods forwarding calls, without opening a socket
 *   AC 55.6  a non-function Client export is refused (typeof check, not truthiness)
 */

import { describe, it, expect } from 'vitest';
import { Client as RealPgClient } from 'pg';
import { loadPgClientConstructor, type PgClientConfig } from '../../consensus/core/pgClient';

const connection: PgClientConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'postgres',
  connectionTimeoutMillis: 100,
};

describe('loadPgClientConstructor', () => {
  it('AC 55.1: default resolver returns the installed pg Client constructor', () => {
    const Client = loadPgClientConstructor();
    expect(Client).toBe(RealPgClient);
  });

  it('AC 55.2: a missing dependency names the optional dependency and the feature, and keeps the cause', () => {
    const cause = Object.assign(new Error("Cannot find module 'pg'"), { code: 'MODULE_NOT_FOUND' });
    let thrown: unknown;
    try {
      loadPgClientConstructor(() => {
        throw cause;
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('optional "pg"');
    expect(message).toContain('Write forwarding');
    expect(message).toContain("Cannot find module 'pg'");
    expect((thrown as Error).cause).toBe(cause);
  });

  it('AC 55.3: a module without a Client constructor is not reported as a missing module', () => {
    let thrown: unknown;
    try {
      loadPgClientConstructor(() => ({ Pool: class {} }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('does not export a Client constructor');
    expect(message).not.toContain('could not be loaded');
  });

  it('AC 55.4: a resolver yielding nothing is the same named failure, not a property-access crash', () => {
    for (const empty of [undefined, null]) {
      let thrown: unknown;
      try {
        loadPgClientConstructor(() => empty);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('does not export a Client constructor');
    }
  });

  it('AC 55.5: the constructor produces a client with the four methods forwarding uses', () => {
    // Construction alone is offline: `pg` opens the socket in connect(). This
    // asserts the shape forwarding depends on, not a connection.
    const Client = loadPgClientConstructor();
    const client = new Client(connection);
    expect(typeof client.on).toBe('function');
    expect(typeof client.connect).toBe('function');
    expect(typeof client.query).toBe('function');
    expect(typeof client.end).toBe('function');
  });

  it('AC 55.6: a non-function Client export is refused', () => {
    for (const bogus of [{ Client: 'not-a-constructor' }, { Client: 42 }, { Client: null }]) {
      expect(() => loadPgClientConstructor(() => bogus)).toThrow(/does not export a Client constructor/);
    }
  });

  it('AC 55.7: a loader that throws something other than an Error is still reported by name', () => {
    // A module loader can throw a non-Error; turning that into "undefined" in the
    // message would leave the operator with a failure that names nothing.
    class LoaderFailure {
      constructor(private readonly detail: string) {}
      toString(): string {
        return `LoaderFailure(${this.detail})`;
      }
    }
    expect(() =>
      loadPgClientConstructor(() => {
        throw new LoaderFailure('loader exploded');
      }),
    ).toThrow(/loader exploded/);
  });
});
