/**
 * A second process that appends to an audit trail, and says so after each line.
 *
 * Runs out of process because the properties it exists to establish are about
 * processes, not functions: that a line acknowledged by one process survives that
 * process being killed, and that two processes appending to one trail do not
 * overwrite each other. Neither can be observed from inside the process that is
 * doing the writing.
 *
 * Usage: `node --import tsx append-child.ts <dataDir> <count> [flags]`
 *
 *   --forever      write until killed
 *   --rotate       rotate on every line (`maxFileSize: 1`), so the segment name is
 *                  chosen again for each write — the window in which two processes
 *                  can pick the same next number
 *   --await <path> do nothing until <path> exists, so two children can be released
 *                  at the same instant instead of one starting a second late
 *
 * Prints `ACK <id>` on stdout after `write()` resolves — that is, after the line
 * is on the medium — and `FAILED <message>` on the first write that rejects.
 *
 * @module @agentix-e/db-node/audit/__tests__/fixtures
 */

import { existsSync } from 'node:fs';
import { FileAuditStore } from '../../impl/FileAuditStore.js';

const [dataDir, rawCount, ...flags] = process.argv.slice(2);

if (!dataDir || !rawCount) {
  process.stderr.write('usage: append-child.ts <dataDir> <count> [--forever] [--rotate] [--await <path>]\n');
  process.exit(2);
}

const count = Number.parseInt(rawCount, 10);
const forever = flags.includes('--forever');
const rotate = flags.includes('--rotate');
const awaitFlag = flags.indexOf('--await');
const awaitPath = awaitFlag === -1 ? undefined : flags[awaitFlag + 1];

const store = new FileAuditStore({ dataDir, maxFileSize: rotate ? 1 : 8 * 1024 * 1024 });

/**
 * Wait for a file to appear, or give up.
 *
 * A busy poll rather than `fs.watch`: the wait is a few hundred microseconds against
 * a write the parent performs immediately, and an fsnotify event that arrives after
 * the watcher is installed is one more way for a test to be flaky.
 */
if (awaitPath) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(awaitPath)) {
    if (Date.now() > deadline) {
      process.stderr.write(`never saw the release file ${awaitPath}\n`);
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

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
