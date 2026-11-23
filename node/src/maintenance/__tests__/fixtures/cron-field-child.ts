/**
 * Parse one cron field in a process of its own, and print what it named.
 *
 * The point of the separate process is that a synchronous loop cannot be
 * interrupted from inside: a case that calls `parseCronField` directly is a case
 * that hangs with the worker when the loop it is driving diverges, and vitest
 * never gets to report it. From outside, a parent that owns the process can say
 * "this did not return within its deadline" — which is a failing test with a
 * name (see `AC103`).
 *
 * Usage: `node --import tsx cron-field-child.ts <field> <min> <max>`
 * Prints the resolved values as JSON, sorted.
 */

import { parseCronField } from '../../impl/cron.js';

const [field, min, max] = process.argv.slice(2);

if (field === undefined || min === undefined || max === undefined) {
  process.stderr.write('usage: cron-field-child.ts <field> <min> <max>\n');
  process.exit(2);
}

const values = [...parseCronField(field, Number(min), Number(max))].sort((a, b) => a - b);
process.stdout.write(JSON.stringify(values));
