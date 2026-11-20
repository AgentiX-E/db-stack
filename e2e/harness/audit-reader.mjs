/**
 * Audit reader — a process that opens a trail a *different* process wrote.
 *
 * It reports what it can see and what is on the disk beside the segments, because
 * the two questions after a kill are different: "is every acknowledged entry
 * readable" and "did the recovery path leave a half-written archive behind".
 *
 * IPC contract
 * ------------
 *   parent → reader : { cmd: 'read' }
 *   reader → parent : { type: 'ready', data: { dataDir } }
 *                   | { type: 'read', data: { count, ids, segments, partials } }
 *                   | { type: 'error', data: string }
 */

import { readdirSync } from 'node:fs';
import { FileAuditStore } from '@agentix-e/db-operations-audit';

const RAW = process.env.AUDIT_READER_CONFIG;
if (!RAW) {
  process.stderr.write('[audit-reader] AUDIT_READER_CONFIG missing\n');
  process.exit(2);
}

const cfg = JSON.parse(RAW);
let store;

function send(message) {
  if (process.send) process.send(message);
}

function describe(dataDir) {
  const entries = readdirSync(dataDir);
  return {
    segments: entries.filter((name) => name.endsWith('.ndjson') || name.endsWith('.ndjson.gz')).sort(),
    partials: entries.filter((name) => name.endsWith('.part')).sort(),
  };
}

async function main() {
  store = new FileAuditStore(cfg.store);
  send({ type: 'ready', data: { dataDir: cfg.store.dataDir } });

  process.on('message', async (msg) => {
    if (!msg || !msg.cmd) return;
    try {
      if (msg.cmd === 'read') {
        // `query` with no filter walks every segment, so an entry hidden behind an
        // archive or a segment boundary is exactly the failure this reports.
        const entries = await store.query({ limit: Number(cfg.limit ?? 100_000) });
        const described = describe(cfg.store.dataDir);
        send({
          type: 'read',
          data: {
            count: entries.length,
            ids: entries.map((entry) => entry.id),
            ...described,
          },
        });
        await store.close();
        setTimeout(() => process.exit(0), 20);
      }
    } catch (error) {
      send({
        type: 'error',
        data: `read failed: ${error instanceof Error ? error.message : String(error)}`,
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
