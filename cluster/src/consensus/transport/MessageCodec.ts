/**
 * MessageCodec — TCP wire protocol for @maboke123/raft-core Raft messages.
 *
 * Wire format:
 *   [4 bytes: Big-Endian uint32 payload length][N bytes: JSON payload]
 *
 * Length=0 signals end-of-stream (caller should close the connection).
 *
 * Key facts verified against @maboke123/raft-core WASM:
 * - Messages are JSON-serializable with base64 entry data
 * - entry.data is a base64 string (WASM expects string, not Uint8Array)
 * - Field name is `entryType` (not `type`)
 * - u64 fields are strings (e.g. "1" not 1)
 *
 * ⚠️ Shard routing: This module handles per-message encoding only.
 * Shard routing across nodes is delegated to RaftGroupManager +
 * RaftTcpTransport + NodeTransport. Currently, RaftGroup routes
 * messages by @maboke123/raft-core peer ID (which maps 1:1 to node IDs).
 *
 * In the future, if a hashring-based shard placement is needed
 * (e.g., to support dynamic shard migration), the routing layer
 * should use consistent hashing (e.g., the `hashring` npm package)
 * instead of the current round-robin or simple modulo approach.
 * See ARCHITECTURE_V2.md §Routing for detail.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

// ─── Format version constants ───────────────────────────────────────────────

/** Wire format version byte: JSON payload (no version byte = same as JSON). */
const FORMAT_JSON = 0x00;
/** Wire format version byte: MsgPack payload. */
const FORMAT_MSGPACK = 0x01;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RaftMessage {
  msgType: number;
  from: string; // u64 as string
  to: string; // u64 as string
  term: string; // u64 as string
  logTerm?: string;
  index?: string;
  commit?: string;
  reject?: boolean;
  rejectHint?: string;
  entries?: RaftEntry[];
}

export interface RaftEntry {
  index: string;
  term: string;
  entryType: number;
  data: string | Buffer; // base64 string (JSON mode) or raw Buffer (MsgPack mode)
}

// Convenience type for streams that support 'data' / 'end' / 'error' events
type Readable = net.Socket | tls.TLSSocket | NodeJS.ReadableStream;

// ─── Binary-safe JSON ────────────────────────────────────────────────────────

/**
 * JSON cannot carry bytes, and `JSON.parse` does not put them back.
 *
 * `JSON.stringify(new Uint8Array([1, 2, 3]))` is `{"0":1,"1":2,"2":3}` — an
 * object with no `length`. A `Buffer` survives as `{"type":"Buffer","data":[…]}`
 * only because `toJSON()` formats it that way, and `JSON.parse` still hands the
 * reader a plain object: `data.length` is `undefined`.
 *
 * That difference is not cosmetic. `@maboke123/raft-core` installs a snapshot
 * chunk with
 *
 *     if (request.data.length > 0) { session.chunks.push(request.data); … }
 *
 * so a chunk whose `data` arrived as a plain object is silently dropped, the
 * assembled snapshot is `Buffer.alloc(0)`, and the application's `restore`
 * rejects it — once a second, forever, while the follower keeps serving the
 * state it had before. Measured on this codec: 5 bytes in, `undefined` length
 * out, and every InstallSnapshot over the TCP transport failed the same way.
 *
 * The replacer and reviver below make the JSON frame binary-safe in both
 * directions. The reviver accepts only the exact shape `Buffer#toJSON` produces
 * and only with byte-range integers in `data`, so a user payload that happens to
 * contain `{type: 'Buffer'}` is left alone.
 */
function encodeBinary(_key: string, value: unknown): unknown {
  // A Buffer already serialises correctly through `toJSON`. A plain view has no
  // `toJSON`, and returning a Buffer here would not help either: `JSON.stringify`
  // does not re-run `toJSON` on a replacer's result, so the view would still
  // become `{"0":7,"1":8}`. Emitting the shape the reviver expects is the only
  // thing that survives both directions.
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return { type: 'Buffer', data: Array.from(value) };
  }
  return value;
}

function decodeBinary(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const tagged = value as { type?: unknown; data?: unknown };
  if (tagged.type !== 'Buffer' || !Array.isArray(tagged.data)) return value;
  const bytes = tagged.data as unknown[];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) return value;
  }
  return Buffer.from(bytes as number[]);
}

// ─── Codec ───────────────────────────────────────────────────────────────────

export class MessageCodec {
  /** Maximum single-frame payload size (256 MiB). */
  static readonly MAX_PAYLOAD_SIZE = 256 * 1024 * 1024;

  // ── Format version byte constants ───────────────────────────────────────

  private static readonly FORMAT_JSON = FORMAT_JSON;
  private static readonly FORMAT_MSGPACK = FORMAT_MSGPACK;

  // ── Serialize ──────────────────────────────────────────────────────────────

  /**
   * Serialize a RaftMessage into a length-prefixed Buffer (JSON format).
   *
   * Wire format:
   *   [4 bytes: BE uint32 payload-length (including version byte)]
   *   [1 byte: format version (0x00 = JSON)]
   *   [N bytes: JSON payload]
   *
   * Binary fields survive the round trip: see {@link decodeBinary}.
   *
   * @param msg  The message to serialize.
   */
  static encode<T extends object = RaftMessage>(msg: T): Buffer {
    const json = JSON.stringify(msg, encodeBinary);
    const payload = Buffer.from(json, 'utf-8');
    const header = Buffer.alloc(5); // 4-byte length + 1-byte format
    header.writeUInt32BE(payload.length + 1, 0); // +1 for format byte
    header[4] = FORMAT_JSON;
    return Buffer.concat([header, payload]);
  }

  /**
   * Serialize a RaftMessage into a length-prefixed Buffer (MsgPack format).
   *
   * Wire format:
   *   [4 bytes: BE uint32 payload-length (including version byte)]
   *   [1 byte: format version (0x01 = MsgPack)]
   *   [N bytes: MsgPack payload]
   *
   * Data field in entries is serialized as binary (Buffer), not base64 string.
   *
   * @param msg  The message to serialize.
   */
  static encodeMsgPack(msg: RaftMessage): Buffer {
    const payload = Buffer.from(msgpackEncode(msg));
    const header = Buffer.alloc(5); // 4-byte length + 1-byte format
    header.writeUInt32BE(payload.length + 1, 0); // +1 for format byte
    header[4] = FORMAT_MSGPACK;
    return Buffer.concat([header, payload]);
  }

  // ── Deserialize ────────────────────────────────────────────────────────────

  /**
   * Deserialize a frame buffer (already stripped of the 4-byte length header)
   * back into a RaftMessage. Auto-detects the format version byte:
   *
   *   - buffer[0] === 0x00 → JSON payload at buffer[1..]
   *   - buffer[0] === 0x01 → MsgPack payload at buffer[1..]
   *   - otherwise           → old format (no version byte), entire buffer is JSON
   *
   * @param buffer  The raw frame bytes (without the 4-byte length header).
   */
  static decode<T = RaftMessage>(buffer: Buffer): T {
    if (buffer.length === 0) {
      throw new Error('Empty decode buffer');
    }

    let msg: unknown;
    if (buffer[0] === FORMAT_JSON) {
      // New JSON format: version byte + JSON payload
      const json = buffer.subarray(1).toString('utf-8');
      msg = JSON.parse(json, decodeBinary);
    } else if (buffer[0] === FORMAT_MSGPACK) {
      // MsgPack format: version byte + MsgPack payload
      msg = msgpackDecode(buffer.subarray(1));
      // Normalise binary data: MsgPack returns Uint8Array for binary fields
      MessageCodec.normaliseEntryData(msg);
    } else {
      // Old format (no version byte): entire buffer is JSON
      const json = buffer.toString('utf-8');
      msg = JSON.parse(json, decodeBinary);
    }

    MessageCodec.normaliseEntries(msg);
    return msg as T;
  }

  /**
   * Replace a non-array `entries` field with an empty array.
   *
   * Only applies to messages that *have* the field: `BatchedRaftTransport`
   * frames are `{requestId, msg}`, and inventing `entries: []` on them would
   * change the shape a caller receives.
   */
  private static normaliseEntries(msg: unknown): void {
    if (msg === null || typeof msg !== 'object' || !('entries' in msg)) return;
    const holder = msg as { entries: unknown };
    if (holder.entries !== null && !Array.isArray(holder.entries)) holder.entries = [];
  }

  /**
   * Deserialize a buffer as MsgPack-payload (assumes format 0x01).
   *
   * Accepts either:
   *   - [1 byte: 0x01][MsgPack payload]   (new format with version byte)
   *   - [MsgPack payload]                  (version byte omitted)
   *
   * @param buffer  The raw frame bytes (without the 4-byte length header).
   */
  static decodeMsgPack(buffer: Buffer): RaftMessage {
    let payload: Buffer;
    if (buffer[0] === FORMAT_MSGPACK) {
      payload = buffer.subarray(1);
    } else {
      payload = buffer; // assume raw MsgPack without version byte
    }

    const msg = msgpackDecode(payload) as RaftMessage;

    // Same rule as the JSON path, and for the same reason: this used to be a
    // second, subtly different copy (`undefined !== null` made an absent field
    // become `entries: []`), so the two decoders disagreed about the shape a
    // caller receives.
    MessageCodec.normaliseEntries(msg);
    MessageCodec.normaliseEntryData(msg);
    return msg;
  }

  /**
   * Normalise entry data after MsgPack decoding.
   *
   * MsgPack serializes binary fields as Uint8Array.  Convert back to
   * Buffer so the roundtrip (encode → decode) preserves the original
   * Buffer type.  Call normaliseForWasm() separately before passing
   * messages to @maboke123/raft-core WASM, which converts Buffer → base64.
   */
  private static normaliseEntryData(msg: unknown): void {
    const entries = (msg as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    for (const entry of entries as RaftEntry[]) {
      if (entry.data instanceof Uint8Array) {
        entry.data = Buffer.from(entry.data);
      }
    }
  }

  /**
   * Ensure a RaftMessage is safe for @maboke123/raft-core WASM step().
   *
   * Handles fields that may arrive as raw Buffer/Uint8Array from
   * TCP deserialization (MsgPack or incompatible source) but must
   * be passed as strings to the WASM library.
   *
   * Call this before passing any message to raft.step().
   */
  static normaliseForWasm(msg: any): any {
    if (!msg || typeof msg !== 'object') return msg;

    // u64 fields must be strings
    if (typeof msg.from === 'number') msg.from = String(msg.from);
    if (typeof msg.to === 'number') msg.to = String(msg.to);
    if (typeof msg.term === 'number') msg.term = String(msg.term);
    if (msg.logTerm !== null && typeof msg.logTerm === 'number') msg.logTerm = String(msg.logTerm);
    if (msg.index !== null && typeof msg.index === 'number') msg.index = String(msg.index);
    if (msg.commit !== null && typeof msg.commit === 'number') msg.commit = String(msg.commit);

    // entry.data must be base64 string, not byte array
    if (msg.entries) {
      for (let i = 0; i < msg.entries.length; i++) {
        const entry = msg.entries[i];
        if (entry.data instanceof Uint8Array) {
          entry.data = Buffer.from(entry.data).toString('base64');
        }
        // u64 fields in entries
        if (typeof entry.index === 'number') entry.index = String(entry.index);
        if (typeof entry.term === 'number') entry.term = String(entry.term);
      }
    }

    // snapshot data must be base64 string
    if (msg.snapshot?.data instanceof Uint8Array) {
      msg.snapshot.data = Buffer.from(msg.snapshot.data).toString('base64');
    }

    return msg;
  }

  // ── Frame reading ──────────────────────────────────────────────────────────

  /**
   * Read one complete length-prefixed frame from a stream.
   *
   * Returns `null` when the peer sends an empty frame (length=0), which signals
   * end-of-stream.  Throws on connection errors or invalid payload sizes.
   *
   * @param socket  The readable stream (TCP/TLS/Pipe).
   * @param signal  Optional AbortSignal to cancel the read.
   */
  static async readFrame(socket: Readable, signal?: AbortSignal): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve, reject) => {
      // ── State ──────────────────────────────────────────────────────────
      const state = { header: true, length: 0, received: 0, chunks: [] as Buffer[] };
      let aborted = false;
      let cleanup: (() => void) | null = null;

      // ── Abort handling ────────────────────────────────────────────────
      const onAbort = () => {
        aborted = true;
        cleanup?.();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        return reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      // ── Stream handlers ───────────────────────────────────────────────
      const onData = (chunk: Buffer) => {
        // c8 ignore next — abort removes this listener synchronously after setting
        // the flag, so no data chunk can observe `aborted === true`.
        /* c8 ignore next */
        if (aborted) return;

        let offset = 0;

        while (offset < chunk.length) {
          if (state.header) {
            // Still reading the 4-byte length prefix
            const needed = 4 - state.received;
            const take = Math.min(needed, chunk.length - offset);
            state.chunks.push(chunk.subarray(offset, offset + take));
            state.received += take;
            offset += take;

            if (state.received === 4) {
              // Assemble the header
              const headerBuf = Buffer.concat(state.chunks, 4);
              state.length = headerBuf.readUInt32BE(0);
              state.chunks = [];
              state.received = 0;
              state.header = false;

              // Empty frame → end-of-stream signal
              if (state.length === 0) {
                cleanup?.();
                resolve(null);
                return;
              }

              // Sanity check
              if (state.length < 0 || state.length > MessageCodec.MAX_PAYLOAD_SIZE) {
                cleanup?.();
                reject(
                  new Error(`Invalid payload length: ${state.length} ` + `(max ${MessageCodec.MAX_PAYLOAD_SIZE})`),
                );
                return;
              }
            }
          } else {
            // Reading payload
            const needed = state.length - state.received;
            const take = Math.min(needed, chunk.length - offset);
            if (take > 0) {
              state.chunks.push(chunk.subarray(offset, offset + take));
              state.received += take;
              offset += take;
            }

            // Complete frame received
            if (state.received === state.length) {
              const frame = Buffer.concat(state.chunks, state.length);
              cleanup?.();
              resolve(frame);
              return;
            }
          }
        }
      };

      const onEnd = () => {
        cleanup?.();
        if (state.received > 0) {
          reject(new Error('Connection closed mid-frame'));
        } else {
          resolve(null); // clean EOF with no partial frame
        }
      };

      const onError = (err: Error) => {
        cleanup?.();
        reject(err);
      };

      // Register listeners
      const emitter = socket as unknown as EventEmitter;
      emitter.on('data', onData);
      emitter.on('end', onEnd);
      emitter.on('error', onError);

      cleanup = () => {
        emitter.off('data', onData);
        emitter.off('end', onEnd);
        emitter.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
    });
  }
}
