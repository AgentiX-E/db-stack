#!/usr/bin/env node
/**
 * check-package — verify the *published* artefacts are actually consumable.
 *
 * Compiling successfully is not the same as being importable: declaration
 * entry points can point at files that are never emitted, and extensionless
 * ESM specifiers fail at runtime in Node. This check loads every published
 * entry point from `dist/` in a plain Node process (no bundler, no tsx) and
 * asserts the documented exports exist.
 *
 * Usage: node scripts/check-package.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

const TARGETS = [
  {
    dir: 'cluster',
    entry: '.',
    expect: [
      'RaftAdapter',
      'RaftTcpTransport',
      'SqliteStorage',
      'RaftGroupManager',
      'HAFailoverDetector',
      'FencingManager',
      'RaftJointConsensusEngine',
      'MessageCompressor',
      'EventBus',
      'SessionManager',
    ],
  },
  { dir: 'cluster', entry: './testing', expect: ['TestCluster', 'generateClusterCerts', 'LinearizabilityChecker'] },
  { dir: 'cluster', entry: './raft', expect: ['RaftAdapter'] },
  { dir: 'cluster', entry: './transport', expect: ['RaftTcpTransport'] },
  { dir: 'cluster', entry: './storage', expect: ['SqliteStorage'] },
  {
    dir: 'federation',
    entry: '.',
    expect: [
      'FederationManager',
      'MultiLeaderReplication',
      'OutboxStore',
      'TcpSecureTransport',
      'ExactlyOnceCDCPipeline',
      'AntiEntropy',
      'ConflictResolver',
      'DedupRing',
      'HLC',
    ],
  },
  { dir: 'federation', entry: './transport', expect: ['TcpSecureTransport'] },
  {
    dir: 'operations',
    entry: '.',
    expect: [
      'core',
      'health',
      'metrics',
      'backup',
      'audit',
      'security',
      'observability',
      'chaosengine',
      'slacollector',
    ],
  },
];

let failures = 0;

for (const target of TARGETS) {
  const pkgDir = resolve(root, target.dir);
  const label = `${target.dir}${target.entry === '.' ? '' : `/${target.entry.slice(2)}`}`;

  const packageJsonPath = `${pkgDir}/package.json`;
  if (!existsSync(packageJsonPath)) {
    console.error(`\u2717 ${label}: package.json missing`);
    failures += 1;
    continue;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const subpath = manifest.exports?.[target.entry];
  if (!subpath) {
    console.error(`\u2717 ${label}: no "exports" entry for "${target.entry}"`);
    failures += 1;
    continue;
  }

  // Resolve the file the package *publishes* for this subpath. Importing the
  // package name would additionally require a node_modules link that only
  // exists in a consumer install, so the check is anchored to the declared
  // target instead: it still fails when the path is not emitted, when an ESM
  // specifier lost its extension, or when an export is missing.
  const entry = subpath.import ?? subpath.default ?? subpath;
  const entryFile = resolve(pkgDir, entry);
  if (!existsSync(entryFile)) {
    console.error(`\u2717 ${label}: declared entry not emitted (${entry})`);
    failures += 1;
    continue;
  }

  const script = `
    const expected = ${JSON.stringify(target.expect)};
    const url = ${JSON.stringify(pathToFileURL(entryFile).href)};
    const loaded = await import(url);
    const missing = expected.filter((name) => !(name in loaded));
    if (missing.length > 0) {
      console.error('missing exports: ' + missing.join(', '));
      process.exit(1);
    }
    console.log('ok (' + Object.keys(loaded).length + ' exports)');
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: pkgDir,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error(`\u2717 ${label}: ${(result.stderr || result.stdout).split('\n').slice(0, 3).join(' ')}`);
    failures += 1;
  } else {
    console.log(`\u2713 ${label} ${result.stdout.trim()}`);
  }
}

if (failures > 0) {
  console.error(`\nPackage check FAILED (${failures} entry point(s))`);
  process.exit(1);
}
console.log('\nPackage check passed: every published entry point is importable.');
