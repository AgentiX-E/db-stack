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
 * Existing is not the same as working, either. A `behaviour` probe goes one step
 * further and *calls* the entry point: three published features once passed both
 * the compiler and the whole test suite while throwing
 * `ReferenceError: require is not defined in ES module scope` (a CommonJS
 * `require` inside an ESM module) or silently losing their trace ids. The test
 * transform supplies a `require`; a consumer does not. So the last thing this
 * script does is run the artefact the way a consumer would.
 *
 * Usage: node scripts/check-package.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

const TARGETS = [
  {
    dir: "cluster",
    entry: ".",
    expect: [
      "RaftAdapter",
      "RaftTcpTransport",
      "SqliteStorage",
      "RaftGroupManager",
      "HAFailoverDetector",
      "FencingManager",
      "RaftJointConsensusEngine",
      "MessageCompressor",
      "EventBus",
      "SessionManager",
      "MerkleTree",
      "traceContext",
    ],
    // The digest constant is computed independently, with node:crypto, not by
    // calling the class: a tree compared with itself agrees with itself whatever
    // it computes.
    behaviour: async ({ loaded, assert }) => {
      const tree = new loaded.MerkleTree();
      tree.build([
        { key: "a", hash: "h1" },
        { key: "b", hash: "h2" },
      ]);
      assert.equal(
        tree.size,
        2,
        "MerkleTree.build() must not double the leaf set",
      );
      assert.equal(
        tree.computeRoot(),
        "b6de7e0c3068589921fcafd415b705feb8e82bd72ce9d92413ef55e659259894",
        "MerkleTree.computeRoot() must hash the leaves, which a CommonJS require cannot do here",
      );

      const seen = await loaded.traceContext.runWithAsync(
        "trace-probe",
        async () => {
          await new Promise((done) => setTimeout(done, 1));
          return loaded.traceContext.getTraceId();
        },
      );
      assert.equal(
        seen,
        "trace-probe",
        "trace ids must survive an async boundary in the published artefact",
      );
      assert.equal(
        loaded.traceContext.getTraceId(),
        undefined,
        "trace ids must not leak outside runWithAsync",
      );
    },
  },
  {
    dir: "cluster",
    entry: "./testing",
    expect: ["TestCluster", "generateClusterCerts", "LinearizabilityChecker"],
  },
  { dir: "cluster", entry: "./raft", expect: ["RaftAdapter"] },
  { dir: "cluster", entry: "./transport", expect: ["RaftTcpTransport"] },
  { dir: "cluster", entry: "./storage", expect: ["SqliteStorage"] },
  {
    dir: "federation",
    entry: ".",
    expect: [
      "FederationManager",
      "MultiLeaderReplication",
      "OutboxStore",
      "TcpSecureTransport",
      "ExactlyOnceCDCPipeline",
      "AntiEntropy",
      "ConflictResolver",
      "DedupRing",
      "HLC",
      "CDCSubscriptionPump",
      "CDCPublicationRegistry",
      "CDCEngine",
      "InMemoryCDCSink",
      "CDCSinkResolver",
      "projectChangeEvent",
    ],
    // The pump is the one published feature whose job is an edge between two
    // objects, and an edge cannot be verified by importing it: the probe builds
    // a catalogue, a sink and a pump from the built artefact and checks that a
    // change appended to the engine comes out at the sink.
    behaviour: async ({ loaded, assert }) => {
      const engine = new loaded.CDCEngine({ nodeId: "probe" });
      const registry = new loaded.CDCPublicationRegistry({ nodeId: "probe", engine });
      await registry.createPublication("probe-pub", ["orders"]);
      await registry.createSubscription("probe-sub", "probe-pub", "memory://probe");

      const sink = new loaded.InMemoryCDCSink("probe");
      const pump = new loaded.CDCSubscriptionPump({
        engine,
        registry,
        resolveSink: () => new loaded.CDCSinkResolver(sink, { healthCheckIntervalMs: 0 }),
      });
      await pump.start();

      const change = engine.appendChange({
        tableName: "orders",
        operation: "insert",
        oldValues: null,
        newValues: { id: 1 },
      });

      // Poll on the pump's own count: the sink receives the event inside
      // emit(), a moment before the pump records the delivery, so a poll on the
      // sink would read the pair half-finished.
      for (let i = 0; i < 40 && pump.getStatus().delivered === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.equal(
        sink.getEvents().length,
        1,
        "a change appended to the engine must reach the subscription sink exactly once",
      );
      assert.equal(
        sink.getEvents()[0].id,
        change.lsn + ":" + change.txId,
        "the delivered event must carry the LSN the engine assigned",
      );
      assert.equal(pump.getStatus().delivered, 1, "the pump must count the delivery");

      await pump.stop();
    },
  },
  { dir: "federation", entry: "./transport", expect: ["TcpSecureTransport"] },
  {
    dir: "operations",
    entry: ".",
    expect: [
      "core",
      "health",
      "metrics",
      "backup",
      "audit",
      "security",
      "observability",
      "chaosengine",
      "slacollector",
    ],
  },
];

let failures = 0;

for (const target of TARGETS) {
  const pkgDir = resolve(root, target.dir);
  const label = `${target.dir}${target.entry === "." ? "" : `/${target.entry.slice(2)}`}`;

  const packageJsonPath = `${pkgDir}/package.json`;
  if (!existsSync(packageJsonPath)) {
    console.error(`\u2717 ${label}: package.json missing`);
    failures += 1;
    continue;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
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
    const probeSource = ${JSON.stringify(target.behaviour ? target.behaviour.toString() : null)};
    const loaded = await import(url);
    const missing = expected.filter((name) => !(name in loaded));
    if (missing.length > 0) {
      console.error('missing exports: ' + missing.join(', '));
      process.exit(1);
    }
    if (probeSource) {
      const assert = (await import('node:assert/strict')).default;
      const probe = new Function('return (' + probeSource + ')')();
      await probe({ loaded, assert });
    }
    console.log('ok (' + Object.keys(loaded).length + ' exports' +
      (probeSource ? ', behaviour verified' : '') + ')');
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: pkgDir,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    // Keep the assertion message: "AssertionError: MerkleTree.build() must not
    // double the leaf set" is the whole diagnosis, and a stack trace truncated
    // to three lines is not.
    const detail = (result.stderr || result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 4)
      .join(" | ");
    console.error(`\u2717 ${label}: ${detail}`);
    failures += 1;
  } else {
    console.log(`\u2713 ${label} ${result.stdout.trim()}`);
  }
}

if (failures > 0) {
  console.error(`\nPackage check FAILED (${failures} entry point(s))`);
  process.exit(1);
}
console.log(
  "\nPackage check passed: every published entry point is importable, and its probe passes.",
);
