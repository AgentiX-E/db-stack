/**
 * Engine factories registered for the parameterised E2E suites.
 *
 * Two of the three engines are self-contained (`InMemory`, `GraphVec`). The
 * `SqlVec` engine is a bridge onto the external sqlvec-db adapter bundle; when
 * that checkout is absent the engine is omitted from the registry so the suite
 * skips it with a visible reason instead of failing every case with
 * "Cannot find module".
 *
 * Set `SQLVEC_ADAPTER_DIR` to include it.
 */

import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';
import { GraphVecEngineFactory } from './GraphVecEngineFactory.js';
import { SqlVecEngineFactory, isSqlVecAdapterAvailable } from './SqlVecEngineFactory.js';
import type { EngineFactory } from './EngineFactory.js';

export const IN_MEM_FACTORY = new InMemoryEngineFactory();
export const GRAPH_VEC_FACTORY = new GraphVecEngineFactory();
export const SQL_VEC_FACTORY = new SqlVecEngineFactory();

/** Factories that are actually runnable on this machine. */
export const ENGINE_FACTORIES: EngineFactory[] = isSqlVecAdapterAvailable()
  ? [IN_MEM_FACTORY, SQL_VEC_FACTORY, GRAPH_VEC_FACTORY]
  : [IN_MEM_FACTORY, GRAPH_VEC_FACTORY];

/** `describe.each` payload: engine name plus its factory instance. */
export const ENGINE_CASES: Array<{ name: string; factory: EngineFactory }> = [
  { name: 'InMemory', factory: IN_MEM_FACTORY },
  ...(isSqlVecAdapterAvailable() ? [{ name: 'SqlVec', factory: SQL_VEC_FACTORY }] : []),
  { name: 'GraphVec', factory: GRAPH_VEC_FACTORY },
];
