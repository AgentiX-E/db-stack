/**
 * The three published features whose behaviour only a consumer process can see.
 *
 * This file is a *child programme*, in the same category as `raft-node.mjs`: it is
 * loaded by a plain `node` process the test runner has not transformed, and it is
 * verified by what that process reports rather than by V8 coverage. The rule is not
 * an exemption for convenience — it is the reason these probes exist. A `require`
 * inside an ESM artefact, a trace id lost across an async boundary and a
 * subscription pump that delivered to no sink all passed the compiler *and* the
 * whole test suite, because the test transform supplies a `require` that a consumer
 * does not have. Instrumenting the code that catches that would put it back inside
 * the runtime it is testing.
 *
 * The bodies are assertions, not a smoke test: each one builds the feature from the
 * published module and checks the value it produces. `published-artefact.ts` runs
 * them and reports the answer.
 */

export const PROBES = [
  {
    name: 'cluster: a Merkle root hashes its leaves, and a trace id survives an async boundary',
    specifier: '@agentix-e/db-cluster',
    expect: ['MerkleTree', 'traceContext'],
    behaviour: async ({ loaded, assert }) => {
      const tree = new loaded.MerkleTree();
      tree.build([
        { key: 'a', hash: 'h1' },
        { key: 'b', hash: 'h2' },
      ]);
      assert.equal(tree.size, 2, 'MerkleTree.build() must not double the leaf set');
      // The digest is a constant computed independently with node:crypto: a tree
      // compared with itself agrees with itself whatever it computes.
      assert.equal(
        tree.computeRoot(),
        'b6de7e0c3068589921fcafd415b705feb8e82bd72ce9d92413ef55e659259894',
        'MerkleTree.computeRoot() must hash the leaves, which a CommonJS require cannot do here',
      );

      const seen = await loaded.traceContext.runWithAsync('trace-probe', async () => {
        await new Promise((done) => setTimeout(done, 1));
        return loaded.traceContext.getTraceId();
      });
      assert.equal(seen, 'trace-probe', 'trace ids must survive an async boundary in the published artefact');
      assert.equal(loaded.traceContext.getTraceId(), undefined, 'trace ids must not leak outside runWithAsync');
    },
  },
  {
    name: 'federation: a change appended to the engine reaches the subscription sink exactly once',
    specifier: '@agentix-e/db-federation',
    expect: ['CDCEngine', 'CDCPublicationRegistry', 'CDCSubscriptionPump', 'CDCSinkResolver', 'InMemoryCDCSink'],
    behaviour: async ({ loaded, assert }) => {
      const engine = new loaded.CDCEngine({ nodeId: 'probe' });
      const registry = new loaded.CDCPublicationRegistry({ nodeId: 'probe', engine });
      await registry.createPublication('probe-pub', ['orders']);
      await registry.createSubscription('probe-sub', 'probe-pub', 'memory://probe');

      const sink = new loaded.InMemoryCDCSink('probe');
      const pump = new loaded.CDCSubscriptionPump({
        engine,
        registry,
        resolveSink: () => new loaded.CDCSinkResolver(sink, { healthCheckIntervalMs: 0 }),
      });
      await pump.start();

      const change = engine.appendChange({
        tableName: 'orders',
        operation: 'insert',
        oldValues: null,
        newValues: { id: 1 },
      });

      // Poll on the pump's own count: the sink receives the event inside `emit()`, a
      // moment before the pump records the delivery, so a poll on the sink would read
      // the pair half-finished.
      for (let i = 0; i < 40 && pump.getStatus().delivered === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.equal(
        sink.getEvents().length,
        1,
        'a change appended to the engine must reach the subscription sink exactly once',
      );
      assert.equal(
        sink.getEvents()[0].id,
        change.lsn + ':' + change.txId,
        'the delivered event must carry the LSN the engine assigned',
      );
      assert.equal(pump.getStatus().delivered, 1, 'the pump must count the delivery');

      await pump.stop();
    },
  },
  {
    name: 'federation/testing: the failure injector injects, counts, and leaves the wrapped sink empty',
    specifier: '@agentix-e/db-federation/testing',
    expect: ['CDCFailureInjector'],
    behaviour: async ({ loaded, assert }) => {
      // A sink written inline rather than imported: the claim is that the injector
      // wraps *any* ICDCSink, and a probe that used the package's own reference sink
      // would pass even if it only worked with that one.
      const events = [];
      const sink = {
        name: 'probe-sink',
        connect: async () => undefined,
        disconnect: async () => undefined,
        emit: async (batch) => {
          events.push(...batch);
        },
      };
      const injector = new loaded.CDCFailureInjector(sink, [
        { type: 'connection_drop', failEveryN: 1, maxFailures: 1, on: 'emit' },
      ]);
      await injector.connect();

      let refused = false;
      try {
        await injector.emit([{ id: 'e1', type: 'insert', table: 't', key: 'k1', data: {}, timestamp: 1n }]);
      } catch {
        refused = true;
      }

      assert.equal(refused, true, 'the configured drop must refuse the write');
      assert.equal(injector.injectedBy('connection_drop'), 1, 'the drop is counted');
      assert.equal(events.length, 0, 'nothing reached the wrapped sink');
      assert.equal(injector.connected, false, 'the injector is disconnected afterwards');
    },
  },
];

/**
 * The probes that must *fail*, and the reason they are programmes too.
 *
 * A runner that has never reported a failure is a runner whose green is
 * indistinguishable from a runner that did not run. These three are the shapes a
 * probe can break in — an assertion that does not hold, an exit with no output, and
 * a symbol the published module does not export — and each is run through the same
 * child process as the real ones, so the failure path is measured rather than
 * assumed.
 */
export const CONTROLS = [
  {
    name: 'a probe whose assertion does not hold',
    specifier: '@agentix-e/db-cluster',
    expect: ['RaftAdapter'],
    behaviour: ({ assert }) => {
      assert.equal(1, 2, 'the artefact must export one');
    },
  },
  {
    name: 'a probe that exits without a word',
    specifier: '@agentix-e/db-cluster',
    expect: ['RaftAdapter'],
    behaviour: () => {
      process.exit(1);
    },
  },
  {
    name: 'a probe naming a symbol the artefact does not publish',
    specifier: '@agentix-e/db-cluster',
    expect: ['RaftAdapter', 'NotARealExport'],
    behaviour: () => undefined,
  },
];
