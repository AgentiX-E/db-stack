/**
 * The composition root for the cross-datacenter pipeline.
 *
 * `ExactlyOnceCDCPipeline` accepts a default `CDCEngine` on purpose: dozens of
 * unit tests drive its outbox, dedup and acknowledgement logic with the
 * simulator's `appendChange` hook, and requiring a real WAL to test a dedup ring
 * would test the wrong thing. A permissive class under test and a permissive
 * product entry point are not the same decision, though. A deployment that
 * forgets to pass an engine used to get a pipeline that reported success while
 * reading from nothing — F-09. This factory is the one place that turns the
 * permissive class into an honest product: it refuses a simulated source by
 * name unless the caller explicitly says it knows it is running the simulator.
 *
 * The refusal is capability-based, not `instanceof`. The property that makes a
 * source a test double is the `appendChange` hook — the ability to invent a
 * change rather than observe one — no matter which class carries it. Binding to
 * `CDCEngine` would let a foreign simulator through and reject a future
 * real engine that happens to share no ancestry, which is the opposite of
 * engine-agnostic.
 */

import { ExactlyOnceCDCPipeline } from '../replication/ExactlyOnceCDCPipeline';
import type { ExactlyOnceCDCPipelineConfig } from '../replication/ExactlyOnceCDCPipeline';
import type { ICDCEngine } from '../interfaces/replication/ICDCManager';

/** The capability that makes a CDC source a simulator: it can invent changes. */
const SIMULATOR_HOOK = 'appendChange';

/** Config at the product boundary: the pipeline's plus the explicit consent. */
export interface CreateCDCPipelineConfig extends ExactlyOnceCDCPipelineConfig {
  /**
   * Admit a simulated change source. Required when `engine` is omitted (which
   * selects the built-in `CDCEngine`) or when an engine carries the `appendChange`
   * test hook. Receive-only nodes — which produce no changes and only dedup
   * inbound ones — pass this deliberately. A producer never should.
   */
  allowSimulated?: boolean;
}

/** Why a composition-root pipeline was refused. */
export class SimulatedEngineError extends Error {
  readonly component = 'ExactlyOnceCDCPipeline';
  readonly engineName: string;

  constructor(engineName: string) {
    super(
      `${'ExactlyOnceCDCPipeline'}: a simulated change source (${engineName}) cannot be ` +
        `used at the composition root; pass a real ICDCEngine or set allowSimulated: true ` +
        `if this node is receive-only`,
    );
    this.name = 'SimulatedEngineError';
    this.engineName = engineName;
  }
}

/**
 * True when a source carries the simulator's change-injection hook.
 *
 * Accepts an unknown value so the guard can inspect a source before trusting
 * its type: a malformed engine is not a capability, it is absent one.
 */
export function isSimulatedCapability(engine: unknown): boolean {
  if (engine === null || (typeof engine !== 'object' && typeof engine !== 'function')) {
    return false;
  }
  return typeof (engine as Record<string, unknown>)[SIMULATOR_HOOK] === 'function';
}

function nameOf(engine: unknown): string {
  // Only two inputs reach here: an omitted engine (the built-in simulator) or
  // an object that carries the hook. A null or primitive cannot be simulated,
  // so naming one would be a branch no caller can reach.
  if (engine === undefined) return 'CDCEngine';
  const ctor = (engine as { constructor?: { name?: string } }).constructor;
  // `String(engine)` throws on a null-prototype object (no toString): the path
  // whose job is to produce a readable error must not itself throw.
  return ctor?.name ?? Object.prototype.toString.call(engine);
}

/**
 * Assemble the pipeline a product actually runs.
 *
 * Refuses a simulated source synchronously, at construction, before `start()`
 * can install a pump over a stream nothing writes. A real engine — any engine,
 * from any package, that does not carry the simulator hook — is passed through
 * untouched, so the middleware stays engine-agnostic.
 */
export function createCDCPipeline(config: CreateCDCPipelineConfig): ExactlyOnceCDCPipeline {
  const engine: ICDCEngine | undefined = config.engine;
  // Absent engine selects the built-in simulator, so it must be named as one.
  const simulated = engine === undefined || isSimulatedCapability(engine);
  if (simulated && config.allowSimulated !== true) {
    throw new SimulatedEngineError(nameOf(engine));
  }
  const { allowSimulated: _allowSimulated, ...pipelineConfig } = config;
  return new ExactlyOnceCDCPipeline(pipelineConfig);
}
