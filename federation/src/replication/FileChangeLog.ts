/**
 * FileChangeLog — a real, durable, append-only change log on disk.
 *
 * This is the reference implementation of `IChangeLogReader` and the writer
 * that fills it. It exists because the CDC path used to begin at
 * `CDCEngine.appendChange()`, a method whose own comment said "test-only: in
 * production this would be triggered by WAL decoding" — so every claim about
 * ordered delivery, resumption and exactly-once started at a call no deployment
 * makes. The log below is written by one process, from bytes on a disk, with
 * `fsync` between the append and the acknowledgement; the reader tails the same
 * bytes from another process.
 *
 * Format: one JSON object per line, UTF-8, `\n`-terminated.
 *
 *   {"lsn":"0/00000001","table":"orders","operation":"insert",
 *    "oldValues":null,"newValues":{"id":1},"txId":"…","committedAt":1699…}
 *
 * Three properties are the whole point, and each has a test that fails without
 * it:
 *
 *   1. **A durable record is visible; nothing else is.** `append()` resolves
 *      only after `fsync`. The reader ignores a trailing line that has no
 *      newline yet: that is a write in progress, and a record the writer never
 *      acknowledged must not be delivered as if it had committed.
 *   2. **Positions are assigned by the writer, not derived by the reader.** A
 *      consumer checkpoints an LSN, and a restarted reader resumes after it. If
 *      the position were derived from the reader's own count of records, two
 *      readers that started at different times would disagree about what
 *      `0/00000007` means.
 *   3. **The log only grows.** A file that shrank is a rotated or truncated
 *      file, and continuing to read it would silently skip everything the new
 *      file holds. That is refused, by name.
 *
 * Scope, stated plainly: the low word is eight hexadecimal digits, so the log
 * holds 2^32-1 records. Beyond that `formatLsn` would return a ninth digit and
 * the string comparison used by `ExactlyOnceCDCPipeline.advanceCheckpoint`
 * would stop agreeing with the numeric one — so the writer refuses at the
 * boundary instead of writing an LSN the consumer cannot order.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChangeLogRecord, IChangeLogReader } from '../interfaces/replication/IChangeLogReader';
import { compareLsn, formatLsn, parseLsn } from '../interfaces/replication/IChangeLogReader';

const OPERATIONS = new Set(['insert', 'update', 'delete']);
const MAX_SEQUENCE = 0xffffffff;

/** A log that cannot be read as a log. Never thrown for a transient I/O error. */
export class ChangeLogCorruptError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'ChangeLogCorruptError';
  }
}

export interface FileChangeLogOptions {
  /** Directory holding the log file; created when missing */
  dir: string;
  /** File name inside `dir`. Default: `changelog.jsonl` */
  fileName?: string;
  /**
   * Call `fsync` after every append before acknowledging it. Default: true.
   *
   * Turning it off is a deliberate durability trade: the record becomes
   * visible to the reader immediately and may be lost in a crash. It exists
   * for benchmarks that measure the cost of durability, not for deployments.
   */
  fsync?: boolean;
}

export interface AppendChangeInput {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  txId: string;
  /** Writer's commit time in epoch milliseconds. Default: `Date.now()` */
  committedAt?: number;
}

function logPath(options: FileChangeLogOptions): string {
  return join(resolve(options.dir), options.fileName ?? 'changelog.jsonl');
}

// ── Writer ─────────────────────────────────────────────────

export class FileChangeLogWriter {
  private sequence: number;
  /** Serialised appends: two concurrent appends must not interleave bytes. */
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    private readonly fsyncEveryAppend: boolean,
    sequence: number,
  ) {
    this.sequence = sequence;
  }

  static async open(options: FileChangeLogOptions): Promise<FileChangeLogWriter> {
    mkdirSync(resolve(options.dir), { recursive: true });
    const path = logPath(options);
    const handle = await open(path, 'a+');
    try {
      let existing = await handle.readFile({ encoding: 'utf8' });

      // A file whose last line has no newline holds a record that was being
      // written when the previous process died — and `append()` only
      // acknowledged records it had fsynced, so that record was never promised
      // to anyone. Appending after it would glue two records into one
      // unparseable line, so the writer truncates it here and says so.
      if (existing.length > 0 && !existing.endsWith('\n')) {
        const boundary = existing.lastIndexOf('\n') + 1;
        await handle.truncate(boundary);
        existing = existing.slice(0, boundary);
      }

      const sequence = lastSequence(existing, path);
      return new FileChangeLogWriter(handle, path, options.fsync ?? true, sequence);
    } catch (error) {
      // The handle is open and this constructor will not return it: a log that
      // cannot be resumed must not also leak a descriptor on the way out.
      await handle.close();
      throw error;
    }
  }

  /** Position of the last record written, or null when the log is empty. */
  get lastLsn(): string | null {
    return this.sequence === 0 ? null : formatLsn(this.sequence);
  }

  /** Number of records this writer has put in the log, across restarts. */
  get length(): number {
    return this.sequence;
  }

  /**
   * Append one record and resolve with its position, after it is durable.
   *
   * The returned LSN is the resume point a consumer stores. It is returned
   * *after* `fsync`, never before: a caller that acknowledges a write to its
   * own client and then hands out a position that is not on disk has promised
   * two different things about the same record.
   */
  async append(input: AppendChangeInput): Promise<string> {
    if (this.closed) throw new Error(`${this.path}: append after close`);
    if (!OPERATIONS.has(input.operation)) {
      throw new Error(`operation "${String(input.operation)}" is not insert|update|delete`);
    }
    if (typeof input.table !== 'string' || input.table.length === 0) {
      throw new Error('table must be a non-empty string');
    }
    if (typeof input.txId !== 'string' || input.txId.length === 0) {
      throw new Error('txId must be a non-empty string');
    }
    const lsn = nextLsn(this.sequence, this.path);
    this.sequence += 1;
    const record = {
      lsn,
      table: input.table,
      operation: input.operation,
      oldValues: input.oldValues ?? null,
      newValues: input.newValues ?? null,
      txId: input.txId,
      committedAt: input.committedAt ?? Date.now(),
    };
    const line = `${JSON.stringify(record)}\n`;

    const write = this.tail.then(async () => {
      await this.handle.write(line, null, 'utf8');
      if (this.fsyncEveryAppend) await this.handle.sync();
      return lsn;
    });
    // Keep the chain alive after a failed append: a rejected promise in `tail`
    // would make every later append reject with the *first* error.
    this.tail = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.handle.close();
  }
}

/**
 * The position the next record will take, refusing to leave the eight-digit
 * width the consumers of this log compare in.
 *
 * Kept as a function rather than a branch inside `append` so the boundary has a
 * test: reaching it needs a log of 4 294 967 295 records, which no suite can
 * write, and an untested guard is a guard nobody knows still fires.
 */
export function nextLsn(sequence: number, path = 'changelog'): string {
  if (sequence >= MAX_SEQUENCE) {
    throw new Error(
      `${path}: the low word of an LSN is eight hexadecimal digits; this log ` +
        `reached ${formatLsn(sequence)} and cannot grow without changing the ` +
        `order its consumers compare`,
    );
  }
  return formatLsn(sequence + 1);
}

/**
 * Highest LSN already in the file.
 *
 * Only newline-terminated lines are considered: the caller has already
 * truncated any torn tail, and a record that was still being written was never
 * acknowledged — reusing its position would hand the same LSN to two different
 * records, and a consumer resuming from it would skip the second.
 */
function lastSequence(content: string, path: string): number {
  const lines = content.split('\n');
  // The final element is the text after the last newline: empty for a healthy
  // file, and never a record.
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as Partial<ChangeLogRecord>;
    const lsn = parsed.lsn;
    if (typeof lsn !== 'string') {
      throw new ChangeLogCorruptError(`${path}: record ${i + 1} has no lsn`, 0);
    }
    return Number(parseLsn(lsn).low);
  }
  return 0;
}

// ── Reader ─────────────────────────────────────────────────

interface LineIndex {
  lsn: string;
  /** Byte offset of the first character of the line */
  offset: number;
}

export class FileChangeLogReader implements IChangeLogReader {
  private index: LineIndex[] = [];
  /** Bytes already folded into `index` */
  private scanned = 0;
  /** Start offset of the incomplete tail held in `pending` */
  private fragmentStart = 0;
  private pending: Buffer = Buffer.alloc(0);
  private closed = false;
  private refreshes = 0;

  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
  ) {}

  static async open(options: FileChangeLogOptions): Promise<FileChangeLogReader> {
    mkdirSync(resolve(options.dir), { recursive: true });
    const path = logPath(options);
    const handle = await open(path, 'a+');
    return new FileChangeLogReader(handle, path);
  }

  /** Number of complete records the reader has indexed. */
  get indexed(): number {
    return this.index.length;
  }

  /** How many times the reader has looked for new bytes. */
  get refreshCount(): number {
    return this.refreshes;
  }

  async head(): Promise<string | null> {
    await this.refresh();
    const last = this.index[this.index.length - 1];
    return last ? last.lsn : null;
  }

  async readAfter(afterLsn: string | null, limit: number): Promise<ChangeLogRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`readAfter needs a positive integer limit, got ${String(limit)}`);
    }
    await this.refresh();

    const from = afterLsn === null ? 0 : firstAfter(this.index, afterLsn);
    const out: ChangeLogRecord[] = [];
    for (let i = from; i < this.index.length && out.length < limit; i++) {
      const entry = this.index[i]!;
      out.push(await this.readLine(entry));
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  /**
   * Fold any bytes appended since the last call into the index.
   *
   * Reads the delta as bytes and splits on `\n`, so a multi-byte character
   * split across two refreshes is reconstructed rather than mangled, and an
   * unterminated line stays pending until the writer finishes it.
   */
  private async refresh(): Promise<void> {
    if (this.closed) throw new Error(`${this.path}: read after close`);
    this.refreshes += 1;

    const { size } = await this.handle.stat();
    if (size < this.scanned) {
      throw new ChangeLogCorruptError(
        `${this.path}: the log shrank from ${this.scanned} to ${size} bytes — ` +
          `a truncated file cannot be tailed, only re-read from the beginning`,
        this.scanned,
      );
    }
    if (size === this.scanned) return;

    const delta = Buffer.alloc(size - this.scanned);
    let read = 0;
    while (read < delta.length) {
      const { bytesRead } = await this.handle.read(delta, read, delta.length - read, this.scanned + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    this.scanned += read;

    const buffer = Buffer.concat([this.pending, delta.subarray(0, read)]);
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0x0a) continue;
      this.accept(buffer.subarray(start, i), this.fragmentStart + start);
      start = i + 1;
    }
    this.fragmentStart += start;
    // `Buffer.from` copies: without it the retained fragment keeps the whole
    // delta alive, and a long-running tail would hold every byte it ever read.
    this.pending = Buffer.from(buffer.subarray(start));
  }

  private accept(line: Buffer, offset: number): void {
    if (line.length === 0) return;
    let parsed: ChangeLogRecord;
    try {
      parsed = JSON.parse(line.toString('utf8')) as ChangeLogRecord;
    } catch (error) {
      throw new ChangeLogCorruptError(`${this.path}: record at byte ${offset} is not JSON: ${String(error)}`, offset);
    }
    if (typeof parsed.lsn !== 'string') {
      throw new ChangeLogCorruptError(`${this.path}: record at byte ${offset} has no lsn`, offset);
    }
    if (!OPERATIONS.has(parsed.operation)) {
      throw new ChangeLogCorruptError(
        `${this.path}: record at byte ${offset} has operation "${String(parsed.operation)}"`,
        offset,
      );
    }
    const previous = this.index[this.index.length - 1];
    if (previous && compareLsn(previous.lsn, parsed.lsn) >= 0) {
      throw new ChangeLogCorruptError(
        `${this.path}: record at byte ${offset} has lsn ${parsed.lsn} after ${previous.lsn}`,
        offset,
      );
    }
    this.index.push({ lsn: parsed.lsn, offset });
  }

  /** Read one record from its byte offset. The bytes come from the file. */
  private async readLine(entry: LineIndex): Promise<ChangeLogRecord> {
    const chunks: Buffer[] = [];
    let position = entry.offset;
    for (;;) {
      const chunk = Buffer.alloc(1024);
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChangeLogRecord;
  }
}

/** First index whose LSN is strictly greater than `afterLsn`. */
function firstAfter(index: LineIndex[], afterLsn: string): number {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareLsn(index[mid]!.lsn, afterLsn) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Open a writer and a reader over the same log. */
export async function openFileChangeLog(
  options: FileChangeLogOptions,
): Promise<{ writer: FileChangeLogWriter; reader: FileChangeLogReader }> {
  return {
    writer: await FileChangeLogWriter.open(options),
    reader: await FileChangeLogReader.open(options),
  };
}
