/**
 * InMemoryStorageBackend — Simulates a storage backend entirely in memory.
 *
 * @module @agentix-e/db-operations-backup/impl
 */

import type { IStorageBackend } from '../interfaces/index.js';

/** In-memory storage object entry. */
interface StorageEntry {
  data: Buffer;
  size: number;
  lastModified: string;
}

/**
 * In-memory implementation of IStorageBackend.
 * Stores blobs in a Map<string, Buffer> for testing and simulation.
 */
export class InMemoryStorageBackend implements IStorageBackend {
  readonly name = 'in-memory';

  private readonly objects: Map<string, StorageEntry> = new Map();

  /** @inheritdoc */
  async upload(sourcePath: string, destKey: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(sourcePath);
    this.objects.set(destKey, {
      data,
      size: data.length,
      lastModified: new Date().toISOString(),
    });
  }

  /** @inheritdoc */
  async download(sourceKey: string, destPath: string): Promise<void> {
    const entry = this.objects.get(sourceKey);
    if (!entry) {
      throw new Error(`Object not found: ${sourceKey}`);
    }
    const fs = await import('node:fs/promises');
    await fs.writeFile(destPath, entry.data);
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const result: Array<{ key: string; size: number; lastModified: string }> = [];
    for (const [key, entry] of this.objects) {
      if (key.startsWith(prefix)) {
        result.push({
          key,
          size: entry.size,
          lastModified: entry.lastModified,
        });
      }
    }
    return result;
  }

  /** @inheritdoc */
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** @inheritdoc */
  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  /** @inheritdoc */
  async getUsageBytes(): Promise<number> {
    let total = 0;
    for (const entry of this.objects.values()) {
      total += entry.size;
    }
    return total;
  }
}
