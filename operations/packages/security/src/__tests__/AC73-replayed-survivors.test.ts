/**
 * AC 73 — the survivors, replayed instead of retyped.
 *
 * Iteration 30 concluded that five "survived" verdicts were wrong, because the
 * same change applied by hand made tests fail. The conclusion was wrong and the
 * reason is instructive: the change applied by hand was written against the line
 * number in the report, and the file had moved two lines since. The statement
 * reported as surviving at `AuditLogManager.ts:167` was
 * `stats.eventsBySeverity[x] = (stats.eventsBySeverity[x] || 0) + 1`; the change
 * that was applied and observed to fail was `if (!event.success)` at line 169,
 * which the runner had killed all along.
 *
 * `scripts/replay-mutant.mjs` exists so this cannot happen again: it applies the
 * report's recorded range and replacement text, not a line number. Every case
 * below was chosen by replaying one recorded survivor and asking what a caller
 * would notice if the recorded edit were real.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';
import { KeyManager } from '../impl/KeyManager.js';
import type { AuditEvent } from '../interfaces/IAuditLogger.js';
import type { EncryptionConfig } from '../interfaces/index.js';
import { unlinkIfUnchanged, fileIdentity } from '@agentix-e/db-operations-audit';

const CONFIG: EncryptionConfig = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' };
const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac73-'));
  tmpdirs.push(dir);
  return dir;
}

function draft(overrides: Record<string, unknown> = {}): Parameters<AuditLogManager['log']>[0] {
  return {
    category: 'system',
    severity: 'info',
    action: 'AC73',
    message: 'ac73',
    actor: { id: 'alice' },
    resource: { type: 'table', id: 'orders' },
    success: true,
    ...overrides,
  } as Parameters<AuditLogManager['log']>[0];
}

function eventsOf(manager: AuditLogManager): AuditEvent[] {
  return Reflect.get(manager, 'events') as AuditEvent[];
}

describe('AC 73 — statistics count every event', () => {
  it('73.1 two events of one severity count as two', async () => {
    const manager = new AuditLogManager({ logFilePath: path.join(scratch(), 'a.jsonl') });
    await manager.log(draft({ severity: 'info' }));
    await manager.log(draft({ severity: 'info' }));
    await manager.log(draft({ severity: 'warning' }));

    const stats = await manager.getStats();

    // The recording survivor at `AuditLogManager.ts:167` replaced
    // `(eventsBySeverity[s] || 0)` with `false`, so every bucket reported one
    // event no matter how many it held: `false + 1`. Nothing logged the same
    // severity twice, so nothing noticed.
    expect(stats.eventsBySeverity).toEqual({ info: 2, warning: 1 });
    expect(stats.eventsByCategory).toEqual({ system: 3 });
    expect(stats.eventsByActor).toEqual({ alice: 3 });
    manager.destroy();
  });

  it('73.2 a count under a retention anchor names the index it failed at', async () => {
    const manager = new AuditLogManager({ logFilePath: path.join(scratch(), 'b.jsonl') });
    for (let i = 0; i < 4; i += 1) await manager.log(draft({ action: `E${i}` }));
    const events = eventsOf(manager);

    // Anchor the chain at seq 1, then drop the second retained link. A lost link
    // that is not the first one is the only case that exercises the index term.
    Reflect.set(manager, 'anchor', {
      removedEvents: 1,
      lastRemovedSeq: 1,
      lastRemovedHash: events[0]!.hash,
      at: Date.now(),
    });
    events.splice(0, 1); // seq 1, as the anchor claims
    events.splice(1, 1); // seq 3 — not the first retained link

    const result = await manager.verifyIntegrity();

    expect(result.errors).toContain('seq gap at index 1: expected 3, got 4');
    expect(result.valid).toBe(false);
    manager.destroy();
  });

  it('73.3 flushing an empty buffer writes no line', async () => {
    const file = path.join(scratch(), 'c.jsonl');
    const manager = new AuditLogManager({ logFilePath: file });

    await manager.flush();

    // `flush()` guarded on an empty buffer; without the guard it appends the
    // joined empty string plus a newline, which is a blank line — the one thing
    // an NDJSON reader cannot recover from.
    expect(fs.existsSync(file)).toBe(false);
    manager.destroy();
  });
});

describe('AC 73 — a key version number is a promise about material', () => {
  it('73.4 names the lengths it accepts', () => {
    // The recorded survivor emptied the accepted-length list
    // (`[...DATA_KEY_BYTES]` → `[]`) and the separator below it, so the message
    // read "must be one of  (got 20)" while still throwing.
    expect(() => new KeyManager({ masterSecret: 's', keyLength: 20 })).toThrow(
      'KeyManager: keyLength must be one of 16, 24, 32 (got 20)',
    );
  });

  it('73.5 accepts the smallest legitimate iteration count', async () => {
    // `iterations < 1` was mutated to `<= 1` and survived: nothing used 1.
    const km = new KeyManager({ masterSecret: 's', iterations: 1 });
    await expect(km.generateKey()).resolves.toMatchObject({ version: 1, iterations: 1 });
  });

  it('73.6 an older import does not lower the version that will be minted next', async () => {
    const source = new KeyManager({ masterSecret: 's', iterations: 1_000 });
    await source.generateKey();
    await source.generateKey();
    const [v1, v2] = await source.exportWrappedKeys();

    const km = new KeyManager({ masterSecret: 's', iterations: 1_000 });
    await km.loadKey(v2!);
    await km.loadKey(v1!);

    expect(km.version).toBe(2);
    // `highestVersion` guards this: an import of an old key must not make the
    // next mint reuse a version the newer key already occupies.
    await expect(km.generateKey()).resolves.toMatchObject({ version: 3 });
  });
});

describe('AC 73 — a provider refuses to work uninitialized', () => {
  it('73.7 encrypt before initialize is an error, not a write', async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 's', iterations: 1_000 },
      encryption: CONFIG,
    });

    // The `_ensureInitialized()` call itself was a recorded survivor: removing it
    // left the provider encrypting with whatever state the constructor left.
    await expect(provider.encrypt(Buffer.from('x'))).rejects.toThrow(/not initialized/);
  });

  it('73.8 decrypt before initialize is an error, not a parse', async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 's', iterations: 1_000 },
      encryption: CONFIG,
    });

    await expect(provider.decrypt(Buffer.alloc(64))).rejects.toThrow(/not initialized/);
  });

  it('73.9 a blob of exactly the prefix length is a header, not a short read', async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 's', iterations: 1_000 },
      encryption: CONFIG,
    });
    await provider.initialize(CONFIG);

    // The guard is `length < HEADER_PREFIX_LENGTH`; `<=` turns a blob that has a
    // header to read into a blob reported as too short.
    await expect(provider.decrypt(Buffer.alloc(4))).rejects.toThrow(/incomplete header/);
  });

  it('73.10 a blob of exactly header + wrapped key still has an empty payload', async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 's', iterations: 1_000 },
      encryption: CONFIG,
    });
    await provider.initialize(CONFIG);
    const sealed = await provider.encrypt(Buffer.from('payload'));
    const wrappedLen = sealed.readUInt32BE(0);
    const truncated = sealed.subarray(0, 4 + wrappedLen + 12);

    const error = await provider.decrypt(truncated).then(
      () => null,
      (reason: Error) => reason.message,
    );
    expect(error).toMatch(/data too short/);
    expect(error).not.toMatch(/incomplete header/);
  });

  it('73.11 a payload of exactly IV + tag is empty, not too short', async () => {
    const provider = new EnvelopeEncryptionProvider({
      keyManager: { masterSecret: 's', iterations: 1_000 },
      encryption: CONFIG,
    });
    await provider.initialize(CONFIG);

    // 12 (IV) + 16 (tag) is a valid empty plaintext; `<` mutated to `<=` calls
    // it malformed and the only empty ciphertext the provider can produce
    // becomes undecryptable.
    const sealed = await provider.encrypt(Buffer.alloc(0));

    expect((await provider.decrypt(sealed)).length).toBe(0);
  });
});

describe('AC 73 — file identity is about the file that is there', () => {
  it('73.12 a different file of the same size is not the file that was measured', () => {
    const file = path.join(scratch(), 'same-size.ndjson');
    fs.writeFileSync(file, 'AAAAA');
    const measured = fileIdentity(file)!;

    // Same name, same length, different file. The recorded survivor replaced
    // `actual.ino !== expected.ino` with `false`, which leaves only the size
    // comparison — and a size is not an identity. This is the whole reason the
    // helper exists: delete only the file you measured.
    fs.rmSync(file);
    fs.writeFileSync(file, 'BBBBB');

    expect(unlinkIfUnchanged(file, measured)).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('BBBBB');
  });

  it('73.13 identity of a path that no longer exists is null, not a throw', () => {
    const file = path.join(scratch(), 'gone.ndjson');
    fs.writeFileSync(file, 'x');
    const identity = { ino: 1, size: 1 };
    fs.rmSync(file);

    // The recorded survivor dropped `if (!actual) return false`, which left the
    // comparison dereferencing null. Deleting a file between "measure" and
    // "unlink" is the case this helper exists for.
    expect(unlinkIfUnchanged(file, identity)).toBe(false);
  });
});
