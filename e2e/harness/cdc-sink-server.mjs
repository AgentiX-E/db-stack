/**
 * CDC sink server — a real HTTP receiver, in its own process.
 *
 * It records every batch it *accepted* to a file, and answers `failFirst`
 * requests with a 503 so that a retry can be observed from the receiving side:
 * the pump's retry is only meaningful if the second attempt is what the sink
 * stores, once.
 *
 * IPC contract
 * ------------
 *   parent → server : { cmd: 'status' } | { cmd: 'stop' }
 *   server → parent : { type: 'ready', data: { port } } | { type: 'status', data } | { type: 'error', data }
 */

import http from 'node:http';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const RAW = process.env.CDC_SINK_CONFIG;
if (!RAW) {
  process.stderr.write('[sink] CDC_SINK_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);

function send(message) {
  if (process.send) process.send(message);
}

let requests = 0;
let accepted = 0;
let rejected = 0;
let events = 0;
let fd = null;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'GET') {
      // The reachability probe: answering at all is the point.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    requests += 1;
    if (requests <= (cfg.failFirst ?? 0)) {
      rejected += 1;
      res.writeHead(503, { 'content-type': 'text/plain' }).end('the queue is full');
      return;
    }

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      rejected += 1;
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`bad json: ${err.message}`);
      return;
    }
    const batch = Array.isArray(body?.events) ? body.events : [];
    for (const event of batch) {
      appendFileSync(fd, `${JSON.stringify(event)}\n`);
    }
    fsyncSync(fd);
    accepted += 1;
    events += batch.length;
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: batch.length }));
  });
});

mkdirSync(dirname(cfg.receivedFile), { recursive: true });
fd = openSync(cfg.receivedFile, 'a');

server.listen(cfg.port, '127.0.0.1', () => {
  send({ type: 'ready', data: { port: server.address().port } });
});

process.on('message', (msg) => {
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'status') {
    send({ type: 'status', data: { requests, accepted, rejected, events, receivedFile: cfg.receivedFile } });
  } else if (msg.cmd === 'stop') {
    server.close(() => {
      if (fd !== null) closeSync(fd);
      send({ type: 'stopped' });
      setTimeout(() => process.exit(0), 20);
    });
  }
});

process.on('SIGTERM', () => process.exit(0));
