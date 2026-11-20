/**
 * HttpCDCSink — a sink that delivers over a real socket.
 *
 * The package shipped one sink (`InMemoryCDCSink`) and one wrapper
 * (`CDCSinkResolver`). Both are honest about being in-process, which meant the
 * delivery half of CDC — batching, HTTP status handling, timeouts, keep-alive,
 * and the difference between "refused" and "delivered" — had never been through
 * a socket in any test or any deployment.
 *
 * Contract, stated so that it can be checked:
 *
 *   - `emit()` resolves only on a 2xx response. Any other status throws
 *     `HttpSinkRefusedError` carrying the status and a bounded body excerpt;
 *     `CDCSinkResolver` and `CDCSubscriptionPump` retry on a throw and record a
 *     failure once the budget is spent.
 *   - A request that does not complete inside `timeoutMs` is destroyed and
 *     reported as a refusal. It is *not* reported as a delivery, because a
 *     server that eventually commits a batch the client gave up on and a server
 *     that never saw it are different states, and only the receiver can tell
 *     them apart — which is why delivery is at-least-once and the receiver
 *     deduplicates by event id.
 *   - `connect()` prepares the agent and, when `probe` is enabled, establishes
 *     that something is listening. A `connect()` that touches nothing would let
 *     a subscription open against a URL that cannot answer, and the pump would
 *     report it as healthy until the first change arrived.
 */

import http from 'node:http';
import https from 'node:https';
import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

export interface HttpCDCSinkConfig {
  /** Absolute URL of the receiver, e.g. `https://ingest.internal/cdc` */
  url: string;
  /** Name reported by `ICDCSink.name`. Default: the URL's host and path */
  name?: string;
  /** Extra headers, e.g. an authorization token from the environment */
  headers?: Record<string, string>;
  /** Request timeout. Default: 5 000 ms */
  timeoutMs?: number;
  /** Reuse the TCP connection across batches. Default: true */
  keepAlive?: boolean;
  /**
   * Reachability check performed by `connect()`. Default: `false`.
   *
   * When enabled, `connect()` issues `method` (default `GET`) and treats *any*
   * HTTP response — including 404 — as proof that the endpoint is there. Only
   * a transport error or a timeout fails the connect, because a receiver that
   * answers 405 to a GET is a receiver.
   */
  probe?: false | { method?: string; timeoutMs?: number };
  /** Bytes of an error body kept for the message. Default: 512 */
  maxErrorBodyBytes?: number;
}

export interface HttpCDCSinkStats {
  /** HTTP requests issued, including failed ones */
  requests: number;
  /** Batches the receiver accepted (2xx) */
  batches: number;
  /** Events inside those batches */
  events: number;
  /** Batches that ended in a non-2xx status, a transport error or a timeout */
  refusals: number;
  /** Status of the last response, null when the last attempt never got one */
  lastStatus: number | null;
}

/** A batch the receiver did not accept. Retryable by contract. */
export class HttpSinkRefusedError extends Error {
  constructor(
    message: string,
    readonly detail: {
      status?: number;
      body?: string;
      timedOut?: boolean;
      cause?: string;
    },
  ) {
    super(message);
    this.name = 'HttpSinkRefusedError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ERROR_BODY = 512;

export class HttpCDCSink implements ICDCSink {
  readonly name: string;

  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly keepAlive: boolean;
  private readonly probeConfig: false | { method: string; timeoutMs: number };
  private readonly maxErrorBodyBytes: number;

  private agent: http.Agent | https.Agent | null = null;
  private connected = false;
  private stats: HttpCDCSinkStats = {
    requests: 0,
    batches: 0,
    events: 0,
    refusals: 0,
    lastStatus: null,
  };

  constructor(config: HttpCDCSinkConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error(`HttpCDCSink: "${config.url}" is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`HttpCDCSink: "${config.url}" is not http or https`);
    }
    this.url = url;
    this.name = config.name ?? `${url.host}${url.pathname}`;
    this.headers = { 'content-type': 'application/json', ...config.headers };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.keepAlive = config.keepAlive ?? true;
    this.probeConfig =
      config.probe === undefined || config.probe === false
        ? false
        : { method: config.probe.method ?? 'GET', timeoutMs: config.probe.timeoutMs ?? this.timeoutMs };
    this.maxErrorBodyBytes = config.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY;
  }

  getStats(): HttpCDCSinkStats {
    return { ...this.stats };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.agent = this.makeAgent();
    if (this.probeConfig) {
      await this.probe(this.probeConfig.method, this.probeConfig.timeoutMs);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const agent = this.agent;
    this.agent = null;
    // `destroy()` closes pooled sockets; without it a keep-alive connection
    // outlives the sink and the process that owns it cannot exit.
    agent?.destroy();
  }

  async emit(events: CDCSinkEvent[]): Promise<void> {
    if (!this.connected) throw new Error(`${this.name}: cannot emit when disconnected`);
    if (events.length === 0) return;

    // `CDCSinkEvent.timestamp` is a `bigint`, and `JSON.stringify` throws on
    // bigint rather than coercing it — the batch would fail to serialise and
    // every change would be reported as a delivery failure.
    const body = JSON.stringify({ events }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

    this.stats.requests += 1;
    let response: { status: number; body: string };
    try {
      response = await this.request('POST', body);
    } catch (error) {
      // A refusal that never produced a status — a timeout, a reset, a name
      // that does not resolve — is still a refused batch, and it used to be
      // the only kind of refusal this counter did not count.
      this.stats.refusals += 1;
      this.stats.lastStatus = null;
      throw error;
    }

    if (response.status >= 200 && response.status < 300) {
      this.stats.batches += 1;
      this.stats.events += events.length;
      this.stats.lastStatus = response.status;
      return;
    }

    this.stats.refusals += 1;
    this.stats.lastStatus = response.status;
    throw new HttpSinkRefusedError(
      `${this.name}: receiver answered ${response.status} for a batch of ${events.length}`,
      { status: response.status, body: response.body },
    );
  }

  // ── Internal ─────────────────────────────────────────────

  private makeAgent(): http.Agent | https.Agent {
    const options = this.keepAlive ? { keepAlive: true, maxSockets: 8 } : {};
    return this.url.protocol === 'https:' ? new https.Agent({ ...options }) : new http.Agent({ ...options });
  }

  private async probe(method: string, timeoutMs: number): Promise<void> {
    // Any HTTP status is proof of life: the point is that the socket connected
    // and something answered, not that a GET is a supported verb.
    await this.request(method, null, timeoutMs, true);
  }

  private request(
    method: string,
    body: string | null,
    timeoutMs = this.timeoutMs,
    acceptAnyStatus = false,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const transport = this.url.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // `connected` is set only after the agent exists and cleared before it is
      // released, so an `emit()` or a probe always has one. The cast says that
      // rather than inventing a fallback branch nobody can reach: an agent
      // constructed here would be a second pool, disposed of nowhere.
      const agent = this.agent as http.Agent | https.Agent;
      const req = transport.request(
        this.url,
        {
          method,
          agent,
          headers: {
            ...this.headers,
            ...(body === null ? {} : { 'content-length': Buffer.byteLength(body) }),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const accepted = status >= 200 && status < 300;
          // A successful response has nothing to say, and an error page of
          // 40 MB must not be buffered to report a 500 — the excerpt is
          // capped at `maxErrorBodyBytes` and the rest is drained.
          if (accepted || acceptAnyStatus) {
            res.resume();
            res.on('end', () => finish(() => resolve({ status, body: '' })));
            res.on('error', (error) => {
              finish(() =>
                reject(
                  new HttpSinkRefusedError(`${this.name}: response failed: ${error.message}`, {
                    status,
                    cause: error.message,
                  }),
                ),
              );
            });
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            // Keep the first `maxErrorBodyBytes` bytes exactly. Pushing whole
            // chunks and filtering after the fact kept nothing at all when the
            // first chunk already exceeded the cap — an error page of 50 kB
            // produced an empty excerpt, so the message said 500 and nothing
            // about why.
            if (size >= this.maxErrorBodyBytes) return;
            const room = this.maxErrorBodyBytes - size;
            chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
            size += chunk.length;
          });
          res.on('end', () => {
            finish(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
          });
          res.on('error', (error) => {
            finish(() =>
              reject(
                new HttpSinkRefusedError(`${this.name}: response failed: ${error.message}`, {
                  status,
                  cause: error.message,
                }),
              ),
            );
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(() =>
          reject(new HttpSinkRefusedError(`${this.name}: no response within ${timeoutMs} ms`, { timedOut: true })),
        );
      });

      req.on('error', (error) => {
        finish(() => reject(new HttpSinkRefusedError(`${this.name}: ${error.message}`, { cause: error.message })));
      });

      if (body !== null) req.write(body);
      req.end();
    });
  }
}
