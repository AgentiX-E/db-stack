// v1 (legacy) — kept for backward compatibility
export type { IChaosEngine } from "./interfaces/index.js";
export type { FaultType, ChaosFault } from "./interfaces/types.js";
export { InMemoryChaosEngine } from "./impl/InMemoryChaosEngine.js";

// v2 — production-grade chaos engine
export type {
  FaultTypeV2,
  ChaosFaultV2,
  ChaosScenario,
  ChaosScenarioStep,
  ChaoticInvariant,
  InvariantCheckResult,
  ScenarioRunResult,
  IChaosTransport,
  ChaosTransportStats,
  IChaoticInvariantChecker,
  IChaosRNG,
  IChaosEngineV2,
} from "./interfaces/v2-types.js";

export { ChaosEngineV2, SeededRNG } from "./impl/ChaosEngineV2.js";
