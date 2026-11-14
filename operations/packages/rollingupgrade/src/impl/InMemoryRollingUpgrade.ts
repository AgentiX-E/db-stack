import type { IRollingUpgrade } from '../interfaces/index.js';
import { RollingUpgradeOrchestrator } from './RollingUpgradeOrchestrator.js';

/**
 * In-memory rolling upgrade implementation.
 *
 * This is a thin alias over {@link RollingUpgradeOrchestrator}: the
 * orchestrator itself is already a fully self-contained in-memory engine with
 * no external dependencies, so a dedicated in-memory implementation is
 * redundant. Subclassing keeps the public `InMemoryRollingUpgrade` export
 * stable while sharing a single, well-tested implementation.
 *
 * @module @agentix-e/db-operations-rollingupgrade/impl
 */
export class InMemoryRollingUpgrade
  extends RollingUpgradeOrchestrator
  implements IRollingUpgrade {}
