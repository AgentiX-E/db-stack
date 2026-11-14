/**
 * JsonAuditExporter — Exports audit entries to JSON format (file or string).
 *
 * @module @agentix-e/db-operations-audit/impl
 */

import { writeFile } from 'node:fs/promises';
import type { IAuditExporter, ExportOptions } from '../interfaces/index.js';
import type { IAuditStore } from '../interfaces/index.js';

/**
 * JSON audit exporter that reads from an IAuditStore and serialises
 * entries to pretty-printed JSON (json-array format).
 */
export class JsonAuditExporter implements IAuditExporter {
  constructor(private readonly store: IAuditStore) {}

  async exportToFile(outputPath: string, options: ExportOptions): Promise<number> {
    const entries = await this.store.query(options.filter ?? {});
    const json = JSON.stringify(entries, null, 2);
    await writeFile(outputPath, json, 'utf-8');
    return entries.length;
  }

  async exportToString(options: ExportOptions): Promise<string> {
    const entries = await this.store.query(options.filter ?? {});
    return JSON.stringify(entries, null, 2);
  }
}
