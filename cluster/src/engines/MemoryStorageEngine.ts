/**
 * MemoryStorageEngine — the reference implementation of {@link IStorageEngine}.
 *
 * It exists for three reasons: it is the smallest possible proof that the SPI is
 * implementable, it is the engine the conformance suites and the unit tests run
 * against, and it is the template an engine author reads first. It is *not* a
 * production engine: no durability, no concurrency beyond a single event loop.
 *
 * Command and query encoding (JSON, but any encoding works — the middleware
 * never looks inside the payload):
 *
 * ```json
 * {"op":"put","key":"a","value":"1"}   // apply
 * {"op":"del","key":"a"}               // apply
 * {"op":"get","key":"a"}               // query  -> {value|null}
 * {"op":"keys"}                        // query  -> {keys:[...]}
 * {"op":"size"}                        // query  -> {size:n}
 * {"op":"nop"}                         // apply  -> consumes the index, no state change
 * ```
 *
 * @module engines/MemoryStorageEngine
 */

import type { EngineApplyContext, IStorageEngine } from '../interfaces/IStorageEngine';

/** A decoded command or query. Unknown operations are rejected at the boundary. */
type Request =
  | { op: 'put'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'get'; key: string }
  | { op: 'keys' }
  | { op: 'size' }
  | { op: 'nop' };

interface SnapshotBody {
  /** Sorted `[key, value]` pairs: sorting is what makes the snapshot deterministic. */
  entries: Array<[string, string]>;
}

function decode(buffer: Buffer): Request {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    // An unparseable payload is a programming error in the caller's encoder, not
    // a transient condition: fail loudly instead of silently skipping a write.
    throw new Error('MemoryStorageEngine: payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('MemoryStorageEngine: payload must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const op = record['op'];
  if (typeof op !== 'string') {
    throw new Error('MemoryStorageEngine: payload is missing "op"');
  }
  switch (op) {
    case 'put':
      if (typeof record['key'] !== 'string' || typeof record['value'] !== 'string') {
        throw new Error('MemoryStorageEngine: "put" requires string key and value');
      }
      return { op, key: record['key'], value: record['value'] };
    case 'del':
    case 'get':
      if (typeof record['key'] !== 'string') {
        throw new Error(`MemoryStorageEngine: "${op}" requires a string key`);
      }
      return { op, key: record['key'] };
    case 'keys':
      return { op };
    case 'size':
      return { op };
    case 'nop':
      return { op };
    default:
      throw new Error(`MemoryStorageEngine: unknown op "${op}"`);
  }
}

export class MemoryStorageEngine implements IStorageEngine {
  readonly name = 'memory';

  private readonly store = new Map<string, string>();

  /** Every applied context, in order — used by tests to assert the call contract. */
  readonly appliedContexts: EngineApplyContext[] = [];

  async apply(context: EngineApplyContext, payload: Buffer): Promise<void> {
    const request = decode(payload);
    switch (request.op) {
      case 'put':
        this.store.set(request.key, request.value);
        break;
      case 'del':
        this.store.delete(request.key);
        break;
      case 'nop':
        // Consumes the index without touching state. An application needs this for
        // entries it replicates but does not interpret (a heartbeat payload, a
        // command meant for another subsystem): the applied index has to stay
        // contiguous, or every later apply would look like a gap.
        break;
      default:
        throw new Error(`MemoryStorageEngine: "${request.op}" is not a command`);
    }
    this.appliedContexts.push(context);
  }

  async query(request: Buffer): Promise<Buffer> {
    const parsed = decode(request);
    switch (parsed.op) {
      case 'get':
        return Buffer.from(JSON.stringify({ value: this.store.get(parsed.key) ?? null }), 'utf8');
      case 'keys':
        return Buffer.from(JSON.stringify({ keys: [...this.store.keys()].sort() }), 'utf8');
      case 'size':
        return Buffer.from(JSON.stringify({ size: this.liveBytes() }), 'utf8');
      default:
        throw new Error(`MemoryStorageEngine: "${parsed.op}" is not a query`);
    }
  }

  async snapshot(): Promise<Buffer> {
    const body: SnapshotBody = { entries: [...this.store.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  async restore(snapshot: Buffer): Promise<void> {
    let body: SnapshotBody;
    try {
      body = JSON.parse(snapshot.toString('utf8')) as SnapshotBody;
    } catch {
      throw new Error('MemoryStorageEngine: snapshot is not valid JSON');
    }
    if (body === null || typeof body !== 'object' || !Array.isArray(body.entries)) {
      throw new Error('MemoryStorageEngine: snapshot is missing "entries"');
    }
    // Build the replacement first, then swap: a malformed entry must not leave the
    // engine half-restored.
    const next = new Map<string, string>();
    for (const pair of body.entries) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        throw new Error('MemoryStorageEngine: snapshot entry must be [string, string]');
      }
      next.set(pair[0], pair[1]);
    }
    this.store.clear();
    for (const [key, value] of next) this.store.set(key, value);
  }

  async sizeInBytes(): Promise<number> {
    return this.liveBytes();
  }

  async close(): Promise<void> {
    this.store.clear();
    this.appliedContexts.length = 0;
  }

  /** UTF-8 length of all live keys and values; an explicit 0 when empty. */
  private liveBytes(): number {
    let total = 0;
    for (const [key, value] of this.store) total += Buffer.byteLength(key) + Buffer.byteLength(value);
    return total;
  }
}
