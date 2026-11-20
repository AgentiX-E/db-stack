/**
 * Audit writer — a process that appends to a real audit trail and nothing else.
 *
 * The trail is the store's own on-disk format: acknowledged entries are lines the
 * store synced, segments rotate and compress on their own schedule, and this
 * process can be killed at any point without a chance to flush. What a second
 * process can read afterwards is the only evidence that the recipe holds.
 *
 * IPC contract
 * ------------
 *   parent → writer : { cmd: 'write', entries } | { cmd: 'status' } | { cmd: 'stop' }
 *   writer → parent : { type: 'ready', data: { dataDir } }
 *                   | { type: 'written', data: { id, n } }
 *                   | { type: 'status', data: { dataDir } }
 *                   | { type: 'stopped', data: { dataDir } }
 *                   | { type: 'error', data: string }
 */

import { FileAuditStore } from '@agentix-e/db-operations-node/audit';

const RAW = process.env.AUDIT_WRITER_CONFIG;
if (!RAW) {
  process.stderr.write('[audit-writer] AUDIT_WRITER_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);
let store;

function send(message) {
  if (process.send) process.send(message);
}

async function main() {
  store = new FileAuditStore(cfg.store);
  send({ type: 'ready', data: { dataDir: cfg.store.dataDir } });

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'write') {
        const count = Number(msg.entries ?? 1);
        for (let i = 0; i < count; i++) {
          const n = (cfg.startAt ?? 0) + i;
          const id = await store.write({
            operation: 'rotate-key',
            actor: 'ops-real-process',
            resource: `tenant-${n % 3}`,
            result: 'success',
            severity: 'info',
            // Padding is the point: it makes a segment exceed `maxFileSize` after a
            // handful of entries, so rotation and its compression happen while the
            // process is still writing rather than at a tidy moment afterwards.
            details: { n, payload: 'x'.repeat(cfg.padding ?? 0) },
          });
          send({ type: 'written', data: { id, n } });
        }
      } else if (msg.cmd === 'status') {
        send({ type: 'status', data: { dataDir: cfg.store.dataDir } });
      } else if (msg.cmd === 'stop') {
        await store.close();
        send({ type: 'stopped', data: { dataDir: cfg.store.dataDir } });
        setTimeout(() => process.exit(0), 20);
      }
    } catch (error) {
      send({
        type: 'error',
        data: `write failed: ${error instanceof Error ? error.message : String(error)}`,
        fatal: true,
      });
      process.exit(1);
    }
  });
}

main().catch((error) => {
  send({ type: 'error', data: `start failed: ${error instanceof Error ? error.message : String(error)}`, fatal: true });
  process.exit(1);
});
