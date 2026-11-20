/**
 * The targets `check-package` judges, and the probes it runs against them.
 *
 * This is data, and it lives apart from the driver for one reason: three of these
 * entries carry a `behaviour` closure that *calls* the built artefact, and the
 * Quality job — where the gate's own tests run — deliberately has no `dist/`.
 * A unit fixture cannot stand in for the published module: the defect these
 * probes exist to catch (`require` inside an ESM artefact, a trace id lost across
 * an async boundary) is invisible to everything except the module as published.
 * So the table is measured where it runs, which is the E2E job, and it is carried
 * as a named debt here rather than hidden inside the driver.
 */

export const TARGETS = [
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
      const registry = new loaded.CDCPublicationRegistry({
        nodeId: "probe",
        engine,
      });
      await registry.createPublication("probe-pub", ["orders"]);
      await registry.createSubscription(
        "probe-sub",
        "probe-pub",
        "memory://probe",
      );

      const sink = new loaded.InMemoryCDCSink("probe");
      const pump = new loaded.CDCSubscriptionPump({
        engine,
        registry,
        resolveSink: () =>
          new loaded.CDCSinkResolver(sink, { healthCheckIntervalMs: 0 }),
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
      assert.equal(
        pump.getStatus().delivered,
        1,
        "the pump must count the delivery",
      );

      await pump.stop();
    },
  },
  { dir: "federation", entry: "./transport", expect: ["TcpSecureTransport"] },
  {
    dir: "federation",
    entry: "./testing",
    expect: ["CDCFailureInjector"],
    // The instrument is only useful if it injects: import proves the symbol is
    // exported, and this builds one over a real sink, forces a drop and checks
    // that the wrapped sink received nothing.
    behaviour: async ({ loaded, assert }) => {
      // A sink written inline rather than imported: the claim is that the
      // injector wraps *any* ICDCSink, and a probe that used the package's own
      // reference sink would pass even if it only worked with that one.
      const events = [];
      const sink = {
        name: "probe-sink",
        connect: async () => undefined,
        disconnect: async () => undefined,
        emit: async (batch) => {
          events.push(...batch);
        },
      };
      const injector = new loaded.CDCFailureInjector(sink, [
        { type: "connection_drop", failEveryN: 1, maxFailures: 1, on: "emit" },
      ]);
      await injector.connect();

      let refused = false;
      try {
        await injector.emit([
          {
            id: "e1",
            type: "insert",
            table: "t",
            key: "k1",
            data: {},
            timestamp: 1n,
          },
        ]);
      } catch {
        refused = true;
      }

      assert.equal(refused, true, "the configured drop must refuse the write");
      assert.equal(
        injector.injectedBy("connection_drop"),
        1,
        "the drop is counted",
      );
      assert.equal(events.length, 0, "nothing reached the wrapped sink");
      assert.equal(
        injector.connected,
        false,
        "the injector is disconnected afterwards",
      );
    },
  },
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
