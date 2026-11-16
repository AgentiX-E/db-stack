/**
 * AC 66 — a rotation policy is a promise, and the code keeps it.
 *
 * The cases are grouped by the promise each one holds the manager to:
 *
 *   AC 66.1–66.5   every trigger the type declares can be made to fire through
 *                  `IKeyRotationManager`, and `priority` decides the order the
 *                  scheduler works in. `count` and `volume` were declarable and
 *                  unreachable: the counters they read could only be fed by a
 *                  method that was not on the interface.
 *   AC 66.6        a re-registered policy gets its deadline from its new trigger.
 *   AC 66.7–66.8   a failed rotation does not invent a key version, and a
 *                  compromise is addressed by rotating once.
 *   AC 66.9–66.11  the scheduler rotates a due policy, stops when told, and does
 *                  not hold the host process open.
 *   AC 66.12–66.19 `reEncrypt: true` produces a recorded outcome — completed,
 *                  deferred or failed — instead of a clean-looking success with
 *                  zero blobs migrated, and the plaintext is wiped on every exit.
 *   AC 66.20–66.22 statistics, retirement and event identity.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EnvelopeEncryptionProvider } from '../impl/EnvelopeEncryptionProvider.js';
import { KeyRotationManager } from '../impl/KeyRotationManager.js';
import { KeyManager } from '../impl/KeyManager.js';
import { AES256GCMEncryptionProvider } from '../impl/AES256GCMEncryptionProvider.js';
import type { IKeyRotationManager, KeyRotationPolicy, ReEncryptSource } from '../interfaces/IKeyRotationManager.js';
import type { EncryptionConfig, IEncryptionManager } from '../interfaces/index.js';

const ENCRYPTION_CONFIG: EncryptionConfig = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' };
const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 24 * HOUR_MS;

// ── A KMS boundary that counts, and nothing else ────────────

class CountingKms implements IEncryptionManager {
  rotations = 0;

  async initialize(_config: EncryptionConfig): Promise<void> {}
  async encrypt(plaintext: Buffer): Promise<Buffer> {
    return plaintext;
  }
  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return Buffer.from(ciphertext);
  }
  async rotateKey(): Promise<void> {
    this.rotations++;
  }
  isEnabled(): boolean {
    return true;
  }
}

/**
 * Hands out distinct plaintext buffers, so each wipe is separately observable.
 *
 * A stub that returns one shared buffer makes `decrypted.fill(0)` and
 * `verified.fill(0)` the same call: killing either one still leaves the buffer
 * zeroed, and the test passes while the wipe it claims to check is gone.
 */
class TwinBufferKms implements IEncryptionManager {
  readonly first = Buffer.from('first-secret');
  readonly second = Buffer.from('second-secret');
  readonly encryptInputs: Buffer[] = [];
  /** Every buffer handed to the manager, so each wipe is checked on the real object. */
  readonly handedOut: Buffer[] = [];
  private decryptions = 0;
  private readonly sameOnVerify: boolean;

  constructor(sameOnVerify = true) {
    this.sameOnVerify = sameOnVerify;
  }

  async initialize(_config: EncryptionConfig): Promise<void> {}
  async encrypt(plaintext: Buffer): Promise<Buffer> {
    this.encryptInputs.push(plaintext);
    return Buffer.from('ciphertext');
  }
  async decrypt(): Promise<Buffer> {
    const call = this.decryptions++;
    const buffer = call === 0 ? this.first : this.sameOnVerify ? Buffer.from(this.first) : this.second;
    this.handedOut.push(buffer);
    return buffer;
  }
  async rotateKey(): Promise<void> {}
  isEnabled(): boolean {
    return true;
  }
}

/** Fails `rotateKey`, then succeeds — a KMS that recovers. */
class FlakyRotationKms extends CountingKms {
  failuresLeft = 1;

  override async rotateKey(): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('KMS unreachable: hsm offline');
    }
    this.rotations++;
  }
}

function policy(id: string, overrides: Partial<KeyRotationPolicy> = {}): KeyRotationPolicy {
  return {
    id,
    name: `policy ${id}`,
    trigger: { kind: 'manual' },
    reEncrypt: false,
    reEncryptBatchSize: 0,
    maxKeyVersions: 0,
    priority: 'normal',
    enabled: true,
    ...overrides,
  };
}

async function* source(data: (Buffer | null)[]): AsyncIterable<Buffer | null> {
  for (const blob of data) yield blob;
}

/** A source that is asked once and answers with the given blobs. */
function fixedSource(data: (Buffer | null)[]): ReEncryptSource & { calls: number } {
  const fn = Object.assign(() => source(data), { calls: 0 });
  return new Proxy(fn, {
    apply(target, thisArg, args) {
      target.calls++;
      return source(data);
    },
  }) as ReEncryptSource & { calls: number };
}

describe('AC 66 — every declared trigger can be made to fire', () => {
  it('AC 66.1: the count trigger fires through the interface', async () => {
    // `RotationTrigger` declares `count`; the only method that could increment the
    // counter it reads was missing from `IKeyRotationManager`, so an executor typed
    // against the interface could never make this trigger fire.
    const rotation: IKeyRotationManager = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('by-count', { trigger: { kind: 'count', maxEncryptions: 3 } }));

    expect(await rotation.checkPolicies()).toEqual([]);
    rotation.recordEncryption('by-count', 10);
    rotation.recordEncryption('by-count', 10);
    expect(await rotation.checkPolicies()).toEqual([]);

    rotation.recordEncryption('by-count', 10);
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['by-count']);
  });

  it('AC 66.2: the volume trigger counts bytes, not calls', async () => {
    const rotation: IKeyRotationManager = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('by-volume', { trigger: { kind: 'volume', maxBytes: 1000 } }));

    rotation.recordEncryption('by-volume', 600);
    expect(await rotation.checkPolicies()).toEqual([]);

    rotation.recordEncryption('by-volume', 400);
    // Exactly at the threshold is due: the trigger is "max bytes since rotation".
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['by-volume']);
  });

  it('AC 66.3: recording for an unknown policy is a no-op, not a throw', async () => {
    const rotation = new KeyRotationManager(new CountingKms());

    expect(() => rotation.recordEncryption('not-registered', 500)).not.toThrow();

    // And the counter did not exist to be carried over.
    rotation.registerPolicy(policy('later', { trigger: { kind: 'count', maxEncryptions: 1 } }));
    expect(await rotation.checkPolicies()).toEqual([]);
  });

  it('AC 66.4: a manual trigger is never automatically due', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('manual-only', { trigger: { kind: 'manual' } }));
    rotation.recordEncryption('manual-only', 10_000_000);

    expect(await rotation.checkPolicies()).toEqual([]);
    expect((await rotation.rotate('manual-only')).success).toBe(true);
  });

  it('AC 66.5: priority decides the order the scheduler works in', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('low', { trigger: { kind: 'compromise', reason: 'x' }, priority: 'low' }));
    rotation.registerPolicy(policy('normal', { trigger: { kind: 'compromise', reason: 'x' } }));
    rotation.registerPolicy(policy('critical', { trigger: { kind: 'compromise', reason: 'x' }, priority: 'critical' }));
    rotation.registerPolicy(policy('high', { trigger: { kind: 'compromise', reason: 'x' }, priority: 'high' }));

    // `RotationPriority` documents itself as the order when several are pending.
    // Registration order was what the scheduler used, so a compromised key queued
    // behind three low-priority rotations waited for all of them.
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['critical', 'high', 'normal', 'low']);
  });

  it('AC 66.5b: equal priorities keep registration order', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    for (const id of ['first', 'second', 'third']) {
      rotation.registerPolicy(policy(id, { trigger: { kind: 'compromise', reason: 'x' } }));
    }

    // Stable: a tick that rotates one key must rotate the same one twice in a row.
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['first', 'second', 'third']);
  });

  it('AC 66.6: re-registering a policy recomputes its deadline from the new trigger', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('shifted', { trigger: { kind: 'time', maxAgeMs: HOUR_MS } }));
    await rotation.rotate('shifted');
    const first = (await rotation.getState('shifted'))!.nextRotationDue;
    expect(first).not.toBeNull();

    // The same id, a new age. The old deadline was derived from a trigger that no
    // longer exists; keeping it would leave the policy rotating on a schedule
    // nobody configured.
    rotation.registerPolicy(policy('shifted', { trigger: { kind: 'time', maxAgeMs: YEAR_MS } }));
    const second = (await rotation.getState('shifted'))!.nextRotationDue;

    expect(second! - first!).toBeGreaterThan(YEAR_MS - 2 * HOUR_MS);
    // Counters and history describe the key, so they survive the re-registration.
    expect((await rotation.getState('shifted'))!.lastRotatedAt).not.toBeNull();
    expect(await rotation.getHistory('shifted')).toHaveLength(1);
  });
});

describe('AC 66 — a failed rotation states only what happened', () => {
  it('AC 66.7: a failed rotation creates no version and records no version it created', async () => {
    const kms = new FlakyRotationKms();
    const rotation = new KeyRotationManager(kms);
    rotation.registerPolicy(policy('flaky'));

    const failed = await rotation.rotate('flaky');

    expect(failed.success).toBe(false);
    expect(failed.error).toContain('hsm offline');
    // It used to report `fromVersion + 1`, a version the KMS never created — in the
    // audit trail, where a wrong version number is what an investigation reads.
    expect(failed.toVersion).toBe(failed.fromVersion);
    expect((await rotation.getState('flaky'))!.currentVersion).toBe(failed.fromVersion);

    const recovered = await rotation.rotate('flaky');
    expect(recovered.success).toBe(true);
    expect(recovered.toVersion).toBe(recovered.fromVersion + 1);
  });

  it('AC 66.8: a compromise policy is due until the key has been rotated', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('leak', { trigger: { kind: 'compromise', reason: 'key leak' } }));

    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['leak']);

    await rotation.rotate('leak');

    // "Always due" made the scheduler rotate the key on every tick for the life of
    // the process: an emergency response that never ends.
    expect(await rotation.checkPolicies()).toEqual([]);
    // The emergency path still rotates on demand — it is not gated on being due.
    const again = await rotation.emergencyRotate('leak', 'second leak');
    expect(again.success).toBe(true);
    expect(again.trigger).toEqual({ kind: 'compromise', reason: 'second leak' });
  });

  it('AC 66.8b: an emergency rotation of an unknown policy creates a critical one', async () => {
    const rotation = new KeyRotationManager(new CountingKms());

    const event = await rotation.emergencyRotate('discovered-leak', 'credentials in a log');

    expect(event.success).toBe(true);
    const created = (await rotation.getPolicies()).find((p) => p.id === 'discovered-leak');
    expect(created).toMatchObject({
      priority: 'critical',
      enabled: true,
      reEncrypt: true,
      maxKeyVersions: 5,
      trigger: { kind: 'compromise', reason: 'credentials in a log' },
    });
    // The history records the reason that was given, not the policy's default.
    const [recorded] = await rotation.getHistory('discovered-leak');
    expect(recorded!.trigger).toEqual({ kind: 'compromise', reason: 'credentials in a log' });
  });

  it('AC 66.8c: rotate refuses an unknown policy by name', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    await expect(rotation.rotate('nope')).rejects.toThrow('unknown policy "nope"');
  });
});

describe('AC 66 — the scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 66.9: rotates a due policy once, and stops rotating when stopped', async () => {
    vi.useFakeTimers();
    const kms = new CountingKms();
    const rotation = new KeyRotationManager(kms);
    rotation.registerPolicy(policy('leak', { trigger: { kind: 'compromise', reason: 'leak' } }));

    rotation.startScheduler(1000);
    await vi.advanceTimersByTimeAsync(5000);

    // Five ticks, one rotation: the first tick addresses the compromise and the
    // rest find nothing due.
    expect(kms.rotations).toBe(1);

    rotation.stopScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kms.rotations).toBe(1);
  });

  it('AC 66.10: a running scheduler does not keep the process alive', () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.startScheduler(60_000);
    const timer = (rotation as unknown as { schedulerTimer: NodeJS.Timeout | null }).schedulerTimer;

    // A library that owns an interval must not decide when its host exits: without
    // `unref` a service that forgot `stopScheduler` hangs on shutdown, and a test
    // process never finishes.
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);

    rotation.stopScheduler();
    expect((rotation as unknown as { schedulerTimer: NodeJS.Timeout | null }).schedulerTimer).toBeNull();
  });

  it('AC 66.11: a rotation that throws inside a tick does not stop the next policy', async () => {
    vi.useFakeTimers();
    const kms = new FlakyRotationKms();
    const rotation = new KeyRotationManager(kms);
    rotation.registerPolicy(policy('first', { trigger: { kind: 'compromise', reason: 'x' }, priority: 'critical' }));
    rotation.registerPolicy(policy('second', { trigger: { kind: 'compromise', reason: 'x' } }));

    rotation.startScheduler(1000);
    // One tick: the failed policy must not take the next one down with it.
    await vi.advanceTimersByTimeAsync(1500);

    const first = await rotation.getHistory('first');
    const second = await rotation.getHistory('second');
    expect(first).toHaveLength(1);
    expect(first[0]!.success).toBe(false);
    // The second policy still rotated in the same tick: a failed rotation is one
    // policy's problem, not the scheduler's.
    expect(second).toHaveLength(1);
    expect(second[0]!.success).toBe(true);

    rotation.stopScheduler();
  });
});

describe('AC 66 — re-encryption is recorded, not assumed', () => {
  let store: KeyRotationManager | undefined;

  afterEach(() => {
    store?.stopScheduler();
    store = undefined;
  });

  it('AC 66.12: a policy that does not ask for re-encryption says so', async () => {
    const asked: string[] = [];
    const rotation = new KeyRotationManager(new CountingKms(), undefined, {
      reEncryptSource: (policyId) => {
        asked.push(policyId);
        return source([Buffer.from('blob')]);
      },
    });
    rotation.registerPolicy(policy('no-reencrypt', { reEncrypt: false }));

    const event = await rotation.rotate('no-reencrypt');

    expect(event.reEncryption).toBe('not-requested');
    expect(event.reEncryptedCount).toBe(0);
    expect(asked).toEqual([]);
  });

  it('AC 66.13: reEncrypt: true with no source is reported as deferred', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('wants', { reEncrypt: true }));

    const event = await rotation.rotate('wants');

    // The flag used to be read by nothing: the rotation reported success with
    // `reEncryptedCount: 0` and the data stayed on the old key, unremarked.
    expect(event.success).toBe(true);
    expect(event.reEncryption).toBe('deferred');
    expect(event.reEncryptedCount).toBe(0);
  });

  it('AC 66.14: a source that answers "not now" is deferred, not completed', async () => {
    const rotation = new KeyRotationManager(new CountingKms(), undefined, {
      reEncryptSource: () => null,
    });
    rotation.registerPolicy(policy('later', { reEncrypt: true }));

    expect((await rotation.rotate('later')).reEncryption).toBe('deferred');
  });

  it('AC 66.15: a source with blobs produces a completed pass and a count', async () => {
    const rotation = new KeyRotationManager(new CountingKms(), undefined, {
      reEncryptSource: () => source([Buffer.from('a'), Buffer.from('b'), null]),
    });
    rotation.registerPolicy(policy('migrate', { reEncrypt: true }));

    const event = await rotation.rotate('migrate');

    expect(event.reEncryption).toBe('completed');
    expect(event.reEncryptedCount).toBe(2);
    // The null was the source saying "already current": counted, not re-encrypted.
    expect((await rotation.getStats()).totalReEncrypted).toBe(2);
    expect((await rotation.getState('migrate'))!.pendingReEncryptions).toBe(0);
  });

  it('AC 66.16: a source that breaks makes the rotation say failed, and the key still rotated', async () => {
    const rotation = new KeyRotationManager(new CountingKms(), undefined, {
      reEncryptSource: () => {
        throw new Error('catalog unreachable');
      },
    });
    rotation.registerPolicy(policy('broken-source', { reEncrypt: true }));

    const event = await rotation.rotate('broken-source');

    // The key rotation succeeded; the migration did not. Reporting the whole thing
    // as failed would trigger a retry that rotates a healthy key again.
    expect(event.success).toBe(true);
    expect(event.reEncryption).toBe('failed');
    expect((await rotation.getState('broken-source'))!.currentVersion).toBe(event.toVersion);
  });

  it('AC 66.17: a stream that fails mid-pass leaves the debt visible', async () => {
    async function* failing(): AsyncIterable<Buffer | null> {
      yield Buffer.from('one');
      throw new Error('stream reset');
    }
    const rotation = new KeyRotationManager(new CountingKms(), undefined, {
      reEncryptSource: () => failing(),
    });
    rotation.registerPolicy(policy('half', { reEncrypt: true }));

    const event = await rotation.rotate('half');

    expect(event.reEncryption).toBe('failed');
    expect((await rotation.getState('half'))!.pendingReEncryptions).toBe(1);
  });

  it('AC 66.18: the batch bound stops the pass and leaves one more owed', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('batched', { reEncryptBatchSize: 2 }));

    const first = await rotation.reEncrypt('batched', source([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]));

    expect(first.totalBlobs).toBe(2);
    expect(first.reEncrypted).toBe(2);
    expect((await rotation.getState('batched'))!.pendingReEncryptions).toBe(1);

    const second = await rotation.reEncrypt('batched', source([Buffer.from('c')]));
    expect(second.totalBlobs).toBe(1);
    expect((await rotation.getState('batched'))!.pendingReEncryptions).toBe(0);
  });

  it('AC 66.19: the plaintext is wiped on success, on mismatch and on failure', async () => {
    const good = new TwinBufferKms(true);
    const matched = new KeyRotationManager(good);
    matched.registerPolicy(policy('good'));
    const ok = await matched.reEncrypt('good', source([Buffer.from('blob')]));
    expect(ok.reEncrypted).toBe(1);
    // Both buffers the cipher handed out — the decrypted plaintext and the
    // round-trip check — not the one a stub happens to share between them.
    expect(good.handedOut).toHaveLength(2);
    for (const buffer of good.handedOut) expect(buffer.every((b) => b === 0)).toBe(true);

    const mismatch = new TwinBufferKms(false);
    const checked = new KeyRotationManager(mismatch);
    checked.registerPolicy(policy('mismatch'));
    const bad = await checked.reEncrypt('mismatch', source([Buffer.from('blob')]));
    expect(bad.failed).toBe(1);
    // A verification failure used to `continue` with the plaintext still in memory.
    expect(mismatch.handedOut).toHaveLength(2);
    for (const buffer of mismatch.handedOut) expect(buffer.every((b) => b === 0)).toBe(true);
  });

  it('AC 66.19b: the plaintext is wiped when the cipher throws', async () => {
    class FailingEncryptKms extends TwinBufferKms {
      override async encrypt(): Promise<Buffer> {
        throw new Error('cipher unavailable');
      }
    }
    const kms = new FailingEncryptKms();
    const rotation = new KeyRotationManager(kms);
    rotation.registerPolicy(policy('cipher-down'));

    const result = await rotation.reEncrypt('cipher-down', source([Buffer.from('blob')]));

    expect(result.failed).toBe(1);
    // The blob could not be rewritten, so it stays on the old key — but the
    // plaintext must not stay in the heap because the pass went badly.
    expect(kms.first.every((b) => b === 0)).toBe(true);
  });

  it('AC 66.19c: re-encryption of an unknown policy is refused by name', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    await expect(rotation.reEncrypt('ghost', source([]))).rejects.toThrow('unknown policy "ghost"');
  });
});

describe('AC 66 — statistics, retirement and identity', () => {
  it('AC 66.20: statistics separate successes from failures and average only what finished', async () => {
    const kms = new FlakyRotationKms();
    const rotation = new KeyRotationManager(kms);
    rotation.registerPolicy(policy('mixed'));

    await rotation.rotate('mixed'); // fails
    await rotation.rotate('mixed'); // succeeds
    await rotation.rotate('mixed'); // succeeds

    const stats = await rotation.getStats();
    expect(stats.totalRotations).toBe(3);
    expect(stats.successfulRotations).toBe(2);
    expect(stats.failedRotations).toBe(1);
    expect(stats.averageDurationMs).toBeGreaterThanOrEqual(0);
    const history = await rotation.getHistory('mixed');
    expect(stats.lastRotationAt).toBe(history[history.length - 1]!.startedAt);
  });

  it('AC 66.21: retirement is reported only when the key manager still holds the version', async () => {
    const aes = new AES256GCMEncryptionProvider();
    await aes.initialize(ENCRYPTION_CONFIG);
    const km = new KeyManager({ masterSecret: 'retire-secret', iterations: 1_000 });
    await km.generateKey();

    const rotation = new KeyRotationManager(aes, km);
    rotation.registerPolicy(policy('keep-two', { maxKeyVersions: 2 }));
    await rotation.rotate('keep-two');
    await rotation.rotate('keep-two');

    const history = await rotation.getHistory('keep-two');
    expect(history[0]!.retiredVersion).toBeNull();
    expect(history[1]!.retiredVersion).toBe(1);

    // Without a key manager nothing is known about held versions, and reporting a
    // retirement that did not happen is worse than reporting none.
    const bare = new KeyRotationManager(aes);
    bare.registerPolicy(policy('unknown-versions', { maxKeyVersions: 1 }));
    await bare.rotate('unknown-versions');
    await bare.rotate('unknown-versions');
    expect((await bare.getHistory('unknown-versions')).every((e) => e.retiredVersion === null)).toBe(true);
  });

  it('AC 66.22: every event carries its own identity and the policy that produced it', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('a'));
    rotation.registerPolicy(policy('b'));

    const events = [await rotation.rotate('a'), await rotation.rotate('b'), await rotation.rotate('a')];

    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    for (const event of events) {
      // The id is what an operator quotes in an incident channel and what an
      // exporter writes as a filename: `rot-<time>-<six base36 chars>`, no dots.
      expect(event.id).toMatch(/^rot-[a-z0-9]+-[a-z0-9]{6}$/);
    }
    expect(events.map((e) => e.policyId)).toEqual(['a', 'b', 'a']);
    expect((await rotation.getHistory('a')).map((e) => e.id)).toEqual([events[0]!.id, events[2]!.id]);
  });
});

describe('AC 66 — policies the manager must not act on', () => {
  it('AC 66.23: a disabled policy is never due, whatever its trigger', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('off', { trigger: { kind: 'compromise', reason: 'x' }, enabled: false }));

    // `enabled` is the switch an operator throws during a freeze. A disabled
    // compromise policy that still reports itself due is a switch that does not
    // switch anything off.
    expect(await rotation.checkPolicies()).toEqual([]);
  });

  it('AC 66.24: a rotation that never reached re-encryption says so', async () => {
    const rotation = new KeyRotationManager(new FlakyRotationKms());
    rotation.registerPolicy(policy('never-ran', { reEncrypt: true }));

    const failed = await rotation.rotate('never-ran');

    expect(failed.success).toBe(false);
    // Nothing was re-encrypted because nothing was rotated. `failed` would claim an
    // attempt; `deferred` would claim work still to come.
    expect(failed.reEncryption).toBe('not-requested');
  });
});

describe('AC 66 — retirement is about versions the key manager can still see', () => {
  /** A KMS whose rotation advances the shared key manager, as envelope encryption does. */
  class KeyManagerKms extends CountingKms {
    constructor(readonly km: KeyManager) {
      super();
    }
    override async rotateKey(): Promise<void> {
      await this.km.generateKey();
      this.rotations++;
    }
  }

  it('AC 66.25: maxKeyVersions 0 means unlimited, so nothing is retired', async () => {
    const km = new KeyManager({ masterSecret: 'unlimited-secret', iterations: 1_000 });
    await km.generateKey();
    const rotation = new KeyRotationManager(new KeyManagerKms(km), km);
    rotation.registerPolicy(policy('unlimited', { maxKeyVersions: 0 }));

    await rotation.rotate('unlimited');
    await rotation.rotate('unlimited');

    // Version 2 exists by the time the first rotation finishes — the provider just
    // created it — so a retirement rule that forgot the `> 0` would report the
    // brand-new key as retired, which is the one version that must never be.
    expect((await rotation.getHistory('unlimited')).map((e) => e.retiredVersion)).toEqual([null, null]);
    expect(km.versionCount).toBe(3);
  });

  it('AC 66.26: a retirement policy without a key manager still rotates', async () => {
    const aes = new AES256GCMEncryptionProvider();
    await aes.initialize(ENCRYPTION_CONFIG);
    const rotation = new KeyRotationManager(aes);
    rotation.registerPolicy(policy('no-key-manager', { maxKeyVersions: 2 }));

    const event = await rotation.rotate('no-key-manager');

    // Without a key manager there is no version history to consult, so there is
    // nothing to report — and nothing that should fail the rotation either. Reading
    // the key manager without the optional chain throws *after* `success` was set,
    // which is how a rotation that could not consult anything was still recorded as
    // a success; AC 66.38 holds the invariant that makes that visible.
    expect(event.success).toBe(true);
    expect(event.error).toBeNull();
    expect(event.retiredVersion).toBeNull();
  });
});

describe('AC 66 — emergency rotation keeps what it found', () => {
  it('AC 66.27: an existing policy is rotated, not replaced', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('named', { name: 'Data key, ninety days', priority: 'high' }));

    const event = await rotation.emergencyRotate('named', 'leaked in a log');

    const [kept] = await rotation.getPolicies();
    expect(kept!.name).toBe('Data key, ninety days');
    expect(kept!.priority).toBe('high');
    expect(event.trigger).toEqual({ kind: 'compromise', reason: 'leaked in a log' });
  });

  it('AC 66.28: an auto-created policy is named for the reason it exists', async () => {
    const rotation = new KeyRotationManager(new CountingKms());

    await rotation.emergencyRotate('auto', 'laptop stolen');

    const created = (await rotation.getPolicies())[0]!;
    expect(created.name).toBe('Emergency rotation: laptop stolen');
    expect(created.id).toBe('auto');
  });
});

describe('AC 66 — a cipher that cannot decrypt fails the blob, not the pass', () => {
  it('AC 66.29: an undecryptable blob counts as failed and does not throw', async () => {
    class UndecryptableKms extends CountingKms {
      override async decrypt(): Promise<Buffer> {
        throw new Error('no key for this version');
      }
    }
    const rotation = new KeyRotationManager(new UndecryptableKms());
    rotation.registerPolicy(policy('lost-key'));

    const result = await rotation.reEncrypt('lost-key', source([Buffer.from('blob')]));

    // There is no plaintext to wipe on this path, and the wipe must not turn a
    // counted failure into a thrown one.
    expect(result.failed).toBe(1);
    expect(result.reEncrypted).toBe(0);
  });
});

describe('AC 66 — measured durations are measured', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 66.30: a pass reports the time it took', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('timed'));

    async function* slow(): AsyncIterable<Buffer | null> {
      vi.setSystemTime(new Date('2026-11-16T00:00:01.000Z'));
      yield Buffer.from('blob');
    }
    const result = await rotation.reEncrypt('timed', slow());

    expect(result.durationMs).toBe(1_000);
  });

  it('AC 66.31: the average is over successful rotations and is a division', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));
    // The clock advances *inside* the rotation, which is the only place a duration
    // comes from: moving it between two calls measures the test, not the work.
    class SlowKms extends CountingKms {
      private readonly delays = [0, 1_000];
      override async rotateKey(): Promise<void> {
        vi.setSystemTime(new Date(Date.now() + (this.delays.shift() ?? 0)));
        this.rotations++;
      }
    }
    const rotation = new KeyRotationManager(new SlowKms());
    rotation.registerPolicy(policy('averaged'));

    await rotation.rotate('averaged'); // 0 ms
    await rotation.rotate('averaged'); // 1 000 ms

    // 1 000 / 2. A sum that is a subtraction, a multiplication, or a `&&` gives a
    // different number rather than a slightly different one.
    expect((await rotation.getStats()).averageDurationMs).toBe(500);
  });

  it('AC 66.32: events are distinct even when the clock is not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('same-ms'));

    const ids = [(await rotation.rotate('same-ms')).id, (await rotation.rotate('same-ms')).id];

    // The timestamp half of the id is frozen; the random half is what keeps the
    // audit trail addressable by id.
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('AC 66 — the scheduler does not multiply', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 66.33: a second start does not add a second timer, and stop stops', async () => {
    vi.useFakeTimers();
    const kms = new CountingKms();
    const rotation = new KeyRotationManager(kms);
    // `maxAgeMs: 0` is due on every check, so a leaked interval shows up as extra
    // rotations instead of hiding behind a policy that only rotates once.
    rotation.registerPolicy(policy('always', { trigger: { kind: 'time', maxAgeMs: 0 } }));

    rotation.startScheduler(1000);
    rotation.startScheduler(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(kms.rotations).toBe(1);

    rotation.stopScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kms.rotations).toBe(1);
  });

  it('AC 66.34: a time trigger is due exactly at its age, not one tick later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-11-16T00:00:00.000Z');
    vi.setSystemTime(start);
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('hourly', { trigger: { kind: 'time', maxAgeMs: HOUR_MS } }));
    await rotation.rotate('hourly');

    vi.setSystemTime(new Date(start.getTime() + HOUR_MS - 1));
    expect(await rotation.checkPolicies()).toEqual([]);

    // Exactly an hour old: due. A strict `>` would rotate an hour and a tick late,
    // and the gap grows with every rotation.
    vi.setSystemTime(new Date(start.getTime() + HOUR_MS));
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['hourly']);
  });

  it('AC 66.35: a scheduled policy is due at its slot, not after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-11-16T00:00:00.000Z');
    vi.setSystemTime(start);
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('cron', { trigger: { kind: 'schedule', cron: '0 * * * *' } }));

    const state = (await rotation.getState('cron'))!;
    expect(state.nextRotationDue).toBe(start.getTime() + HOUR_MS);

    vi.setSystemTime(new Date(state.nextRotationDue! - 1));
    expect(await rotation.checkPolicies()).toEqual([]);

    vi.setSystemTime(new Date(state.nextRotationDue!));
    expect((await rotation.checkPolicies()).map((p) => p.id)).toEqual(['cron']);
  });
});

describe('AC 66 — statistics with nothing to average', () => {
  it('AC 66.36: no successful rotation means a zero average, not a NaN', async () => {
    const rotation = new KeyRotationManager(new FlakyRotationKms());
    rotation.registerPolicy(policy('all-fail'));
    await rotation.rotate('all-fail');

    // A rotation that never succeeded has no duration to report. Dividing by zero
    // successes gives `NaN`, which then renders as "NaN ms" in an operator's report.
    const stats = await rotation.getStats();
    expect(stats.successfulRotations).toBe(0);
    expect(stats.averageDurationMs).toBe(0);
  });
});

describe('AC 66 — a due time that is not set', () => {
  it('AC 66.37: a scheduled policy with no slot is not due', async () => {
    const rotation = new KeyRotationManager(new CountingKms());
    rotation.registerPolicy(policy('cron', { trigger: { kind: 'schedule', cron: '0 * * * *' } }));
    const state = (await rotation.getState('cron'))!;
    expect(state.nextRotationDue).not.toBeNull();

    // `nextRotationDue` is nullable because triggers without a schedule have no
    // slot. Clearing it must mean "nothing scheduled", not "always due" — the field
    // is exposed on the state object, so a caller can clear it.
    state.nextRotationDue = null;
    expect(await rotation.checkPolicies()).toEqual([]);
  });
});

describe('AC 66 — an event that carries an error did not succeed', () => {
  it('AC 66.38: success and error are never both set', async () => {
    // The post-rotation steps run after `success` is assigned, so a failure there
    // has to clear it. Otherwise the audit trail records a successful rotation with
    // an error attached, and a reader has to choose which half to believe.
    const rotation = new KeyRotationManager(new FlakyRotationKms());
    rotation.registerPolicy(policy('invariant'));

    const failed = await rotation.rotate('invariant');
    const recovered = await rotation.rotate('invariant');

    expect(failed.success).toBe(false);
    expect(failed.error).not.toBeNull();
    expect(recovered.success).toBe(true);
    expect(recovered.error).toBeNull();
    for (const event of await rotation.getHistory('invariant')) {
      expect(event.success).toBe(event.error === null);
    }
  });
});
