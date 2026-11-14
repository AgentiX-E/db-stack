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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const specifier = target.entry === '.' ? pkgDir : `${pkgDir}/${target.entry.slice(2)}`;

  // Prefer resolving through the package name, which is what consumers do.
  const packageJsonPath = `${pkgDir}/package.json`;
  if (!existsSync(packageJsonPath)) {
    console.error(`✗ ${target.dir}${target.entry}: package.json missing`);
    failures += 1;
    continue;
  }

  const script = `
    const expected = ${JSON.stringify(target.expect)};
    const url = ${JSON.stringify(specifier)};
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

  const label = `${target.dir}${target.entry === '.' ? '' : `/${target.entry.slice(2)}`}`;
  if (result.status !== 0) {
    console.error(`✗ ${label}: ${(result.stderr || result.stdout).split('\n').slice(0, 3).join(' ')}`);
    failures += 1;
  } else {
    console.log(`✓ ${label} ${result.stdout.trim()}`);
  }
}

if (failures > 0) {
  console.error(`\nPackage check FAILED (${failures} entry point(s))`);
  process.exit(1);
}
console.log('\nPackage check passed: every published entry point is importable.');
