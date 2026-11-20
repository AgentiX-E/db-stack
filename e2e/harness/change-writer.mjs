/**
 * Change writer — a process that writes to a change log and nothing else.
 *
 * It stands in for the database engine whose WAL the federation layer reads.
 * The point of the separate process is that the records the CDC path consumes
 * are not produced by the code under test: they are bytes this process wrote and
 * fsynced, and the reader on the other side has to find them on the disk.
 *
 * IPC contract
 * ------------
 *   parent  → writer : { cmd: 'write', records } | { cmd: 'status' } | { cmd: 'stop' }
 *   writer  → parent : { type: 'written', data: { lsn, seq } }
 *                    | { type: 'status', data: { length, lastLsn } }
 *                    | { type: 'done', data: { length, lastLsn } }
 *                    | { type: 'error', data: string }
 */

import { FileChangeLogWriter } from '@agentix-e/db-federation';

const RAW = process.env.CHANGE_WRITER_CONFIG;
if (!RAW) {
  process.stderr.write('[writer] CHANGE_WRITER_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);

function send(message) {
  if (process.send) process.send(message);
}

let writer;

async function main() {
  writer = await FileChangeLogWriter.open({ dir: cfg.dir });
  send({ type: 'ready', data: { length: writer.length, lastLsn: writer.lastLsn } });

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'write') {
        const count = Number(msg.records ?? 1);
        for (let i = 0; i < count; i++) {
          const seq = writer.length + 1;
          const lsn = await writer.append({
            table: cfg.table,
            operation: 'insert',
            newValues: { id: seq, payload: `row-${seq}` },
            txId: `${cfg.nodeId}-tx-${seq}`,
          });
          send({ type: 'written', data: { lsn, seq } });
        }
        send({ type: 'done', data: { length: writer.length, lastLsn: writer.lastLsn } });
      } else if (msg.cmd === 'status') {
        send({ type: 'status', data: { length: writer.length, lastLsn: writer.lastLsn } });
      } else if (msg.cmd === 'stop') {
        await writer.close();
        send({ type: 'stopped' });
        setTimeout(() => process.exit(0), 20);
      }
    } catch (err) {
      send({ type: 'error', data: err instanceof Error ? err.message : String(err) });
    }
  });
}

process.on('SIGTERM', () => process.exit(0));

main().catch((err) => {
  process.stderr.write(`[writer] fatal: ${err?.stack ?? err}\n`);
  send({ type: 'error', data: String(err?.message ?? err), fatal: true });
  process.exit(1);
});
