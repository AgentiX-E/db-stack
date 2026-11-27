/**
 * Fenced store — a real resource that refuses writes by its own record.
 *
 * This process is the resource layer from the F-22 acceptance case: a TLS 1.3
 * server with mutual certificate verification, a real file on disk, and the
 * published `FencingTokenGuard` deciding every write. It exists because the only
 * place a partitioned primary can be stopped is the thing it writes to. A flag
 * inside the cluster answers "what does this node believe?"; this file answers
 * "what has already been written?", and the second answer cannot be argued with.
 *
 * The highest token is recovered from the file at startup. A resource that
 * restarted with an empty memory would re-admit the old primary's writes during
 * exactly the window the token exists to cover, so the recovery is part of the
 * contract rather than a convenience.
 *
 * Wire format: newline-delimited JSON, one request and one reply per line.
 *   request  { id, token?: "term/index", key, value }
 *   reply    { id, admitted, reason?, detail?, highest }
 *
 * IPC contract
 * ------------
 *   parent → store : { cmd: 'state' } | { cmd: 'stop' }
 *   store → parent : { type: 'ready', data: { port } }
 *                    { type: 'state', data: { ... } }
 *                    { type: 'error', data: { message } }
 */

import tls from 'node:tls';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FencingTokenGuard, compareFencingTokens, formatFencingToken, parseFencingToken } from '@agentix-e/db-cluster';

const RAW = process.env.FENCED_STORE_CONFIG;
if (!RAW) {
  process.stderr.write('[fenced-store] FENCED_STORE_CONFIG missing\n');
  process.exit(2);
}
const cfg = JSON.parse(RAW);

function send(message) {
  process.send?.(message);
}

mkdirSync(dirname(cfg.dataFile), { recursive: true });

/**
 * The highest token the file already records.
 *
 * This is the engine's durable state, not a copy the middleware keeps: the guard
 * is constructed from it so a restart cannot re-admit a writer the file has
 * already moved past.
 */
function recoverHighest(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  let highest = null;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A torn tail from a killed process is not a token.
    }
    let token;
    try {
      token = parseFencingToken(record.token);
    } catch {
      continue;
    }
    if (!highest || compareFencingTokens(token, highest) > 0) highest = token;
  }
  return highest;
}

const recovered = recoverHighest(cfg.dataFile);
const guard = new FencingTokenGuard({ requireToken: cfg.requireToken !== false, initial: recovered });

let accepted = 0;
let refused = 0;
let protocol = null;
let fd = openSync(cfg.dataFile, 'a');

function handleLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    socket.write(`${JSON.stringify({ id: null, admitted: false, reason: 'protocol-error', detail: err.message })}\n`);
    return;
  }

  let token;
  if (typeof request.token === 'string') {
    try {
      token = parseFencingToken(request.token);
    } catch (err) {
      refused += 1;
      socket.write(
        `${JSON.stringify({ id: request.id, admitted: false, reason: 'malformed-token', detail: err.message })}\n`,
      );
      return;
    }
  }

  const admission = guard.admit(token, `key ${request.key}`);
  if (admission.admitted) {
    // Durable before the reply: an acknowledgement for a write the file does not
    // hold is the failure mode this whole test exists to rule out.
    appendFileSync(
      fd,
      `${JSON.stringify({ token: formatFencingToken(admission.token), key: request.key, value: request.value })}\n`,
    );
    fsyncSync(fd);
    accepted += 1;
  } else {
    refused += 1;
  }

  socket.write(
    `${JSON.stringify({
      id: request.id,
      admitted: admission.admitted,
      reason: admission.reason,
      detail: admission.detail,
      highest: admission.highest ? formatFencingToken(admission.highest) : null,
    })}\n`,
  );
}

const server = tls.createServer(
  {
    cert: cfg.cert.cert,
    key: cfg.cert.key,
    ca: cfg.cert.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  },
  (socket) => {
    protocol = socket.getProtocol();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', (err) => {
      send({ type: 'error', data: { message: `socket: ${err.message}` } });
    });
  },
);

server.on('tlsClientError', (err) => {
  // A client the CA does not vouch for never reaches the application.
  send({ type: 'rejected-client', data: { message: err.message } });
});

server.listen(cfg.port ?? 0, '127.0.0.1', () => {
  send({ type: 'ready', data: { port: server.address().port } });
});

process.on('message', (msg) => {
  if (!msg || !msg.cmd) return;

  if (msg.cmd === 'state') {
    const records = existsSync(cfg.dataFile)
      ? readFileSync(cfg.dataFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [];
    send({
      type: 'state',
      data: {
        accepted,
        refused,
        protocol,
        highest: guard.getHighest() ? formatFencingToken(guard.getHighest()) : null,
        recovered: recovered ? formatFencingToken(recovered) : null,
        records,
      },
    });
    return;
  }

  if (msg.cmd === 'stop') {
    server.close(() => {
      closeSync(fd);
      process.exit(0);
    });
  }
});
