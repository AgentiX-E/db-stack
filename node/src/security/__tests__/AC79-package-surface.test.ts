/**
 * AC79 — If the guide tells you to import a name, the package exports it.
 *
 * Section 3.4 of the user guide opens with
 *
 * ```ts
 * import { KeyManager, EnvelopeEncryptionProvider, KeyRotationManager }
 *   from "@agentix-e/db-node/security";
 * ```
 *
 * and section 3.5 with `AuditLogManager`. None of those four names was exported
 * from the package entry point. `packages/security/src/index.ts` exported the
 * seven in-memory fixtures and nothing else, so every documented snippet in the
 * two sections that matter most — encryption at rest, and the audit trail —
 * resolved to `undefined` for a real user.
 *
 * Nothing caught it because the suites import the implementation files directly
 * (`../impl/KeyManager.js`), which is the correct way to test a module and the
 * wrong way to find out whether the package has a surface. This case is the
 * difference: it imports the *package*, by the name a user types, and asserts
 * that each name the guide uses is there.
 *
 * The list is written out rather than derived from the guide, because a parser
 * that reads prose can be wrong in the same direction as the guide. When a
 * snippet gains an import, this list gains a line — that is the point.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as security from '../index.js';
import * as audit from '../../audit/index.js';
import * as barrel from '../../index.js';

/** Names the user guide imports from `@agentix-e/db-node/security`. */
const SECURITY_SURFACE = [
  'KeyManager',
  'EnvelopeEncryptionProvider',
  'AES256GCMEncryptionProvider',
  'KeyRotationManager',
  'RotationAuditor',
  'AuditLogManager',
  'RBACEngine',
  'InMemoryEncryptionManager',
  'InMemoryRBACProvider',
  'InMemoryRateLimiter',
] as const;

/**
 * Names the user guide imports from `@agentix-e/db-node/audit`.
 *
 * `readSegmentFromDisk` was on this list until iteration 54. The guide never
 * imported it — it is `FileAuditStore`'s default read port, an internal exported
 * from the package root for its own suite's benefit. A list whose comment says
 * "the user guide imports" and whose content includes something the guide does
 * not import is the same defect this file exists to catch, one level up: it made
 * an accidental export look intentional for two years.
 */
const AUDIT_SURFACE = ['FileAuditStore', 'InMemoryAuditStore'] as const;

/**
 * Internals that must not come back through the root.
 *
 * Nineteen of these were exported from `@agentix-e/db-node/audit` and named
 * by no document; the audit package's own suites import them from
 * `impl/FileAuditStore.js`, which is where a test of an internal belongs. This
 * case is the regression guard: a helper re-exported "just for a test" is how the
 * list got that long in the first place.
 */
const AUDIT_INTERNALS = [
  'archiveSegment',
  'fileIdentity',
  'gzipFile',
  'mtimeOf',
  'readSegmentFromDisk',
  'relateTwin',
  'shadowedPairs',
  'unlinkIfUnchanged',
] as const;

/** Constants the encryption section tells a reader to compare against. */
const SECURITY_CONSTANTS = [
  'MAX_DERIVATION_ITERATIONS',
  'MIN_SALT_BYTES',
  'MAX_SALT_BYTES',
  'MAX_CACHED_KEKS',
] as const;

describe('AC79.1–79.6: the package exports what the guide imports', () => {
  it('79.1 every documented security class resolves to a constructor', () => {
    for (const name of SECURITY_SURFACE) {
      const value = (security as Record<string, unknown>)[name];
      expect(typeof value, `${name} is not exported from @agentix-e/db-node/security`).toBe('function');
    }
  });

  it('79.2 every documented audit name resolves', () => {
    for (const name of AUDIT_SURFACE) {
      const value = (audit as Record<string, unknown>)[name];
      expect(typeof value, `${name} is not exported from @agentix-e/db-node/audit`).toBe('function');
    }
  });

  it('79.2b the audit package no longer publishes its internals', () => {
    for (const name of AUDIT_INTERNALS) {
      expect(
        (audit as Record<string, unknown>)[name],
        `${name} is an internal and must not be reachable from the package root`,
      ).toBeUndefined();
    }
  });

  it('79.3 the documented bounds are numbers, not types', () => {
    for (const name of SECURITY_CONSTANTS) {
      expect(typeof (security as Record<string, unknown>)[name], `${name} is not exported`).toBe('number');
    }
    expect(security.MAX_DERIVATION_ITERATIONS).toBeGreaterThan(600_000);
    expect(security.MIN_SALT_BYTES).toBeLessThan(security.MAX_SALT_BYTES);
    expect(security.MAX_CACHED_KEKS).toBeGreaterThan(0);
  });

  it('79.4 the barrel reaches the same classes under their module namespace', () => {
    // The umbrella that used to be asserted here — `@agentix-e/db-operations`, which
    // re-exported all three packages under one name — is gone: the three packages are
    // now three packages, and this one is `@agentix-e/db-node`. The namespace form is
    // still part of the surface, so it is still asserted: `node.security.KeyManager`
    // and `@agentix-e/db-node/security`'s `KeyManager` must be the same object, or the
    // barrel is exporting a second copy of a class whose instances would then fail
    // every `instanceof` the module's own code performs.
    expect(barrel.security.KeyManager).toBe(security.KeyManager);
    expect(barrel.audit.FileAuditStore).toBe(audit.FileAuditStore);
  });

  it('79.5 the exported encryption path works end to end from the package name', async () => {
    // Not a re-test of the crypto: a re-test of the wiring. An import that
    // resolves to the wrong module is indistinguishable from a working one until
    // something is actually sealed.
    const provider = new security.EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 'ac79-master', iterations: 1_000 },
      encryption: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' },
    });
    await provider.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });

    const sealed = await provider.encrypt(Buffer.from('sealed through the package'));
    expect((await provider.decrypt(sealed)).toString()).toBe('sealed through the package');
  });

  it('79.6 the exported audit store writes and reads back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac79-surface-'));
    try {
      const store = new audit.FileAuditStore({ dataDir: dir });
      const id = await store.write({
        operation: 'AC79',
        actor: 'surface-test',
        resource: '/db/orders',
        result: 'success',
      });

      expect((await store.get(id))?.id).toBe(id);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('79.7 the rest of the guide resolves too', async () => {
    // The same walk over the other packages section 3 imports from. One of them
    // was missing a name for the same reason (`security` exported its fixtures
    // and not its implementations) — a package can be complete and still have no
    // surface, and only an import by the documented name tells the two apart.
    const guide: Array<[string, readonly string[]]> = [
      ['../../core/index.js', ['ProviderRegistry', 'token']],
      ['../../health/index.js', ['HealthOrchestrator']],
      ['../../logger/index.js', ['InMemoryLogger']],
      ['../../backup/index.js', ['RetentionPolicyEvaluator', 'dependentsOf', 'unrestorableReason']],
      ['../../rollingupgrade/index.js', ['RollingUpgradeOrchestrator']],
      ['../../maintenance/index.js', ['MaintenanceWindowScheduler', 'parseCron']],
    ];

    for (const [packageName, names] of guide) {
      const module = (await import(packageName)) as Record<string, unknown>;
      for (const name of names) {
        expect(typeof module[name], `${name} is not exported from ${packageName}`).not.toBe('undefined');
      }
    }
  });
});
