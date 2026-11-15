/**
 * I28 — rotation failure modes and audit-detection edges.
 *
 * A rotation is only trustworthy if the failure paths behave: a second
 * rotation must not start while one is in flight, a failed rotation must be
 * recorded as failed and leave the version untouched, and the auditor must
 * notice a gap, a reordered timestamp or a rotation span that breaks a
 * compliance window.
 */

import { describe, it, expect, vi } from 'vitest';
import { KeyRotationManager } from '../impl/KeyRotationManager.js';
import { RotationAuditor } from '../impl/RotationAuditor.js';
import { KeyManager } from '../impl/KeyManager.js';
import { AES256GCMEncryptionProvider } from '../impl/AES256GCMEncryptionProvider.js';
import type { IEncryptionManager, EncryptionConfig } from '../interfaces/index.js';
import type { KeyRotationPolicy, RotationEvent } from '../interfaces/IKeyRotationManager.js';

const ENCRYPTION_CONFIG: EncryptionConfig = { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' };
const DAY_MS = 24 * 3600 * 1000;

// ── Test doubles for the KMS boundary ───────────────────────

abstract class KmsStub implements IEncryptionManager {
  async initialize(_config: EncryptionConfig): Promise<void> {}
  async encrypt(plaintext: Buffer): Promise<Buffer> {
    return plaintext;
  }
  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return ciphertext;
  }
  async rotateKey(): Promise<void> {}
  isEnabled(): boolean {
    return true;
  }
}

/** rotateKey() stays pending until the test releases it. */
class PendingRotationKms extends KmsStub {
  rotateCalls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async rotateKey(): Promise<void> {
    this.rotateCalls++;
    await this.gate;
  }

  releaseRotation(): void {
    this.release();
  }
}

/** rotateKey() fails the way an unreachable HSM would. */
class FailingRotationKms extends KmsStub {
  override async rotateKey(): Promise<void> {
    throw new Error('KMS unreachable: hsm offline');
  }
}

/** Re-encryption round-trips to different bytes than were decrypted. */
class MismatchedRoundTripKms extends KmsStub {
  private decryptCalls = 0;

  override async decrypt(_ciphertext: Buffer): Promise<Buffer> {
    this.decryptCalls++;
    return this.decryptCalls === 1 ? Buffer.from('decrypted payload') : Buffer.from('other payload');
  }
}

/** Encryption is unavailable while re-encryption is attempted. */
class FailingEncryptKms extends KmsStub {
  override async encrypt(_plaintext: Buffer): Promise<Buffer> {
    throw new Error('cipher unavailable');
  }
}

/** Returns the same plaintext buffer for every decryption and records the re-encrypt input. */
class CapturingKms extends KmsStub {
  readonly plaintext = Buffer.from('highly sensitive payload');
  capturedReEncryptionInput: Buffer | null = null;

  override async decrypt(_ciphertext: Buffer): Promise<Buffer> {
    return this.plaintext;
  }

  override async encrypt(plaintext: Buffer): Promise<Buffer> {
    this.capturedReEncryptionInput = plaintext;
    return Buffer.from('re-encrypted');
  }
}

// ── Helpers ─────────────────────────────────────────────────

function makePolicy(id: string, overrides: Partial<KeyRotationPolicy> = {}): KeyRotationPolicy {
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

async function* blobs(data: Buffer[]): AsyncIterable<Buffer> {
  for (const blob of data) yield blob;
}

async function initializedAes(): Promise<AES256GCMEncryptionProvider> {
  const provider = new AES256GCMEncryptionProvider();
  await provider.initialize(ENCRYPTION_CONFIG);
  return provider;
}

function makeEvent(overrides: Partial<RotationEvent> = {}): RotationEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    policyId: 'policy-1',
    fromVersion: 1,
    toVersion: 2,
    trigger: { kind: 'manual' },
    startedAt: Date.now() - 1_000,
    completedAt: Date.now(),
    success: true,
    error: null,
    reEncryptedCount: 0,
    retiredVersion: null,
    ...overrides,
  };
}

// ── KeyRotationManager: failure paths ───────────────────────

describe('KeyRotationManager — concurrent and failed rotations', () => {
  it('refuses a second rotation while the first is still in flight', async () => {
    const kms = new PendingRotationKms();
    const manager = new KeyRotationManager(kms);
    manager.registerPolicy(makePolicy('inflight'));

    const first = manager.rotate('inflight');
    // rotate() sets rotationInProgress before its first await.
    const during = await manager.getState('inflight');

    await expect(manager.rotate('inflight')).rejects.toThrow('rotation already in progress for "inflight"');
    expect(during!.rotationInProgress).toBe(true);

    kms.releaseRotation();
    const event = await first;
    expect(event.success).toBe(true);
    expect(kms.rotateCalls).toBe(1);
    expect((await manager.getState('inflight'))!.rotationInProgress).toBe(false);
  });

  it('does not schedule a policy that is already rotating', async () => {
    const kms = new PendingRotationKms();
    const manager = new KeyRotationManager(kms);
    manager.registerPolicy(makePolicy('busy', { trigger: { kind: 'compromise', reason: 'leak' } }));

    const inFlight = manager.rotate('busy');

    expect(await manager.checkPolicies()).toEqual([]);

    kms.releaseRotation();
    expect((await inFlight).success).toBe(true);
    expect(await manager.checkPolicies()).toHaveLength(1);
  });

  it('records a failed rotation without advancing the key version', async () => {
    const manager = new KeyRotationManager(new FailingRotationKms());
    manager.registerPolicy(makePolicy('broken-kms'));
    const before = (await manager.getState('broken-kms'))!.currentVersion;

    const event = await manager.rotate('broken-kms');

    expect(event.success).toBe(false);
    expect(event.error).toContain('KMS unreachable: hsm offline');
    expect(event.completedAt).not.toBeNull();
    expect((await manager.getState('broken-kms'))!.currentVersion).toBe(before);
    expect(await manager.getHistory('broken-kms')).toHaveLength(1);

    const stats = await manager.getStats();
    expect(stats.failedRotations).toBe(1);
    expect(stats.successfulRotations).toBe(0);
    expect(stats.lastRotationAt).toBe(event.startedAt);
  });

  it('leaves the policy retryable after a failed rotation', async () => {
    const manager = new KeyRotationManager(new FailingRotationKms());
    manager.registerPolicy(makePolicy('retryable'));

    expect((await manager.rotate('retryable')).success).toBe(false);
    const second = await manager.rotate('retryable');

    expect(second.success).toBe(false);
    expect(await manager.getHistory('retryable')).toHaveLength(2);
  });

  it('reports the key versions held by the key manager in its statistics', async () => {
    const km = new KeyManager({ masterSecret: 'stats-secret', iterations: 1_000 });
    await km.generateKey();
    await km.generateKey();
    const manager = new KeyRotationManager(await initializedAes(), km);

    const stats = await manager.getStats();

    expect(stats.activeKeyVersions).toBe(2);
    expect(stats.totalRotations).toBe(0);
  });
});

// ── KeyRotationManager: schedule trigger ────────────────────

describe('KeyRotationManager — schedule trigger', () => {
  it('never schedules a policy whose trigger kind is not recognised', async () => {
    const manager = new KeyRotationManager(await initializedAes());
    // Policies normally come from configuration files, where the trigger kind
    // is not validated. An unknown kind must not be treated as "due now".
    const policy = JSON.parse(
      JSON.stringify({
        id: 'unrecognised',
        name: 'loaded from config',
        trigger: { kind: 'every-fortnight' },
        reEncrypt: false,
        reEncryptBatchSize: 0,
        maxKeyVersions: 0,
        priority: 'normal',
        enabled: true,
      }),
    ) as KeyRotationPolicy;

    manager.registerPolicy(policy);

    expect(await manager.checkPolicies()).toEqual([]);
    expect((await manager.getState('unrecognised'))!.nextRotationDue).toBeNull();
  });

  it('is not due before its next slot and due one hour later', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const manager = new KeyRotationManager(await initializedAes());
      manager.registerPolicy(makePolicy('cron', { trigger: { kind: 'schedule', cron: '0 * * * *' } }));

      expect(await manager.checkPolicies()).toHaveLength(0);

      vi.setSystemTime(new Date('2026-01-01T01:00:01.000Z'));
      const due = await manager.checkPolicies();

      expect(due.map((p) => p.id)).toEqual(['cron']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── KeyRotationManager: re-encryption ───────────────────────

describe('KeyRotationManager — re-encryption outcomes', () => {
  it('rejects re-encryption for an unknown policy', async () => {
    const manager = new KeyRotationManager(await initializedAes());

    await expect(manager.reEncrypt('no-such-policy', blobs([Buffer.from('x')]))).rejects.toThrow(
      'unknown policy "no-such-policy"',
    );
  });

  it('counts a blob as failed when the re-encrypted data does not round-trip', async () => {
    const manager = new KeyRotationManager(new MismatchedRoundTripKms());
    manager.registerPolicy(makePolicy('mismatch'));

    const result = await manager.reEncrypt('mismatch', blobs([Buffer.from('blob')]));

    expect(result.totalBlobs).toBe(1);
    expect(result.reEncrypted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('counts a blob as skipped when it cannot be re-encrypted', async () => {
    const manager = new KeyRotationManager(new FailingEncryptKms());
    manager.registerPolicy(makePolicy('unavailable'));

    const result = await manager.reEncrypt('unavailable', blobs([Buffer.from('blob')]));

    expect(result.totalBlobs).toBe(1);
    expect(result.reEncrypted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('zeroizes the decrypted plaintext after re-encrypting it', async () => {
    const kms = new CapturingKms();
    const manager = new KeyRotationManager(kms);
    manager.registerPolicy(makePolicy('zeroize'));

    const result = await manager.reEncrypt('zeroize', blobs([Buffer.from('blob')]));

    expect(result.reEncrypted).toBe(1);
    expect(kms.capturedReEncryptionInput).not.toBeNull();
    expect(kms.capturedReEncryptionInput!.every((byte) => byte === 0)).toBe(true);
    expect(kms.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('clears the pending re-encryption count for the policy', async () => {
    const manager = new KeyRotationManager(await initializedAes());
    manager.registerPolicy(makePolicy('pending'));
    const state = (await manager.getState('pending'))!;
    state.pendingReEncryptions = 7;

    await manager.reEncrypt('pending', blobs([]));

    expect((await manager.getState('pending'))!.pendingReEncryptions).toBe(0);
  });
});

// ── RotationAuditor: detection ──────────────────────────────

describe('RotationAuditor — detection of altered chains', () => {
  it('filters entries by policy', () => {
    const auditor = new RotationAuditor();
    auditor.record(makeEvent({ policyId: 'p1' }));
    auditor.record(makeEvent({ policyId: 'p2' }));
    auditor.record(makeEvent({ policyId: 'p1' }));

    expect(auditor.getEntriesByPolicy('p1').map((e) => e.seq)).toEqual([1, 3]);
    expect(auditor.getEntriesByPolicy('missing')).toEqual([]);
  });

  it('reports a sequence gap when an entry is removed from the middle', () => {
    const auditor = new RotationAuditor();
    auditor.record(makeEvent());
    auditor.record(makeEvent());
    auditor.record(makeEvent());

    // A dropped entry leaves a hole in the otherwise monotonic sequence.
    auditor.getEntries()[1]!.seq = 9;

    const result = auditor.verify();

    expect(result.valid).toBe(false);
    expect(result.chainBroken).toBe(true);
    expect(result.errors.some((e) => e.includes('seq gap'))).toBe(true);
  });

  it('reports timestamps that go backwards', () => {
    const auditor = new RotationAuditor();
    auditor.record(makeEvent());
    auditor.record(makeEvent());

    const entries = auditor.getEntries();
    entries[1]!.recordedAt = entries[0]!.recordedAt - 1;

    const result = auditor.verify();

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('timestamp regression'))).toBe(true);
  });
});

// ── RotationAuditor: compliance windows ─────────────────────

describe('RotationAuditor — compliance windows', () => {
  it('fails PCI-DSS when the recorded rotations span more than a year', () => {
    const auditor = new RotationAuditor();
    const first = Date.UTC(2024, 0, 1);
    auditor.record(makeEvent({ success: true, startedAt: first, completedAt: first }));
    auditor.record(
      makeEvent({ success: true, startedAt: first + 2 * 365 * DAY_MS, completedAt: first + 2 * 365 * DAY_MS }),
    );

    const report = auditor.generateReport('PCI-DSS');

    expect(report.pass).toBe(false);
    expect(report.findings.some((f) => f.includes('PCI-DSS 3.6.4'))).toBe(true);
    expect(report.averageIntervalMs).toBe(2 * 365 * DAY_MS);
  });

  it('fails PCI-DSS when no rotation was ever recorded', () => {
    const report = new RotationAuditor().generateReport('PCI-DSS');

    expect(report.pass).toBe(false);
    expect(report.findings.some((f) => f.includes('no key rotations recorded'))).toBe(true);
    expect(report.oldestActiveKeyCreatedAt).toBeNull();
  });

  it('fails SOC2 when there are no documented rotation events', () => {
    const report = new RotationAuditor().generateReport('SOC2');

    expect(report.pass).toBe(false);
    expect(report.findings.some((f) => f.includes('SOC2 CC6.3: no rotation events documented'))).toBe(true);
  });

  it('does not invent an average interval from a single rotation', () => {
    const auditor = new RotationAuditor();
    auditor.record(makeEvent({ success: true }));

    const report = auditor.generateReport('HIPAA');

    expect(report.successfulRotations).toBe(1);
    expect(report.averageIntervalMs).toBe(0);
    expect(report.pass).toBe(true);
  });

  it('treats a successful rotation without a completion time as a zero-length interval', () => {
    const auditor = new RotationAuditor();
    const startedAt = Date.UTC(2026, 0, 1);
    auditor.record(makeEvent({ success: true, startedAt, completedAt: null }));
    auditor.record(makeEvent({ success: true, startedAt, completedAt: null }));

    const report = auditor.generateReport('PCI-DSS');

    expect(report.averageIntervalMs).toBe(0);
    expect(report.pass).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
