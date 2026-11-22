/**
 * The tamper-evidence layer of an audit trail: one digest per entry, chained
 * through the entry before it.
 *
 * A line of JSON proves nothing about the line before it. Anyone who can write to
 * the file can delete a middle entry, edit a field, or swap two entries, and the
 * result reads exactly like an intact trail — which is why "tamper-evident" was
 * a claim this package only made in prose until this module existed.
 *
 * The design is a hash chain per writer, and both halves of that phrase matter:
 *
 *   - **Per writer.** Two processes may append to one trail (a rotation hook, a
 *     second replica, a migration). A single chain over the concatenation would
 *     need a global order that no writer can observe without a lock, and a chain
 *     that cannot be written under load is a chain that gets switched off. Each
 *     store instance therefore carries a writer id, and links only to its own
 *     previous entry. Integrity inside a writer's run — the thing an attacker
 *     edits — is preserved, and the file stays append-only.
 *   - **A chain, not a signature.** The digest is unkeyed SHA-256, so it detects
 *     an edit made without recomputing the rest of the chain, and it does not
 *     detect a rewrite by somebody who can write the whole file. That limit is
 *     stated in the user guide rather than implied away: a trail that has to
 *     resist its own administrator needs an external witness (a remote log, a
 *     notary, a WORM bucket), and no field in a local file can be one.
 *
 * What the chain covers is the canonical pre-image, not `JSON.stringify(entry)`:
 * an object's key order is an accident of construction, and a digest that changes
 * when a producer adds a field in a different order would report tampering on a
 * file nobody touched. `canonicalJson` fixes the order of every object, at every
 * depth, so two writers that mean the same thing hash the same thing.
 *
 * @module @agentix-e/db-node/audit/impl
 */

import { createHash } from 'node:crypto';

import type { AuditEntry, AuditChainLink } from '../../core/types.js';

/** The `prev` of the first entry of a writer's chain: no predecessor. */
export const GENESIS_DIGEST = '0'.repeat(64);

/**
 * Domain separator, hashed as the first element of every pre-image.
 *
 * Without it, a digest computed by some other part of the product (a snapshot
 * checksum, a Merkle leaf) could in principle be replayed as an audit link, and a
 * verifier would accept a value that was never a chain link. One string costs
 * nothing and removes the possibility.
 */
export const CHAIN_DOMAIN = 'db-node/audit/chain/v1';

/**
 * How many failures a verification reports before it stops collecting them.
 *
 * The count is always exact; the list is not, because a damaged trail can fail on
 * every line and a report that carries a million entries is a report nobody reads.
 */
const MAX_REPORTED_FAILURES = 100;

/** Why a link does not hold. */
export type AuditChainFailureReason =
  | 'unchained' // a line in a chained trail that carries no link at all
  | 'content' //  the entry's own digest does not match its bytes
  | 'link' //     the entry does not name its predecessor's digest
  | 'sequence-gap' // the entry's sequence does not follow its predecessor's
  | 'anchor-gap' // the trail resumes after a prefix nobody recorded giving up
  | 'anchor-link' // the first surviving entry does not join the recorded prefix
  | 'unparsable'; // a line that is not JSON at all

/** The first thing about a trail that does not hold. */
export interface AuditChainFailure {
  reason: AuditChainFailureReason;
  /** Entry id, or `<segment>:<line>` when the line could not be parsed. */
  where: string;
  /** Writer id, or `''` when the line carried none. */
  writer: string;
  /** Sequence number, or `0` when the line carried none. */
  seq: number;
}

/** The answer to "is this trail what it says it is". */
export interface AuditTrailVerification {
  /** True only when every line is chained, every digest holds and nothing failed. */
  ok: boolean;
  /** Lines examined, chained or not. */
  entries: number;
  /** Lines that carried a link. */
  chained: number;
  /** Lines that did not — written before the chain existed, or by a foreign tool. */
  unchained: number;
  /** Distinct writer ids seen. */
  writers: number;
  /**
   * Chains whose beginning is accounted for: either the writer's first surviving
   * entry is its genesis, or the anchor says which entries were given up before it
   * and the first survivor is the one that follows them.
   *
   * This is the number that makes a pruned trail auditable. Without it, "the first
   * forty entries are missing" and "the first surviving entry is number forty-one"
   * are the same observation, which is exactly the deletion a digest chain cannot
   * report on its own. `anchored + unanchored === writers`, always.
   */
  anchored: number;
  /**
   * Chains whose beginning is not accounted for.
   *
   * Two shapes, and only one of them is a break. A trail that starts above its
   * genesis with nothing recording what came before — written before the anchor
   * existed, or restored from an archive of segments — legitimately looks like that,
   * and `ok` stays `true`. A trail that starts where the record contradicts is an
   * `anchor-gap` or an `anchor-link` failure, and is counted here as well, because
   * the chain's head is unaccounted for either way.
   */
  unanchored: number;
  /** Exact number of failures, which may exceed `failures.length`-style reports. */
  failures: number;
  /** The first failure in trail order, or `null`. */
  firstFailure: AuditChainFailure | null;
  /**
   * The newest segment ends mid-line.
   *
   * A torn tail is what a crash between two writes leaves behind. It is not
   * tampering — the line was never acknowledged — so it does not make `ok` false,
   * but it is reported because "the last write was lost" is a fact an operator
   * wants without having to diff the file.
   */
  tornTail: boolean;
  /** The trail could not be read at all (the directory could not be listed). */
  unreadable: boolean;
  /**
   * The anchor exists and could not be read, so what the directory pruned is unknown.
   *
   * A verification that cannot read the record of its own deletions is not an
   * attestation, for the same reason a segment it could not read is not one — and
   * this one is worse, because the file that could have named the hole is the file
   * that is damaged.
   */
  anchorUnreadable: boolean;
  /** Up to `MAX_REPORTED_FAILURES` failures, in trail order. */
  reported: AuditChainFailure[];
  /**
   * The last link of each writer's chain, in writer order.
   *
   * The head of a chain is what an anchor has to record before the entries under it
   * are given up, so a store that prunes reads them from here rather than walking
   * the entries a second time.
   */
  heads: ChainHead[];
}

/**
 * One position in a writer's chain: the sequence number and the digest of the entry
 * that occupied it.
 *
 * Named once because the same pair answers three questions — what the head of a
 * surviving chain is, what a store gave up when it pruned, and whether the first
 * survivor joins the record. Two shapes would let those three drift apart, and the
 * whole value of an anchor is that all three are the same fact.
 */
export interface ChainHead {
  /** The writer whose chain this position belongs to. */
  writer: string;
  /** The sequence number of the entry at this position. */
  seq: number;
  /** The digest that entry recorded. */
  hash: string;
}

/**
 * JSON with object keys sorted at every depth.
 *
 * `undefined` becomes `null` at the top of a value and is dropped from an object,
 * which is what `JSON.stringify` does to a key whose value is `undefined`: the
 * canonical form has to agree with the form that was written to disk, or the two
 * would disagree about every entry that omits `details`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  // `NaN` and `±Infinity` are not JSON: `JSON.stringify` writes `null` for them, so
  // the canonical form has to write `null` too — otherwise a `details` object that
  // happens to hold one would be sealed over bytes that are not the bytes on disk.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  // `bigint`, `symbol`, `function`: not JSON, and never produced by `write()`.
  // Stringifying them would invent a representation two writers could disagree
  // about, so the value is refused rather than hashed.
  throw new TypeError(`audit chain: ${typeof value} cannot be part of a canonical entry`);
}

/**
 * The exact bytes a digest is computed over.
 *
 * An array rather than an object because the fields are positional and the list is
 * the definition: adding a field is a new domain (`v2`), never a silent widening
 * that would make every existing trail fail to verify.
 */
export function chainPreimage(entry: AuditEntry, writer: string, seq: number, prev: string): string {
  return canonicalJson([
    CHAIN_DOMAIN,
    entry.id,
    entry.timestamp,
    entry.operation,
    entry.actor,
    entry.resource,
    entry.result,
    entry.severity,
    entry.details ?? null,
    entry.traceId ?? null,
    writer,
    seq,
    prev,
  ]);
}

/** SHA-256 of the pre-image, lowercase hex. */
export function chainDigest(preimage: string): string {
  // No encoding argument: `update` reads a string as UTF-8, and an argument that cannot
  // change the answer is an argument only a mutant reads.
  return createHash('sha256').update(preimage).digest('hex');
}

/**
 * Seal one entry: the link a store writes next to it.
 *
 * `hash` is computed last and from `prev`, so the link to the predecessor is part
 * of what the digest covers — the property that makes editing one entry break the
 * next one instead of only itself.
 */
export function sealEntry(entry: AuditEntry, writer: string, seq: number, prev: string): AuditChainLink {
  const hash = chainDigest(chainPreimage(entry, writer, seq, prev));
  return { writer, seq, prev, hash };
}

/**
 * Recompute an entry's digest from its own bytes and its recorded link position.
 *
 * Returns `null` when the entry has no link: there is nothing to recompute, and an
 * unchained entry is reported as such rather than as a mismatch.
 */
export function recomputeDigest(entry: AuditEntry): string | null {
  const link = entry.chain;
  if (link === undefined) return null;
  return chainDigest(chainPreimage(entry, link.writer, link.seq, link.prev));
}

/**
 * One segment's bytes, as lines and the reasons they are not entries.
 *
 * The reader is here rather than in the store because three callers need the same
 * three answers and they must not disagree: `verify()` builds a report from them,
 * a prune decides from them whether a file may be given up, and a test asserts
 * them. A second parsing loop in the store would be a second opinion about what a
 * torn tail is, and the two would drift the first time one of them changed.
 */
export interface ParsedSegment {
  /** The entries that parsed, in file order. */
  entries: AuditEntry[];
  /** 1-based line numbers that were not JSON. */
  unparsable: number[];
  /**
   * The last line has no newline after it.
   *
   * True whether that last line parsed or not, because both are the same event: a
   * process that died inside `append`. It is reported next to the entries rather
   * than as a failure — the bytes that landed are a whole entry often enough that
   * calling them damage would lose one.
   */
  tornTail: boolean;
}

/**
 * Read a segment's text the way the store always has: one JSON object per line, a
 * final newline that is not a line, blank lines skipped, and the last line read as
 * a torn tail when it has no newline.
 *
 * `''` is an empty segment, not an unreadable one: this function is only reached
 * with the *text* of a segment, and the question of whether a segment could be read
 * at all is answered by the port, where `null` means it could not.
 */
export function parseSegmentText(text: string): ParsedSegment {
  const entries: AuditEntry[] = [];
  const unparsable: number[] = [];
  // A final newline leaves an empty last element, and an empty line is skipped two lines
  // below — so there is nothing to remove and nothing to remember: the position test for
  // a torn tail is "the last element", whether that element is a line or the space after
  // one. The version of this function that popped it carried two branches no case could
  // reach, because the guard that skipped empty lines had already made them no-ops.
  const lines = text.split('\n');

  let tornTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const unterminated = i === lines.length - 1;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
      if (unterminated) tornTail = true;
    } catch {
      // A fragment at the very end of a segment is a crash, not an attack: the store
      // writes `line\n` in one call, so a line that does not end on a newline was
      // never acknowledged. Anywhere else it is a line that was rewritten or
      // truncated by somebody else.
      if (unterminated) tornTail = true;
      else unparsable.push(i + 1);
    }
  }
  return { entries, unparsable, tornTail };
}

/**
 * The last link of each chain in a map of chains, sorted by writer.
 *
 * A map's iteration order is the order the entries were met in, which is a fact about
 * how a trail happened to interleave its writers rather than about the trail. Two reports
 * of the same trail have to be comparable, so the list is sorted — and by the *names*,
 * with the default sort, because a comparator is three branches (less, greater, equal)
 * of which the third cannot occur when the keys are a map's.
 */
export function chainHeads(state: ReadonlyMap<string, { seq: number; hash: string }>): ChainHead[] {
  const heads: ChainHead[] = [];
  for (const writer of [...state.keys()].sort()) {
    // The assertion rather than a guard: the key came out of this map, so the lookup
    // cannot miss, and a guard here could never be the reason a head was skipped.
    const head = state.get(writer) as { seq: number; hash: string };
    heads.push({ writer, seq: head.seq, hash: head.hash });
  }
  return heads;
}

/** Options for `verifyTrail`. */
export interface VerifyTrailOptions {
  /** The newest segment ends mid-line. See `AuditTrailVerification.tornTail`. */
  tornTail?: boolean;
  /** Lines that were not JSON, already located by the reader. */
  unparsable?: ReadonlyArray<{ where: string }>;
  /** The trail could not be read. See `AuditTrailVerification.unreadable`. */
  unreadable?: boolean;
  /**
   * What the directory recorded giving up: the last link of each pruned prefix,
   * by writer.
   *
   * A writer absent from this map is a writer whose beginning nothing explains; a
   * writer present in it has a *floor*, and the first surviving entry is checked
   * against that floor. Two things can then be said that a chain alone cannot: the
   * trail resumes above the floor — entries between the two are gone with nothing
   * recording that they were deliberately pruned — or it resumes exactly at the
   * floor and does not name the digest the floor recorded.
   */
  anchor?: ReadonlyMap<string, ChainHead>;
  /** The anchor exists and could not be read. See `AuditTrailVerification.anchorUnreadable`. */
  anchorUnreadable?: boolean;
}

/**
 * Walk a trail and answer whether every link holds.
 *
 * Entries must arrive in the order they were appended. A chain is a statement
 * about a sequence, so a caller that sorts them — by timestamp, say, which is not
 * unique within a millisecond — gets a verification of a trail that does not
 * exist. Each writer's links are checked against that writer's own predecessor,
 * so a trail written by several processes verifies without those processes having
 * coordinated.
 *
 * A writer's first observed entry starts its chain, whatever its `seq` is: a trail
 * whose oldest segments were pruned or archived away still has to verify, and
 * "the prefix is gone" is not "the links are broken". What cannot be forgiven is
 * a gap *inside* what is present — that is a deleted entry — which is what the
 * `sequence-gap` and `link` reasons name.
 *
 * The one thing a chain cannot say about its own beginning is whether the prefix
 * was given up or taken, so `options.anchor` supplies the directory's record of
 * what it pruned and the two answers differ: resuming *above* a recorded floor is
 * `anchor-gap`, resuming *at* it without naming the digest the floor recorded is
 * `anchor-link`, and resuming above 1 with no record at all is reported as
 * `unanchored` rather than as a break — a trail written before the record existed
 * looks exactly like that, and accusing every legacy trail of tampering is how a
 * report stops being read.
 */
export function verifyTrail(entries: readonly AuditEntry[], options: VerifyTrailOptions = {}): AuditTrailVerification {
  const state = new Map<string, { seq: number; hash: string }>();
  const reported: AuditChainFailure[] = [];
  let failures = 0;
  let chained = 0;
  let unchained = 0;
  let anchored = 0;
  let unanchored = 0;

  const note = (failure: AuditChainFailure): void => {
    failures += 1;
    if (reported.length < MAX_REPORTED_FAILURES) reported.push(failure);
  };

  for (const entry of entries) {
    const link = entry.chain;
    if (link === undefined) {
      unchained += 1;
      note({ reason: 'unchained', where: entry.id, writer: '', seq: 0 });
      continue;
    }

    chained += 1;

    // The beginning of this writer's surviving run, judged before its own bytes are:
    // the two counts are about *positions*, and a line whose digest does not hold
    // still tells us where the chain it belongs to begins. Every writer lands in
    // exactly one of them, which is what makes `anchored + unanchored === writers`
    // an invariant rather than a coincidence.
    const previous = state.get(link.writer);
    let head: AuditChainFailureReason | null = null;
    if (previous === undefined) {
      const record = options.anchor?.get(link.writer);
      if (record === undefined) {
        // Nothing recorded a prune for this writer. A chain that starts at its
        // genesis needs no record; one that starts above it is unaccounted for, not
        // broken.
        if (link.seq > 1) unanchored += 1;
        else anchored += 1;
      } else if (link.seq > record.seq + 1) {
        // The record says everything up to `record.seq` was given up, and this is
        // not the entry that follows it: the entries in between were removed
        // without being recorded, which is the deletion a chain cannot see.
        unanchored += 1;
        head = 'anchor-gap';
      } else if (link.seq === record.seq + 1 && link.prev !== record.hash) {
        // The right position, the wrong predecessor: the entry that was pruned is
        // not the entry this one continues.
        unanchored += 1;
        head = 'anchor-link';
      } else {
        anchored += 1;
      }
    }

    const recomputed = recomputeDigest(entry);
    if (recomputed !== link.hash) {
      // Before the link check, because a rewritten entry usually also breaks its
      // own digest, and "this line's bytes are not what was sealed" is the more
      // useful of the two sentences.
      note({ reason: 'content', where: entry.id, writer: link.writer, seq: link.seq });
      state.set(link.writer, { seq: link.seq, hash: link.hash });
      continue;
    }

    if (previous === undefined) {
      if (head !== null) note({ reason: head, where: entry.id, writer: link.writer, seq: link.seq });
    } else if (link.seq !== previous.seq + 1) {
      note({ reason: 'sequence-gap', where: entry.id, writer: link.writer, seq: link.seq });
    } else if (link.prev !== previous.hash) {
      note({ reason: 'link', where: entry.id, writer: link.writer, seq: link.seq });
    }

    state.set(link.writer, { seq: link.seq, hash: link.hash });
  }

  for (const line of options.unparsable ?? []) {
    note({ reason: 'unparsable', where: line.where, writer: '', seq: 0 });
  }

  const unreadable = options.unreadable === true;
  const anchorUnreadable = options.anchorUnreadable === true;
  return {
    // `unchained === 0` is not stated separately, because every unchained line is already
    // counted as a failure: a clause that cannot be the reason `ok` is false is a clause
    // that only a mutant reads.
    ok: !unreadable && !anchorUnreadable && failures === 0,
    entries: entries.length,
    chained,
    unchained,
    writers: state.size,
    anchored,
    unanchored,
    failures,
    firstFailure: reported[0] ?? null,
    tornTail: options.tornTail === true,
    unreadable,
    anchorUnreadable,
    reported,
    heads: chainHeads(state),
  };
}

/** One line an operator can act on, or the absence of one when nothing failed. */
export function describeVerification(result: AuditTrailVerification): string {
  if (result.unreadable) return 'audit trail: unreadable — the data directory could not be listed';
  if (result.anchorUnreadable) {
    return 'audit trail: the anchor cannot be read — what this directory pruned is unknown';
  }
  if (result.ok) {
    const counts = `${result.entries} entries across ${result.writers} chain(s), every link holds`;
    // The head, when it is not accounted for, belongs in the sentence that says the
    // trail is intact: the two are both answers to "what am I looking at", and a
    // reader who has to open the object to learn that a chain starts at 41 has been
    // told half the truth.
    if (result.unanchored === 0) return `audit trail: ${counts}`;
    return `audit trail: ${counts}, ${result.unanchored} of them starting above their first entry with no record of a prune`;
  }
  const first = result.firstFailure;
  const where =
    first === null ? 'unknown' : `${first.where} (${first.reason}${first.seq === 0 ? '' : ` at seq ${first.seq}`})`;
  const reasons = [`first break: ${where}`];
  if (result.failures > 0) {
    // One number, and what it is made of. Two sentences would say the same thing
    // twice, because an unchained line is already counted as a failure.
    reasons.push(
      result.unchained === 0
        ? `${result.failures} failure(s)`
        : `${result.failures} failure(s), ${result.unchained} of them unchained`,
    );
  }
  return `audit trail: ${reasons.join(', ')}`;
}
