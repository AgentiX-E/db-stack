# Testing Strategy

db-operations employs a **7-dimension, industry-grade test framework** with 866 tests across 29 files, all passing in under 3 seconds.

## Dimensions

| # | Dimension | Tests | Verification Goal |
|---|-----------|-------|-------------------|
| 1 | **Unit (Interface Contract)** | 389 | Each InMemory impl satisfies its interface contract (happy path + error cases) |
| 2 | **Cross-Package Integration** | 20 | End-to-end chains tying 2+ packages together |
| 3 | **Edge/Boundary Conditions** | 50 | 12 categories of pathological inputs (NaN, null, empty, self-cycles, etc.) |
| 4 | **Concurrency Safety** | 35 | 100 concurrent operations verifying correctness |
| 5 | **Stress/Pressure** | 5 | 1000-level scale operations |
| 6 | **Fuzz Testing** | ~50 | Random valid+invalid inputs across 11 implementations |
| 7 | **Performance Benchmarks** | 12 | Nanosecond-precision timing with `process.hrtime.bigint()` |

## Test Locations

```
packages/
├── audit/src/__tests__/InMemoryAudit.test.ts          (20)
├── auth/src/__tests__/interfaces.test.ts               (32)
├── backup/src/__tests__/InMemoryBackup.test.ts         (30)
├── core/src/__tests__/
│   ├── provider.test.ts                                (22)
│   ├── integration-edge.test.ts                        (76)  ← dimensions 2+3
│   ├── stress-concurrency.test.ts                      (35)  ← dimensions 4+5
│   ├── fuzz-leak.test.ts                               (~50) ← dimension 6
│   └── perf-benchmarks.test.ts                         (12)  ← dimension 7
├── health/src/__tests__/HealthOrchestrator.test.ts     (23)
├── logger/src/__tests__/InMemoryLogger.test.ts         (19)
├── maintenance/src/__tests__/
│   ├── InMemoryMaintenanceExecutor.test.ts              (29)
│   └── NoopMaintenanceExecutor.test.ts                  (11)
├── metrics/src/__tests__/MetricsRegistry.test.ts       (21)
├── monitor/src/__tests__/interfaces.test.ts            (38)
├── observability/src/__tests__/
│   └── InMemoryObservability.test.ts                   (21)
└── security/src/__tests__/InMemorySecurity.test.ts     (42)
```

## Test Principles

### 1. AAA Pattern
Every test follows Arrange-Act-Assert:

```typescript
it('should detect deadlock on 2-node cycle A→B→A', () => {
  // Arrange
  const dd = new InMemoryDeadlockDetector();
  dd.reportLockAcquired('A', 'R1');
  dd.reportLockAcquired('B', 'R2');
  dd.reportLockWait('A', 'R2');
  dd.reportLockWait('B', 'R1');

  // Act
  const victims = dd.detectDeadlocks();

  // Assert
  expect(victims.length).toBe(1);
  expect(['A', 'B']).toContain(victims[0].victimTransactionId);
});
```

### 2. Interface-Only Tests
Tests import from interfaces (not concrete classes), verifying contract compliance:

```typescript
import type { IBackupManager } from '../interfaces/index.js';
import { InMemoryBackupManager } from '../impl/InMemoryBackupManager.js';

function makeBackupManager(): IBackupManager { return new InMemoryBackupManager(); }
```

### 3. Concurrency Tests Use Real Concurrency
```typescript
await Promise.all(Array.from({ length: 100 }, (_, i) => {
  return Promise.resolve().then(() => counter.inc());
}));
expect(counter.getValue()).toBe(100);
```

### 4. Benchmark Tests Use High-Resolution Timing
```typescript
const start = process.hrtime.bigint();
fn();
const end = process.hrtime.bigint();
expect(Number(end - start)).toBeLessThan(maxNs);
```

## Running Tests

```bash
# Full suite
npm test

# Single package
npm test -- packages/core

# Single file
npm test -- packages/core/src/__tests__/provider.test.ts

# Benchmark (integration)
npm test -- packages/core/src/__tests__/perf-benchmarks.test.ts

# With coverage
npx vitest run --coverage
```

## CI Integration

Tests are designed to run in CI with:
- No external services (all InMemory)
- Deterministic output (no flaky tests)
- Fast execution (< 3s full suite)
- Parallel by file
