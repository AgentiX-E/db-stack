/**
 * CompactionConfig Tests
 *
 * Iteration 1 — Raft Industrial-Grade Enhancements
 *
 * Tests the configurable log compaction threshold and compactTarget
 * via SqliteStorage.setCompactionConfig() and the new CompactionConfig interface.
 *
 * Acceptance Criteria:
 *   AC CC.1: setCompactionConfig accepts valid config
 *   AC CC.2: getCompactionConfig returns the stored config
 *   AC CC.3: CompactionConfig with threshold=0 is valid
 *   AC CC.4: CompactionConfig with compactTarget=1 is valid
 *   AC CC.5: Default (no config) returns undefined
 *   AC CC.6: Can update config after initial set
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage, CompactionConfig } from '../../consensus/storage/SqliteStorage';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tempDbPath(name: string): string {
  const dir = path.join(os.tmpdir(), `compaction-config-test-${name}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'raft.db');
}

describe('CompactionConfig', () => {
  let sqlite: SqliteStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath(`cc-${Date.now()}`);
    sqlite = new SqliteStorage({ file: dbPath, maxLogSize: 10000 });
    sqlite.open();
  });

  afterEach(() => {
    sqlite.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  //
  // AC CC.1: setCompactionConfig accepts valid config
  //
  it('AC CC.1: setCompactionConfig accepts valid config', () => {
    const cfg: CompactionConfig = { threshold: 10000, compactTarget: 5000 };
    sqlite.setCompactionConfig(cfg);
    const stored = sqlite.getCompactionConfig();
    expect(stored).toBeDefined();
    expect(stored!.threshold).toBe(10000);
    expect(stored!.compactTarget).toBe(5000);
  });

  //
  // AC CC.2: getCompactionConfig returns the stored config
  //
  it('AC CC.2: getCompactionConfig returns the same config', () => {
    const cfg: CompactionConfig = { threshold: 5000, compactTarget: 1000 };
    sqlite.setCompactionConfig(cfg);
    const stored = sqlite.getCompactionConfig();
    expect(stored).toEqual(cfg);
  });

  //
  // AC CC.3: threshold=0 is valid
  //
  it('AC CC.3: threshold=0 is a valid config', () => {
    const cfg: CompactionConfig = { threshold: 0, compactTarget: 500 };
    sqlite.setCompactionConfig(cfg);
    const stored = sqlite.getCompactionConfig();
    expect(stored).toBeDefined();
    expect(stored!.threshold).toBe(0);
    expect(stored!.compactTarget).toBe(500);
  });

  //
  // AC CC.4: compactTarget=1 is valid
  //
  it('AC CC.4: compactTarget=1 is a valid config', () => {
    const cfg: CompactionConfig = { threshold: 100, compactTarget: 1 };
    sqlite.setCompactionConfig(cfg);
    const stored = sqlite.getCompactionConfig();
    expect(stored!.compactTarget).toBe(1);
  });

  //
  // AC CC.5: Default (no config) returns undefined
  //
  it('AC CC.5: default getCompactionConfig returns undefined', () => {
    const stored = sqlite.getCompactionConfig();
    expect(stored).toBeUndefined();
  });

  //
  // AC CC.6: Can update config after initial set
  //
  it('AC CC.6: setCompactionConfig overwrites previous config', () => {
    sqlite.setCompactionConfig({ threshold: 1000, compactTarget: 500 });
    sqlite.setCompactionConfig({ threshold: 2000, compactTarget: 1000 });
    const stored = sqlite.getCompactionConfig();
    expect(stored!.threshold).toBe(2000);
    expect(stored!.compactTarget).toBe(1000);
  });
});
