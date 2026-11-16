/**
 * A second process that appends to an audit trail, and says so after each line.
 *
 * Runs out of process because the properties it exists to establish are about
 * processes, not functions: that a line acknowledged by one process survives that
 * process being killed, and that two processes appending to one trail do not
 * overwrite each other. Neither can be observed from inside the process that is
 * doing the writing.
 *
 * Usage: `node --import tsx append-child.ts <dataDir> <count> [--forever]`
 *
 * Prints `ACK <id>` on stdout after `write()` resolves — that is, after the line
 * is on the medium — and `FAILED <message>` on the first write that rejects.
 *
 * @module @agentix-e/db-operations-audit/__tests__/fixtures
 */

import { FileAuditStore } from '../../impl/FileAuditStore.js';

const [dataDir, rawCount, flag] = process.argv.slice(2);

if (!dataDir || !rawCount) {
  process.stderr.write('usage: append-child.ts <dataDir> <count> [--forever]\n');
  process.exit(2);
}

const count = Number.parseInt(rawCount, 10);
const forever = flag === '--forever';

const store = new FileAuditStore({ dataDir, maxFileSize: 8 * 1024 * 1024 });

let written = 0;
for (;;) {
  if (!forever && written >= count) break;
  try {
    const id = await store.write({
      operation: 'APPEND',
      actor: `proc-${process.pid}`,
      resource: '/trail',
      result: 'success',
      details: { index: written },
    });
    process.stdout.write(`ACK ${id}\n`);
  } catch (error) {
    process.stdout.write(`FAILED ${(error as Error).message}\n`);
    process.exit(1);
  }
  written++;
}

await store.close();
process.exit(0);
