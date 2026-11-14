#!/bin/bash
# Run all test files in 3 batches to avoid worker OOM on Node 24.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BATCH1="packages/audit/src/__tests__/*.test.ts packages/auth/src/__tests__/*.test.ts packages/autoscaler/src/__tests__/*.test.ts packages/autotuner/src/__tests__/*.test.ts packages/backup/src/__tests__/*.test.ts packages/circuitbreaker/src/__tests__/*.test.ts packages/core/src/__tests__/{provider,integration-edge,fuzz-leak,observability-e2e,perf-benchmarks}.test.ts"
BATCH2="packages/federation/src/__tests__/*.test.ts packages/health/src/__tests__/*.test.ts packages/logger/src/__tests__/*.test.ts packages/memoryguard/src/__tests__/*.test.ts packages/metrics/src/__tests__/*.test.ts packages/otel/src/__tests__/*.test.ts packages/rollingupgrade/src/__tests__/*.test.ts packages/scheduler/src/__tests__/*.test.ts packages/slacollector/src/__tests__/*.test.ts"
BATCH3="packages/maintenance/src/__tests__/*.test.ts packages/monitor/src/__tests__/*.test.ts packages/observability/src/__tests__/*.test.ts packages/security/src/__tests__/*.test.ts"

PASS=0
FAIL=0
TOTAL_TESTS=0

for batch_num in 1 2 3; do
  eval "files=\$BATCH$batch_num"
  echo "═══ BATCH $batch_num ═══"
  rm -rf node_modules/.vitest node_modules/.vite
  out=$(npx vitest run $files 2>&1)
  echo "$out" | grep -E "Test Files|Tests " | tail -2
  if echo "$out" | grep -q "Test Files.*0 failed"; then
    echo "  ✅ PASS"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAILURES"
    FAIL=$((FAIL + 1))
    echo "$out" | grep "FAIL " | head -5
  fi
  total=$(echo "$out" | grep "^Tests " | grep -oP '\d+(?= passed)' | head -1 || echo 0)
  TOTAL_TESTS=$((TOTAL_TESTS + total))
  echo ""
done

echo "═══ SUMMARY ═══"
echo "Batches: $PASS passed / $((PASS + FAIL)) total"
echo "Approx total tests: $TOTAL_TESTS"
