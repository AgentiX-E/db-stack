/**
 * I30 — AC 69: a compliance report has to earn its pass.
 *
 * `RotationAuditor` is the module that answers "did we meet the window?" for
 * PCI-DSS, SOC2 and HIPAA. Three things were wrong with the answer, and all
 * three are the same shape — a report that reads as assurance while nothing
 * behind it ran:
 *
 *   - `generateReport('SOX')` fell through an exhaustive-looking `switch` and
 *     returned `pass: true` with no findings. A framework the auditor knows
 *     nothing about scored better than one it checks.
 *   - `oldestActiveKeyCreatedAt` was `events[0].startedAt`, so a *failed* first
 *     rotation reported the birth of a key that was never created, and the value
 *     never moved again however often the key was rotated.
 *   - `record()` stored the caller's object, so a caller that kept its draft
 *     could rewrite history — and `verify()` would then blame tampering on a
 *     document nobody had touched.
 *
 * `importJSONL()` was the other half: it pushed entries into the live chain while
 * parsing, so a malformed line left the trail half imported, and it verified
 * nothing, so importing a forged chain succeeded and the *next* rotation was
 * chained onto the forgery.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { RotationAuditor } from '../impl/RotationAuditor.js';
import type { AuditEntry } from '../impl/RotationAuditor.js';
import type { RotationEvent, RotationTrigger } from '../interfaces/IKeyRotationManager.js';

// ── Fixtures ───────────────────────────────────────────────

let counter = 0;

function event(overrides: Partial<RotationEvent> = {}): RotationEvent {
  counter += 1;
  const startedAt = overrides.startedAt ?? 1_000 * counter;
  const success = overrides.success ?? true;
  return {
    id: `evt-${counter}`,
    policyId: 'policy-a',
    fromVersion: 1,
    toVersion: 2,
    trigger: { kind: 'manual' },
    startedAt,
    completedAt: success ? startedAt + 100 : null,
    success,
    error: success ? null : 'kms unavailable',
    reEncryptedCount: 0,
    reEncryption: 'not-requested',
    retiredVersion: null,
    ...overrides,
  };
}

function failed(overrides: Partial<RotationEvent> = {}): RotationEvent {
  return event({ success: false, toVersion: 1, ...overrides });
}

/**
 * The chain is private and the tampering cases need it. Single reflection edge;
 * a renamed field fails here rather than silently asserting nothing.
 */
function entriesOf(auditor: RotationAuditor): AuditEntry[] {
  return Reflect.get(auditor, 'entries') as AuditEntry[];
}

afterEach(() => {
  vi.useRealTimers();
});

// ── AC 69.1 — the record owns its content ──────────────────

describe('AC 69 — a handed-over event cannot be rewritten afterwards', () => {
  it('69.1 is unaffected by a caller that keeps and mutates its event', () => {
    const auditor = new RotationAuditor();
    const original = event({ trigger: { kind: 'time', maxAgeMs: 1_000 } });

    auditor.record(original);

    original.success = false;
    original.toVersion = 99;
    original.trigger = { kind: 'compromise', reason: 'injected' };

    const result = auditor.verify();
    expect(result.valid).toBe(true);
    const stored = auditor.getEntries()[0]!.event;
    expect(stored.success).toBe(true);
    expect(stored.toVersion).toBe(2);
    expect(stored.trigger).toEqual({ kind: 'time', maxAgeMs: 1_000 });
  });
});

// ── AC 69.2–69.3 — an event that contradicts itself is not evidence

describe('AC 69 — the auditor refuses an event that describes two outcomes', () => {
  it('69.2 rejects success with an error and consumes no sequence number', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(event({ success: true, error: 'boom' }))).toThrow(/contradicts/);
    expect(auditor.count).toBe(0);

    const first = auditor.record(event());
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe('0'.repeat(64));
  });

  it('69.3 rejects failure with no error and success that moved no version', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(failed({ error: null }))).toThrow(/contradicts/);
    expect(() => auditor.record(event({ fromVersion: 4, toVersion: 4 }))).toThrow(/contradicts/);
    expect(auditor.count).toBe(0);
  });
});

// ── AC 69.4–69.7 — importing a chain is a verification, not a copy

describe('AC 69 — import verifies the trail before it becomes the trail', () => {
  it('69.4 applies nothing when a line is not JSON', () => {
    const source = new RotationAuditor();
    source.record(event());
    source.record(event());
    source.record(event());
    const lines = source.exportJSONL().split('\n');
    lines[1] = '{"seq": 2, oops';

    const target = new RotationAuditor();
    expect(() => target.importJSONL(lines.join('\n'))).toThrow(/line 2/);
    expect(target.count).toBe(0);
    expect(target.verify().valid).toBe(true);
  });

  it('69.5 refuses a line whose hash does not match its content', () => {
    const source = new RotationAuditor();
    source.record(event());
    source.record(event());
    source.record(event());
    const lines = source.exportJSONL().split('\n');
    const second = JSON.parse(lines[1]!) as AuditEntry;
    second.hash = 'f'.repeat(64);
    lines[1] = JSON.stringify(second);

    const target = new RotationAuditor();
    expect(() => target.importJSONL(lines.join('\n'))).toThrow(/line 2.*hash/s);
    expect(target.count).toBe(0);
  });

  it('69.6 refuses a line that does not chain onto the line before it', () => {
    const source = new RotationAuditor();
    source.record(event());
    source.record(event());
    const lines = source.exportJSONL().split('\n');
    const second = JSON.parse(lines[1]!) as AuditEntry;
    second.prevHash = 'a'.repeat(64);
    lines[1] = JSON.stringify(second);

    const target = new RotationAuditor();
    expect(() => target.importJSONL(lines.join('\n'))).toThrow(/line 2/);
    expect(target.count).toBe(0);
  });

  it('69.7 refuses to splice a second chain onto a live one', () => {
    const source = new RotationAuditor();
    source.record(event());
    const jsonl = source.exportJSONL();

    const target = new RotationAuditor();
    target.record(event());

    expect(() => target.importJSONL(jsonl)).toThrow(/empty/);
    expect(target.count).toBe(1);
  });

  it('69.8 round-trips an export and continues the chain at the next sequence number', () => {
    const source = new RotationAuditor();
    source.record(event());
    source.record(event());
    source.record(event());
    const exported = source.exportJSONL();

    const target = new RotationAuditor();
    expect(target.importJSONL(exported)).toBe(3);

    expect(target.verify()).toEqual(source.verify());
    const lastImported = target.getEntries()[2]!;
    const next = target.record(event());
    expect(next.seq).toBe(4);
    expect(next.prevHash).toBe(lastImported.hash);
    expect(target.verify().valid).toBe(true);
  });
});

// ── AC 69.9 — recent(n) means n, for every n ───────────────

describe('AC 69 — recent() answers the question that was asked', () => {
  it('69.9 returns nothing for zero or negative counts', () => {
    const auditor = new RotationAuditor();
    for (let i = 0; i < 5; i += 1) auditor.record(event());

    expect(auditor.recent(0)).toEqual([]);
    expect(auditor.recent(-3)).toEqual([]);
  });

  it('69.10 returns the last n, or all of them when n exceeds the trail', () => {
    const auditor = new RotationAuditor();
    for (let i = 0; i < 5; i += 1) auditor.record(event());

    expect(auditor.recent(2).map((entry) => entry.seq)).toEqual([4, 5]);
    expect(auditor.recent(99)).toHaveLength(5);
  });
});

// ── AC 69.11–69.12 — the report describes the key, not the file

describe('AC 69 — the age of the active key is the age of the active key', () => {
  it('69.11 reports the completion of the earliest successful rotation', () => {
    const auditor = new RotationAuditor();
    auditor.record(event({ startedAt: 1_000, completedAt: 1_100 }));
    auditor.record(event({ startedAt: 5_000, completedAt: 5_100 }));
    auditor.record(event({ startedAt: 9_000, completedAt: 9_100 }));

    expect(auditor.generateReport('SOC2').oldestActiveKeyCreatedAt).toBe(1_100);
  });

  it('69.12 ignores failed rotations and reports null when none succeeded', () => {
    const auditor = new RotationAuditor();
    auditor.record(failed({ startedAt: 1_000 }));
    expect(auditor.generateReport('SOC2').oldestActiveKeyCreatedAt).toBeNull();

    auditor.record(event({ startedAt: 7_000, completedAt: 7_100 }));
    expect(auditor.generateReport('SOC2').oldestActiveKeyCreatedAt).toBe(7_100);
  });
});

// ── AC 69.13–69.15 — an unchecked framework is not a pass

describe('AC 69 — a framework with no checks cannot pass', () => {
  it('69.13 fails the report and names the framework it could not check', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());

    const report = auditor.generateReport('SOX');

    expect(report.pass).toBe(false);
    expect(report.framework).toBe('SOX');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatch(/SOX/);
    expect(report.findings[0]).toMatch(/no checks/i);
  });

  it('69.14 applies PCI-DSS checks for a framework name in any case', () => {
    const auditor = new RotationAuditor();

    const empty = auditor.generateReport('pci-dss');
    expect(empty.pass).toBe(false);
    expect(empty.findings.join(' ')).toMatch(/PCI-DSS 3\.6/);
    expect(empty.framework).toBe('pci-dss');
  });

  it('69.15 fails PCI-DSS when the recorded span exceeds one year and passes it otherwise', () => {
    const year = 365 * 24 * 3600 * 1000;
    const inside = new RotationAuditor();
    inside.record(event({ startedAt: 0, completedAt: 0 }));
    inside.record(event({ startedAt: year - 1, completedAt: year - 1 }));
    expect(inside.generateReport('PCI-DSS').pass).toBe(true);
    expect(inside.generateReport('PCI-DSS').findings).toEqual([]);

    const spanning = new RotationAuditor();
    spanning.record(event({ startedAt: 0, completedAt: 0 }));
    spanning.record(event({ startedAt: year + 1, completedAt: year + 1 }));
    const report = spanning.generateReport('PCI-DSS');
    expect(report.pass).toBe(false);
    expect(report.findings.join(' ')).toMatch(/1 year/);
  });
});

// ── AC 69.16–69.17 — SOC2 and HIPAA findings ──────────────

describe('AC 69 — failures are a review item, absence of evidence is a breach', () => {
  it('69.16 reports failed rotations to SOC2 without failing the window', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());
    auditor.record(failed());

    const report = auditor.generateReport('SOC2');

    expect(report.pass).toBe(true);
    expect(report.failedRotations).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatch(/SOC2 CC6\.3: 1 failed rotation/);
  });

  it('69.17 fails SOC2 and HIPAA when no rotation was ever recorded', () => {
    const empty = new RotationAuditor();

    const soc2 = empty.generateReport('SOC2');
    expect(soc2.pass).toBe(false);
    expect(soc2.findings.join(' ')).toMatch(/SOC2 CC6\.3/);

    const hipaa = empty.generateReport('HIPAA');
    expect(hipaa.pass).toBe(false);
    expect(hipaa.findings.join(' ')).toMatch(/HIPAA 164\.312/);

    empty.record(event());
    expect(empty.generateReport('HIPAA')).toMatchObject({ pass: true, findings: [] });
  });
});

// ── AC 69.18 — trigger and interval arithmetic ────────────

describe('AC 69 — the report counts triggers by what they are', () => {
  it('69.18 counts each trigger in its own bucket and manual in none', () => {
    const triggers: RotationTrigger[] = [
      { kind: 'compromise', reason: 'leak' },
      { kind: 'time', maxAgeMs: 1_000 },
      { kind: 'schedule', cron: '0 0 1 * *' },
      { kind: 'count', maxEncryptions: 100 },
      { kind: 'manual' },
      { kind: 'volume', maxBytes: 1_000 },
    ];
    const auditor = new RotationAuditor();
    for (const trigger of triggers) auditor.record(event({ trigger }));

    const report = auditor.generateReport('SOC2');

    expect(report.totalRotations).toBe(6);
    expect(report.emergencyRotations).toBe(1);
    expect(report.timeBasedRotations).toBe(2);
    expect(report.countBasedRotations).toBe(1);
  });

  it('69.19 averages the interval between successful rotations only', () => {
    const auditor = new RotationAuditor();
    auditor.record(event({ startedAt: 0, completedAt: 1_000 }));
    auditor.record(event({ startedAt: 0, completedAt: 3_000 }));
    auditor.record(failed({ startedAt: 0, completedAt: null }));

    expect(auditor.generateReport('SOC2').averageIntervalMs).toBe(2_000);

    const single = new RotationAuditor();
    single.record(event({ completedAt: 1_000 }));
    expect(single.generateReport('SOC2').averageIntervalMs).toBe(0);

    const three = new RotationAuditor();
    three.record(event({ completedAt: 1_000 }));
    three.record(event({ completedAt: 3_000 }));
    three.record(event({ completedAt: 10_000 }));
    expect(three.generateReport('SOC2').averageIntervalMs).toBe(4_500);
  });
});

// ── AC 69.20–69.23 — verification boundaries ──────────────

describe('AC 69 — what verify() calls a broken chain', () => {
  it('69.20 reports a clock that went backwards as invalid but not as a broken chain', () => {
    const auditor = new RotationAuditor();
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date(2_000_000_000_000));
    auditor.record(event());
    vi.setSystemTime(new Date(1_000_000_000_000));
    auditor.record(event());

    const result = auditor.verify();

    expect(result.valid).toBe(false);
    expect(result.chainBroken).toBe(false);
    expect(result.errors.join(' ')).toMatch(/timestamp regression at seq 2/);
  });

  it('69.21 calls a deleted entry a broken chain', () => {
    const auditor = new RotationAuditor();
    for (let i = 0; i < 3; i += 1) auditor.record(event());

    entriesOf(auditor).splice(1, 1);

    const result = auditor.verify();
    expect(result.valid).toBe(false);
    expect(result.chainBroken).toBe(true);
    expect(result.errors.join(' ')).toMatch(/seq gap/);
    expect(result.errors.join(' ')).toMatch(/chain broken/);
  });

  it('69.22 verifies an empty trail as whole and reports zero bounds', () => {
    const auditor = new RotationAuditor();

    expect(auditor.verify()).toEqual({
      valid: true,
      totalEntries: 0,
      errors: [],
      firstSeq: 0,
      lastSeq: 0,
      chainBroken: false,
    });
  });

  it('69.23 hands out a copy of the entry list but not of the entries', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());
    auditor.record(event({ policyId: 'policy-b' }));

    const copy = auditor.getEntries();
    copy.push(copy[0]!);

    expect(auditor.count).toBe(2);
    expect(auditor.getEntriesByPolicy('policy-b')).toHaveLength(1);
  });
});

// ── AC 69.24 — reset starts a new chain ───────────────────

describe('AC 69 — reset', () => {
  it('69.24 restarts numbering at one and verifies clean', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());
    auditor.record(event());

    auditor.reset();

    expect(auditor.count).toBe(0);
    const first = auditor.record(event());
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe('0'.repeat(64));
    expect(auditor.verify().valid).toBe(true);
  });
});
