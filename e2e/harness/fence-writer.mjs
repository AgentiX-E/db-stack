/**
 * Fence writer — a real client that presents a token to the fenced store.
 *
 * It stands in for an engine's write path: it holds whatever token its cluster
 * last minted and attaches it to every write, over a real mutual-TLS socket. The
 * interesting cases are the ones where that token is *no longer current* — the
 * old primary's position after a new term — and the answer has to come from the
 * store, not from the writer's own belief.
 *
 * Writes are issued one at a time by the parent, so the reply a test reads is
 * always the reply to the write it just staged.
 *
 * IPC contract
 * ------------
 *   parent → writer : { cmd: 'write', id, token, key, value } | { cmd: 'close' }
 *   writer → parent : { type: 'ready', data: { protocol } }
 *                     { type: 'reply', data: { id, admitted, reason?, detail?, highest } }
 *                     { type: 'error', data: { message } }
 */

import tls from 'node:tls';

const RAW = process.env.FENCE_WRITER_CONFIG;
if (!RAW) {
  process.stderr.write('[fence-writer] FENCE_WRITER_CONFIG missing\n');
  process.exit(2);
}
const cfg = JSON.parse(RAW);

function send(message) {
  process.send?.(message);
}

const socket = tls.connect(
  {
    host: cfg.host,
    port: cfg.port,
    // The identity the client expects the resource to present. A writer that
    // skipped this would accept any certificate the CA ever signed.
    servername: cfg.servername,
    cert: cfg.cert.cert,
    key: cfg.cert.key,
    ca: cfg.cert.ca,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  },
  () => {
    send({ type: 'ready', data: { protocol: socket.getProtocol() } });
  },
);

let buffer = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length > 0) send({ type: 'reply', data: JSON.parse(line) });
    newline = buffer.indexOf('\n');
  }
});

socket.on('error', (err) => {
  send({ type: 'error', data: { message: err.message } });
});

process.on('message', (msg) => {
  if (!msg || !msg.cmd) return;

  if (msg.cmd === 'write') {
    socket.write(`${JSON.stringify({ id: msg.id, token: msg.token, key: msg.key, value: msg.value })}\n`);
    return;
  }

  if (msg.cmd === 'close') {
    socket.end();
  }
});
