/**
 * HttpCDCSink — delivery that ends at a socket.
 *
 * Every case below runs a real `node:http` server on a loopback port and a real
 * client connection to it. Nothing here counts `emit()` calls: the assertions
 * are on what the receiver got, what status it answered, and how long the
 * client waited.
 *
 *   AC 95.1  a batch arrives at the server as JSON, bigint timestamps included
 *   AC 95.2  a non-2xx status is a refusal, with the status and a body excerpt
 *   AC 95.3  an oversized error body is truncated in the message
 *   AC 95.4  a server that never answers trips the timeout, named as one
 *   AC 95.5  keep-alive reuses one connection across batches
 *   AC 95.6  a probe accepts a 404 as proof of life; a closed port is refused
 *   AC 95.7  emit before connect, and after disconnect, are refusals
 *   AC 95.8  getStats() counts what happened
 *   AC 95.9  a URL that is not http(s) is refused at construction
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpCDCSink, HttpSinkRefusedError } from './HttpCDCSink';
import type { HttpCDCSinkConfig } from './HttpCDCSink';
import type { CDCSinkEvent } from '../interfaces/replication/ICDCSink';

interface Received {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];
const sinks: HttpCDCSink[] = [];

afterEach(async () => {
  while (sinks.length > 0) await sinks.pop()!.disconnect();
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listen(handler: http.RequestListener): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/cdc`, server });
    });
  });
}

function makeSink(url: string, config: Partial<HttpCDCSinkConfig> = {}): HttpCDCSink {
  const sink = new HttpCDCSink({ url, ...config });
  sinks.push(sink);
  return sink;
}

const event = (id: number): CDCSinkEvent => ({
  id: `0/0000000${id}:tx-${id}`,
  type: 'insert',
  table: 'orders',
  key: String(id),
  data: { id },
  timestamp: 1_700_000_000_000n + BigInt(id),
});

describe('HttpCDCSink', () => {
  it('AC 95.1: a batch arrives at the server as JSON, bigint timestamps included', async () => {
    const received: Received[] = [];
    const { url } = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers,
        });
        res.writeHead(204).end();
      });
    });

    const sink = makeSink(url);
    await sink.connect();
    await sink.emit([event(1), event(2)]);

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('POST');
    expect(received[0]!.url).toBe('/cdc');
    expect(received[0]!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(received[0]!.body) as { events: { timestamp: string }[] };
    expect(body.events).toHaveLength(2);
    // `JSON.stringify` throws on a bigint; a batch that failed to serialise
    // would be reported as a delivery failure for every change.
    expect(body.events[0]!.timestamp).toBe('1700000000001');
  });

  it('AC 95.2: a non-2xx status is a refusal, with the status and a body excerpt', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('the queue is full');
    });

    const sink = makeSink(url);
    await sink.connect();
    const failure = await sink.emit([event(1)]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpSinkRefusedError);
    expect((failure as HttpSinkRefusedError).detail.status).toBe(503);
    expect((failure as HttpSinkRefusedError).detail.body).toBe('the queue is full');
    expect(sink.getStats()).toMatchObject({ refusals: 1, batches: 0, lastStatus: 503 });
  });

  it('AC 95.3: an oversized error body is truncated in the message', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('x'.repeat(50_000));
    });

    const sink = makeSink(url, { maxErrorBodyBytes: 16 });
    await sink.connect();
    const failure = (await sink.emit([event(1)]).catch((error: unknown) => error)) as HttpSinkRefusedError;

    expect(failure.detail.status).toBe(500);
    expect(failure.detail.body).toBe('x'.repeat(16));
  });

  it('AC 95.4: a server that never answers trips the timeout, named as one', async () => {
    const { url, server } = await listen(() => {
      // Deliberately never responds.
    });
    // The socket has to stay open for the timeout to be the thing that fires.
    server.setTimeout(0);

    const sink = makeSink(url, { timeoutMs: 60 });
    await sink.connect();
    const started = Date.now();
    const failure = (await sink.emit([event(1)]).catch((error: unknown) => error)) as HttpSinkRefusedError;

    expect(failure).toBeInstanceOf(HttpSinkRefusedError);
    expect(failure.detail.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sink.getStats().refusals).toBe(1);
  });

  it('AC 95.5: keep-alive reuses one connection across batches', async () => {
    let connections = 0;
    const { url, server } = await listen((_req, res) => {
      res.writeHead(200).end('ok');
    });
    server.on('connection', () => {
      connections += 1;
    });

    const sink = makeSink(url);
    await sink.connect();
    await sink.emit([event(1)]);
    await sink.emit([event(2)]);
    await sink.emit([event(3)]);

    expect(sink.getStats()).toMatchObject({ requests: 3, batches: 3, events: 3 });
    expect(connections).toBe(1);
  });

  it('AC 95.6: a probe accepts a 404 as proof of life, and a closed port is refused', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(404).end('no such endpoint');
    });
    const live = makeSink(url, { probe: { method: 'GET' } });
    await expect(live.connect()).resolves.toBeUndefined();

    // A port nothing listens on: connect() must fail rather than let the pump
    // report a healthy subscription whose every delivery will fail.
    const dead = makeSink('http://127.0.0.1:1/cdc', { probe: { method: 'GET' }, timeoutMs: 300 });
    await expect(dead.connect()).rejects.toThrow(HttpSinkRefusedError);
  });

  it('AC 95.7: emit before connect, and after disconnect, are refusals', async () => {
    const { url } = await listen((_req, res) => res.writeHead(200).end());
    const sink = makeSink(url);

    await expect(sink.emit([event(1)])).rejects.toThrow(/disconnected/);
    await sink.connect();
    await sink.emit([event(1)]);
    await sink.disconnect();
    await expect(sink.emit([event(1)])).rejects.toThrow(/disconnected/);
    // Disconnect is idempotent: the pump calls it once per subscription, and a
    // second call must not throw into a `finally` block.
    await expect(sink.disconnect()).resolves.toBeUndefined();
  });

  it('AC 95.8: getStats() counts what happened', async () => {
    let failures = 1;
    const { url } = await listen((_req, res) => {
      if (failures > 0) {
        failures -= 1;
        res.writeHead(429).end('slow down');
        return;
      }
      res.writeHead(200).end();
    });

    const sink = makeSink(url);
    await sink.connect();
    await expect(sink.emit([event(1)])).rejects.toThrow();
    await sink.emit([event(2), event(3)]);

    expect(sink.getStats()).toEqual({
      requests: 2,
      batches: 1,
      events: 2,
      refusals: 1,
      lastStatus: 200,
    });
    // A batch of nothing is not a request: it must not appear as a delivery.
    await sink.emit([]);
    expect(sink.getStats().requests).toBe(2);
  });

  it('AC 95.10: a connection dropped mid-response is a refusal, not a delivery', async () => {
    const { url } = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      // The receiver dies after committing to an answer but before finishing
      // it: the client must not read that as a delivered batch.
      setTimeout(() => req.destroy(), 10);
    });

    const sink = makeSink(url);
    await sink.connect();
    const failure = (await sink.emit([event(1)]).catch((error: unknown) => error)) as HttpSinkRefusedError;

    expect(failure).toBeInstanceOf(HttpSinkRefusedError);
    expect(failure.detail.cause).toBeDefined();
    expect(sink.getStats()).toMatchObject({ refusals: 1, batches: 0 });
  });

  it('AC 95.11: a refusal dropped mid-body is reported with the status it announced', async () => {
    const { url } = await listen((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.write('the first half of an explanation');
      setTimeout(() => req.destroy(), 10);
    });

    const sink = makeSink(url);
    await sink.connect();
    const failure = (await sink.emit([event(1)]).catch((error: unknown) => error)) as HttpSinkRefusedError;

    expect(failure).toBeInstanceOf(HttpSinkRefusedError);
    expect(failure.detail.status).toBe(500);
    expect(sink.getStats().refusals).toBe(1);
  });

  it('AC 95.12: connect() is idempotent, and a sink without keep-alive closes its socket', async () => {
    let connections = 0;
    const { url, server } = await listen((_req, res) => res.writeHead(200).end());
    server.on('connection', () => {
      connections += 1;
    });

    const sink = makeSink(url, { keepAlive: false });
    await sink.connect();
    await sink.connect();
    await sink.emit([event(1)]);
    await sink.emit([event(2)]);

    // Without keep-alive, each batch gets its own connection — and the point of
    // the case is that the option is honoured, not that it is faster.
    expect(connections).toBe(2);
    expect(sink.getStats()).toMatchObject({ batches: 2, events: 2 });
  });

  it('AC 95.13: an https sink prepares an https agent without touching the network', async () => {
    const sink = makeSink('https://ingest.example.test/cdc');
    await sink.connect();
    expect(sink.getStats().requests).toBe(0);
    await sink.disconnect();
  });

  it('AC 95.14: a caller-supplied name, headers and probe method reach the wire', async () => {
    const seen: { method: string; authorization?: string; contentType?: string }[] = [];
    const { url } = await listen((req, res) => {
      seen.push({
        method: req.method ?? '',
        authorization: req.headers.authorization as string | undefined,
        contentType: req.headers['content-type'] as string | undefined,
      });
      res.writeHead(204).end();
    });

    const sink = makeSink(url, {
      name: 'audit-webhook',
      headers: { authorization: 'Bearer from-the-environment' },
      probe: { method: 'HEAD', timeoutMs: 500 },
    });
    expect(sink.name).toBe('audit-webhook');
    await sink.connect();
    await sink.emit([event(1)]);

    expect(seen[0]).toMatchObject({ method: 'HEAD' });
    expect(seen[1]).toMatchObject({
      method: 'POST',
      authorization: 'Bearer from-the-environment',
      contentType: 'application/json',
    });
  });

  it('AC 95.15: the probe defaults are GET and the sink timeout, and probe can be off', async () => {
    const methods: string[] = [];
    const { url } = await listen((req, res) => {
      methods.push(req.method ?? '');
      res.writeHead(200).end();
    });

    // `probe: {}` means "check reachability, with the defaults": GET, and the
    // sink's own timeout.
    const defaulted = makeSink(url, { probe: {}, timeoutMs: 800 });
    await defaulted.connect();
    expect(methods).toEqual(['GET']);

    // `probe: false` means "do not touch the network on connect" — and the
    // difference is observable from the server.
    const quiet = makeSink(url, { probe: false });
    await quiet.connect();
    expect(methods).toEqual(['GET']);
    expect(quiet.getStats().requests).toBe(0);
  });

  it('AC 95.9: a URL that is not http(s) is refused at construction', () => {
    expect(() => new HttpCDCSink({ url: 'not a url' })).toThrow(/is not a URL/);
    expect(() => new HttpCDCSink({ url: 'ftp://example.test/cdc' })).toThrow(/not http or https/);
    // A name that says where the batch goes, defaulting to the host and path.
    expect(new HttpCDCSink({ url: 'https://ingest.example.test/cdc' }).name).toBe('ingest.example.test/cdc');
  });
});
