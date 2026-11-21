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
  /** Up to `MAX_REPORTED_FAILURES` failures, in trail order. */
  reported: AuditChainFailure[];
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
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
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

/** Options for `verifyTrail`. */
export interface VerifyTrailOptions {
  /** The newest segment ends mid-line. See `AuditTrailVerification.tornTail`. */
  tornTail?: boolean;
  /** Lines that were not JSON, already located by the reader. */
  unparsable?: ReadonlyArray<{ where: string }>;
  /** The trail could not be read. See `AuditTrailVerification.unreadable`. */
  unreadable?: boolean;
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
 */
export function verifyTrail(entries: readonly AuditEntry[], options: VerifyTrailOptions = {}): AuditTrailVerification {
  const state = new Map<string, { seq: number; hash: string }>();
  const reported: AuditChainFailure[] = [];
  let failures = 0;
  let chained = 0;
  let unchained = 0;

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
    const recomputed = recomputeDigest(entry);
    if (recomputed !== link.hash) {
      // Before the link check, because a rewritten entry usually also breaks its
      // own digest, and "this line's bytes are not what was sealed" is the more
      // useful of the two sentences.
      note({ reason: 'content', where: entry.id, writer: link.writer, seq: link.seq });
      state.set(link.writer, { seq: link.seq, hash: link.hash });
      continue;
    }

    const previous = state.get(link.writer);
    if (previous !== undefined) {
      if (link.seq !== previous.seq + 1) {
        note({ reason: 'sequence-gap', where: entry.id, writer: link.writer, seq: link.seq });
      } else if (link.prev !== previous.hash) {
        note({ reason: 'link', where: entry.id, writer: link.writer, seq: link.seq });
      }
    }

    state.set(link.writer, { seq: link.seq, hash: link.hash });
  }

  for (const line of options.unparsable ?? []) {
    note({ reason: 'unparsable', where: line.where, writer: '', seq: 0 });
  }

  const unreadable = options.unreadable === true;
  return {
    ok: !unreadable && failures === 0 && unchained === 0,
    entries: entries.length,
    chained,
    unchained,
    writers: state.size,
    failures,
    firstFailure: reported[0] ?? null,
    tornTail: options.tornTail === true,
    unreadable,
    reported,
  };
}

/** One line an operator can act on, or the absence of one when nothing failed. */
export function describeVerification(result: AuditTrailVerification): string {
  if (result.unreadable) return 'audit trail: unreadable — the data directory could not be listed';
  if (result.ok) {
    return `audit trail: ${result.entries} entries across ${result.writers} chain(s), every link holds`;
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
