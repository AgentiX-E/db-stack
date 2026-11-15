/**
 * Ambient declarations needed only by the test program.
 *
 * `tsconfig.test.json` extends `tsconfig.json`, whose `paths` map `@agentix-e/db-cluster`
 * to the cluster *sources*, so this program typechecks cluster's
 * `consensus/opt/CircuitBreaker.ts` and therefore its `import ... from 'opossum'`.
 * Cluster ships the declaration for that dependency (`consensus/opt/opossum.d.ts`) and
 * picks it up through its own `include`; the paths mapping does not carry `include`s
 * across packages, so the same declaration has to be referenced here. Referencing it
 * keeps a single copy of the types instead of re-declaring the module.
 */
/// <reference path="../../../cluster/src/consensus/opt/opossum.d.ts" />
