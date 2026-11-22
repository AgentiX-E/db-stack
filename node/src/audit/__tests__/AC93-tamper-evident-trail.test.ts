/**
 * AC 93 — the trail proves itself, or says where it stopped proving.
 *
 * The audit store's documents called it "tamper-evident" for as long as it wrote
 * plain JSON lines. Nothing linked one line to the next, so deleting a middle
 * entry, editing a field or swapping two entries left a file that read exactly
 * like an intact one — and the suite could only assert that an acknowledged entry
 * was still *readable*, which is a different property.
 *
 * What each group is for:
 *
 *   Canonical form — one digest for two writers that mean the same thing
 *     CF.1  keys are ordered at every depth, so key order is not tampering
 *     CF.2  `undefined` disappears from an object and becomes `null` as a value
 *     CF.3  arrays keep their order and their length
 *     CF.4  a value JSON cannot carry is refused instead of being invented
 *     CF.5  the pre-image is positional: one field, one position, one domain
 *
 *   Sealing — the link a store writes
 *     SL.1  the first entry of a chain names the genesis digest
 *     SL.2  the digest covers `prev`: same entry, different predecessor, new digest
 *     SL.3  the digest covers the writer and the sequence, not just the payload
 *
 *   Verification — what a reader asks of a trail it did not write
 *     VF.1  an empty trail is intact, and says it examined nothing
 *     VF.2  a chain verifies without the writer having coordinated with anybody
 *     VF.3  an edited entry is named as `content`, and the next entry still holds
 *     VF.4  an edited entry *with* a recomputed digest is named as `link` at the next
 *     VF.5  a deleted middle entry is named as a sequence gap
 *     VF.6  a re-ordered pair is named
 *     VF.7  an unchained line makes the trail unverifiable, and is counted
 *     VF.8  a pruned prefix is not a broken link
 *     VF.9  two writers interleaved in one file each verify on their own chain
 *     VF.10 a torn tail is reported without failing the trail
 *     VF.11 a line that is not JSON is located by segment and line number
 *     VF.12 an unreadable trail is not an intact one
 *     VF.13 a damaged trail reports the first break and counts the rest
 *
 *   The store — the chain survives rotation, compression and a second process
 *     ST.1  every written entry carries a link, in order, from the genesis digest
 *     ST.2  a trail spanning plain and compressed segments verifies
 *     ST.3  an edited line on disk is refused, and named by entry id
 *     ST.4  a deleted line on disk is refused
 *     ST.5  a hand-appended line is counted as unchained
 *     ST.6  two stores with distinct ids write two chains that both verify
 *     ST.7  the writer id is configurable, and unique when it is not
 *     ST.8  a legacy single-array export is read as unchained, not as a crash
 *     ST.9  a truncated final line is a torn tail, not tampering
 *     ST.10 verify() sees a write whose acknowledgement nobody awaited
 *     ST.11 a directory that cannot be listed is reported as unreadable
 *     ST.12 the in-memory store chains and verifies too, and notices an edit
 *     ST.13 an export carries the links, so the evidence travels with the entries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileAuditStore } from '../impl/FileAuditStore.js';
import { InMemoryAuditStore } from '../impl/InMemoryAuditStore.js';
import { JsonAuditExporter } from '../impl/JsonAuditExporter.js';
import {
  CHAIN_DOMAIN,
  GENESIS_DIGEST,
  canonicalJson,
  chainDigest,
  chainPreimage,
  describeVerification,
  recomputeDigest,
  sealEntry,
  verifyTrail,
} from '../impl/auditChain.js';
import type { AuditEntry } from '../../core/types.js';
import type { WriteAuditEntryOptions } from '../interfaces/index.js';

/** An entry as a store would have built it, before sealing. */
function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'e1',
    timestamp: '2026-01-01T00:00:00.000Z',
    operation: 'rotate-key',
    actor: 'alice',
    resource: 'tenant-1',
    result: 'success',
    severity: 'info',
    ...overrides,
  };
}

/** A trail of `n` sealed entries for one writer. */
function chainOf(n: number, writer = 'w1'): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prev = GENESIS_DIGEST;
  for (let i = 1; i <= n; i++) {
    const e = entry({ id: `e${i}` });
    const link = sealEntry(e, writer, i, prev);
    e.chain = link;
    prev = link.hash;
    entries.push(e);
  }
  return entries;
}

let dir: string;
const write = (overrides: Partial<WriteAuditEntryOptions> = {}): WriteAuditEntryOptions => ({
  operation: 'rotate-key',
  actor: 'alice',
  resource: 'tenant-1',
  result: 'success',
  severity: 'info',
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac93-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Canonical form ──────────────────────────────────────────────

describe('AC 93 — canonical form', () => {
  it('CF.1: keys are ordered at every depth, so key order is not tampering', () => {
    const a = { b: 1, a: { d: 2, c: [1, { f: 3, e: 4 }] } };
    const b = { a: { c: [1, { e: 4, f: 3 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":[1,{"e":4,"f":3}],"d":2},"b":1}');
  });

  it('CF.2: undefined disappears from an object and becomes null as a value', () => {
    // The written line is `JSON.stringify(entry)`, which drops a key whose value is
    // undefined. The canonical form has to agree with it or every entry that omits
    // `details` would fail its own digest.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson([1, undefined])).toBe('[1,null]');
  });

  it('CF.3: arrays keep their order and their length', () => {
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
    expect(canonicalJson([null, null])).toBe('[null,null]');
    // Scalars are JSON scalars: a string is quoted and escaped, a boolean is bare,
    // and a number that JSON cannot represent is written the way `JSON.stringify`
    // writes it — `null` — so the sealed bytes and the stored bytes agree.
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalJson(-0.5)).toBe('-0.5');
  });

  it('CF.4: a value JSON cannot carry is refused instead of being invented', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint cannot be part of a canonical entry/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function cannot be part/);
  });

  it('CF.5: the pre-image is positional: one field, one position, one domain', () => {
    const preimage = JSON.parse(chainPreimage(entry(), 'w1', 1, GENESIS_DIGEST)) as unknown[];
    expect(preimage[0]).toBe(CHAIN_DOMAIN);
    expect(preimage[1]).toBe('e1');
    expect(preimage[10]).toBe('w1');
    expect(preimage[11]).toBe(1);
    expect(preimage[12]).toBe(GENESIS_DIGEST);
    expect(preimage).toHaveLength(13);
    // `chain` is not part of the pre-image: the digest would otherwise cover itself.
    expect(chainPreimage({ ...entry(), chain: undefined }, 'w1', 1, GENESIS_DIGEST)).toBe(
      chainPreimage(entry(), 'w1', 1, GENESIS_DIGEST),
    );
  });
});

// ── Sealing ─────────────────────────────────────────────────────

describe('AC 93 — sealing', () => {
  it('SL.1: the first entry of a chain names the genesis digest', () => {
    const link = sealEntry(entry(), 'w1', 1, GENESIS_DIGEST);
    expect(link.prev).toBe('0'.repeat(64));
    expect(link.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(link.seq).toBe(1);
    expect(link.writer).toBe('w1');
  });

  it('SL.2: the digest covers prev: same entry, different predecessor, new digest', () => {
    const a = sealEntry(entry(), 'w1', 2, GENESIS_DIGEST);
    const b = sealEntry(entry(), 'w1', 2, 'f'.repeat(64));
    expect(a.hash).not.toBe(b.hash);
  });

  it('SL.3: the digest covers the writer and the sequence, not just the payload', () => {
    const base = sealEntry(entry(), 'w1', 1, GENESIS_DIGEST).hash;
    expect(sealEntry(entry(), 'w2', 1, GENESIS_DIGEST).hash).not.toBe(base);
    expect(sealEntry(entry(), 'w1', 2, GENESIS_DIGEST).hash).not.toBe(base);
    expect(recomputeDigest(entry())).toBeNull();
  });
});

// ── Verification ────────────────────────────────────────────────

describe('AC 93 — verification', () => {
  it('VF.1: an empty trail is intact, and says it examined nothing', () => {
    const result = verifyTrail([]);
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.writers).toBe(0);
    expect(result.firstFailure).toBeNull();
  });

  it('VF.2: a chain verifies without the writer having coordinated with anybody', () => {
    const result = verifyTrail(chainOf(5));
    expect(result).toMatchObject({ ok: true, entries: 5, chained: 5, writers: 1, failures: 0 });
  });

  it('VF.3: an edited entry is named as content, and the next entry still holds', () => {
    const entries = chainOf(4);
    entries[1]!.actor = 'mallory';
    const result = verifyTrail(entries);
    expect(result.ok).toBe(false);
    expect(result.failures).toBe(1);
    expect(result.firstFailure).toMatchObject({ reason: 'content', where: 'e2', writer: 'w1', seq: 2 });
  });

  it('VF.4: an edited entry with a recomputed digest is named as link at the next', () => {
    const entries = chainOf(4);
    const edited = entries[1]!;
    edited.actor = 'mallory';
    // What an attacker who understands the chain does next: reseal the line so its
    // own digest holds. The successor is what they cannot fix without rewriting it
    // too — and rewriting it moves the break one entry down.
    edited.chain = sealEntry(edited, 'w1', 2, edited.chain!.prev);
    const result = verifyTrail(entries);
    expect(result.firstFailure).toMatchObject({ reason: 'link', where: 'e3', seq: 3 });
  });

  it('VF.5: a deleted middle entry is named as a sequence gap', () => {
    const entries = chainOf(5);
    entries.splice(2, 1);
    const result = verifyTrail(entries);
    expect(result.firstFailure).toMatchObject({ reason: 'sequence-gap', where: 'e4', seq: 4 });
  });

  it('VF.6: a re-ordered pair is named', () => {
    const entries = chainOf(4);
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    const result = verifyTrail(entries);
    expect(result.ok).toBe(false);
    expect(result.firstFailure?.reason).toBe('sequence-gap');
    expect(result.firstFailure?.where).toBe('e3');
  });

  it('VF.7: an unchained line makes the trail unverifiable, and is counted', () => {
    const entries = chainOf(3);
    entries.push(entry({ id: 'planted' }));
    const result = verifyTrail(entries);
    expect(result.ok).toBe(false);
    expect(result.unchained).toBe(1);
    expect(result.firstFailure).toMatchObject({ reason: 'unchained', where: 'planted', seq: 0 });
  });

  it('VF.8: a pruned prefix is not a broken link', () => {
    const entries = chainOf(6).slice(2);
    const result = verifyTrail(entries);
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(4);
    expect(result.firstFailure).toBeNull();
  });

  it('VF.9: two writers interleaved in one file each verify on their own chain', () => {
    const a = chainOf(3, 'a');
    const b = chainOf(3, 'b');
    const interleaved = [a[0]!, b[0]!, a[1]!, b[1]!, a[2]!, b[2]!];
    const result = verifyTrail(interleaved);
    expect(result.ok).toBe(true);
    expect(result.writers).toBe(2);
  });

  it('VF.10: a torn tail is reported without failing the trail', () => {
    const result = verifyTrail(chainOf(3), { tornTail: true });
    expect(result.ok).toBe(true);
    expect(result.tornTail).toBe(true);
    expect(describeVerification(result)).toMatch(/every link holds/);
  });

  it('VF.11: a line that is not JSON is located by segment and line number', () => {
    const result = verifyTrail(chainOf(2), { unparsable: [{ where: 'audit-20260101-0001.ndjson:7' }] });
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({
      reason: 'unparsable',
      where: 'audit-20260101-0001.ndjson:7',
    });
  });

  it('VF.12: an unreadable trail is not an intact one', () => {
    const result = verifyTrail([], { unreadable: true });
    expect(result.ok).toBe(false);
    expect(result.unreadable).toBe(true);
    expect(describeVerification(result)).toMatch(/unreadable/);
  });

  it('VF.13: a damaged trail reports the first break and counts the rest', () => {
    const entries = chainOf(150);
    for (const e of entries) e.actor = 'mallory';
    const result = verifyTrail(entries);
    expect(result.failures).toBe(150);
    // The count is exact; the list is capped, because a report nobody can read is
    // not a report.
    expect(result.reported).toHaveLength(100);
    expect(result.firstFailure?.where).toBe('e1');
    expect(describeVerification(result)).toMatch(
      /^audit trail: first break: e1 \(content at seq 1\), 150 failure\(s\)$/,
    );
  });
});

// ── The store ───────────────────────────────────────────────────

describe('AC 93 — the store writes the chain', () => {
  it('ST.1: every written entry carries a link, in order, from the genesis digest', async () => {
    const store = new FileAuditStore({ dataDir: dir, writerId: 'w1' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await store.write(write({ details: { i } })));
    await store.close();

    const entries = await store.query({});
    expect(entries).toHaveLength(3);
    let prev = GENESIS_DIGEST;
    for (const [i, e] of entries.entries()) {
      expect(e.chain).toMatchObject({ writer: 'w1', seq: i + 1, prev });
      expect(e.chain!.hash).toBe(chainDigest(chainPreimage(e, 'w1', i + 1, prev)));
      prev = e.chain!.hash;
    }
    expect(ids).toHaveLength(3);
    expect((await store.verify()).ok).toBe(true);
  });

  it('ST.2: a trail spanning plain and compressed segments verifies', async () => {
    // A 1-byte budget rotates on every line, so the trail is several segments and
    // the earlier ones are compressed by the rotation hook — the shape in which a
    // verifier that only read the live file would answer "intact" about one line.
    const store = new FileAuditStore({ dataDir: dir, maxFileSize: 1 });
    for (let i = 0; i < 6; i++) await store.write(write({ details: { i } }));
    await store.close();

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, entries: 6, chained: 6, writers: 1 });
    expect(readdirSync(dir).length).toBeGreaterThan(1);
  });

  it('ST.3: an edited line on disk is refused, and named by entry id', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    const first = await store.write(write({ actor: 'alice' }));
    await store.write(write({ actor: 'bob' }));
    await store.close();

    const segment = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.ndjson'))!,
    );
    const lines = readFileSync(segment, 'utf8').trimEnd().split('\n');
    const tampered = JSON.parse(lines[0]!) as AuditEntry;
    tampered.actor = 'mallory';
    lines[0] = JSON.stringify(tampered);
    writeFileSync(segment, `${lines.join('\n')}\n`);

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({ reason: 'content', where: first });
    // The rest of the trail still reads: tamper-evidence is a report, not a refusal
    // to serve.
    expect(await store.count()).toBe(2);
  });

  it('ST.4: a deleted line on disk is refused', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    for (let i = 0; i < 4; i++) await store.write(write({ details: { i } }));
    await store.close();

    const segment = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.ndjson'))!,
    );
    const lines = readFileSync(segment, 'utf8').trimEnd().split('\n');
    lines.splice(1, 1);
    writeFileSync(segment, `${lines.join('\n')}\n`);

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.firstFailure?.reason).toBe('sequence-gap');
    expect(result.failures).toBe(1);
  });

  it('ST.5: a hand-appended line is counted as unchained', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    await store.write(write());
    await store.close();

    const segment = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.ndjson'))!,
    );
    // What a tool that predates the chain — or an operator "fixing" a record —
    // produces: a valid entry with no link.
    writeFileSync(segment, `${readFileSync(segment, 'utf8')}${JSON.stringify(entry({ id: 'planted' }))}\n`);

    const result = await store.verify();
    expect(result.unchained).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({ reason: 'unchained', where: 'planted' });
  });

  it('ST.6: two stores with distinct ids write two chains that both verify', async () => {
    const a = new FileAuditStore({ dataDir: dir, writerId: 'a' });
    // The second store is constructed after the first has named a segment, so it
    // adopts that segment rather than opening one of its own — which is the shape
    // that matters: two processes appending to one file.
    await a.write(write({ actor: 'a' }));
    const b = new FileAuditStore({ dataDir: dir, writerId: 'b' });
    for (let i = 0; i < 2; i++) {
      await a.write(write({ actor: 'a' }));
      await b.write(write({ actor: 'b' }));
    }
    await a.close();
    await b.close();

    const result = await a.verify();
    expect(result).toMatchObject({ ok: true, entries: 5, writers: 2 });
    const entries = await a.query({});
    expect(entries.map((e) => e.chain!.writer)).toEqual(['a', 'a', 'b', 'a', 'b']);
    expect(entries.map((e) => e.chain!.seq)).toEqual([1, 2, 1, 3, 2]);
  });

  it('ST.7: the writer id is configurable, and unique when it is not', async () => {
    const configured = new FileAuditStore({ dataDir: join(dir, 'a'), writerId: 'ops-runner' });
    await configured.write(write());
    const other = new FileAuditStore({ dataDir: join(dir, 'b') });
    await other.write(write());
    await configured.close();
    await other.close();

    const [first] = await configured.query({});
    const [second] = await other.query({});
    expect(first!.chain!.writer).toBe('ops-runner');
    // A reused default would restart the sequence at 1 on every restart, and
    // "sequence went backwards" is the one shape a verifier cannot tell from an
    // attacker deleting entries.
    expect(second!.chain!.writer).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.chain!.writer).not.toBe('ops-runner');
  });

  it('ST.8: a legacy single-array export is read as unchained, not as a crash', async () => {
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify([entry({ id: 'old-1' }), entry({ id: 'old-2' })]));
    const store = new FileAuditStore({ dataDir: dir });

    const result = await store.verify();
    expect(result.entries).toBe(2);
    expect(result.unchained).toBe(2);
    expect(result.ok).toBe(false);
    // …and the entries are still queryable, which is the whole reason the format is
    // still read.
    expect(await store.count()).toBe(2);
  });

  it('ST.9: a truncated final line is a torn tail, not tampering', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    await store.write(write());
    await store.write(write());
    await store.close();

    const segment = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.ndjson'))!,
    );
    const content = readFileSync(segment, 'utf8');
    // A crash between the bytes and the newline.
    writeFileSync(segment, content.slice(0, content.length - 40));

    const result = await store.verify();
    expect(result.tornTail).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.chained).toBe(1);
  });

  it('ST.10: verify() sees a write whose acknowledgement nobody awaited', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    void store.write(write());
    // No `await close()`: `verify()` flushes the queue itself, because an entry a
    // caller has been told about must not be reported as missing while it is still
    // in the group-commit queue.
    const result = await store.verify();
    expect(result.entries).toBe(1);
    expect(result.ok).toBe(true);
    await store.close();
  });

  it('ST.11: a directory that cannot be listed is reported as unreadable', async () => {
    const store = new FileAuditStore({ dataDir: join(dir, 'gone') });
    await store.write(write());
    await store.close();
    rmSync(join(dir, 'gone'), { recursive: true, force: true });

    const result = await store.verify();
    expect(result.unreadable).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('ST.12: the in-memory store chains and verifies too, and notices an edit', async () => {
    const store = new InMemoryAuditStore('mem');
    const id = await store.write(write());
    await store.write(write());
    expect(await store.verify()).toMatchObject({ ok: true, entries: 2, writers: 1 });

    const held = await store.get(id);
    held!.actor = 'mallory';
    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({ reason: 'content', where: id });
  });

  it('ST.13: an export carries the links, so the evidence travels with the entries', async () => {
    const store = new FileAuditStore({ dataDir: dir, writerId: 'w1' });
    await store.write(write());
    await store.close();

    const text = await new JsonAuditExporter(store).exportToString({ format: 'json-array' });
    const parsed = JSON.parse(text) as AuditEntry[];
    expect(parsed[0]!.chain).toMatchObject({ writer: 'w1', seq: 1, prev: GENESIS_DIGEST });
    // A reader that receives only the export can verify it, which is the point of
    // putting the link in the entry rather than in a sidecar file.
    expect(verifyTrail(parsed).ok).toBe(true);
  });
});

describe('AC 93 — the sentence an operator reads', () => {
  it('DV.1: an unchained line is named in the summary, and changed bytes are not', () => {
    const entries = chainOf(2);
    entries.push(entry({ id: 'planted' }));
    const text = describeVerification(verifyTrail(entries));
    expect(text).toMatch(/first break: planted \(unchained\)/);
    expect(text).toMatch(/1 failure\(s\), 1 of them unchained/);
  });

  it('DV.2: a trail with no failure recorded still answers, rather than crashing', () => {
    // Not a shape `verifyTrail` produces — it is what a caller that recorded its own
    // verification holds, and the formatter is public. That is also why this literal
    // has to be written out in full: it is the compiler's reminder that a report type
    // is a contract with its readers, not an implementation detail.
    const text = describeVerification({
      ok: false,
      entries: 3,
      chained: 3,
      unchained: 0,
      writers: 1,
      anchored: 1,
      unanchored: 0,
      failures: 0,
      firstFailure: null,
      tornTail: false,
      unreadable: false,
      anchorUnreadable: false,
      reported: [],
      heads: [],
    });
    expect(text).toBe('audit trail: first break: unknown');
  });
});

// ── The survivors, read one by one ──────────────────────────────

/**
 * Six mutants of `auditChain.ts` survived the first run of the mutation gate. Each
 * case here names the mutant it kills; the seventh (`update(preimage, 'utf8')` →
 * `update(preimage, '')`) is equivalent, because `''` is falsy and StringDecoder
 * falls back to utf8 — it is argued in the mutation report rather than tested.
 */
describe('AC 93 — the survivors of the chain’s mutation run', () => {
  it('CV.1: details and traceId are part of the pre-image, so an entry that carries them still verifies', () => {
    // `entry.details ?? null` → `entry.details && null` survived: no sealed entry in
    // the suite carried optional fields, so the two forms agreed on every input it saw.
    const e = entry({ details: { key: 'k1' }, traceId: 'trace-1' });
    e.chain = sealEntry(e, 'w1', 1, GENESIS_DIGEST);
    expect(verifyTrail([e]).ok).toBe(true);

    // And the pre-image really contains them, in the positions that are the format.
    const preimage = JSON.parse(chainPreimage(e, 'w1', 1, GENESIS_DIGEST)) as unknown[];
    expect(preimage[8]).toEqual({ key: 'k1' });
    expect(preimage[9]).toBe('trace-1');
  });

  it('CV.2: an unchained line names no writer and no sequence', () => {
    // The `writer: ''` and `seq: 0` of the `unchained` record both survived: the
    // cases asserted the reason and the id, not the fields that say "nobody claims this".
    const result = verifyTrail([entry({ id: 'planted' })]);
    expect(result.firstFailure).toEqual({ reason: 'unchained', where: 'planted', writer: '', seq: 0 });
  });

  it('CV.3: an unparsable line names no writer either', () => {
    const result = verifyTrail([], { unparsable: [{ where: 'audit-1.ndjson:4' }] });
    expect(result.firstFailure).toEqual({ reason: 'unparsable', where: 'audit-1.ndjson:4', writer: '', seq: 0 });
  });

  it('CV.4: a broken link makes the trail not ok', () => {
    // `ok: !unreadable && failures === 0 && unchained === 0` → `true` survived, which
    // means every case asserted something *about* the failure and none asserted `ok`.
    const entries = chainOf(3);
    entries[1]!.actor = 'mallory';
    expect(verifyTrail(entries).ok).toBe(false);
  });

  it('CV.5: a torn tail is off unless it is reported', () => {
    // `options.tornTail === true` → `true` survived: no case asserted the default.
    expect(verifyTrail(chainOf(1)).tornTail).toBe(false);
    expect(verifyTrail(chainOf(1), { tornTail: true }).tornTail).toBe(true);
  });
});
