#!/usr/bin/env bash
# I10 — Pre-push: Run affected repo tests before pushing.
#
# Detects which repos changed and runs their CI scripts.
# Skips if no db-* repos changed.
#
# Invariants:
#   CR15 — Pre-push blocks if any affected repo CI fails
#   CR16 — Cross-repo E2E runs when db-cluster or db-federation changes

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

changed_repos=()

while IFS= read -r file; do
  case "$file" in
    db-cluster/*)   changed_repos+=("db-cluster") ;;
    db-federation/*) changed_repos+=("db-federation") ;;
    db-operations/*) changed_repos+=("db-operations") ;;
  esac
done < <(git diff --cached --name-only HEAD 2>/dev/null || true)

# Deduplicate
mapfile -t changed_repos < <(printf '%s\n' "${changed_repos[@]}" | sort -u)

if [ ${#changed_repos[@]} -eq 0 ]; then
  echo -e "${GREEN}[pre-push] No db-* repos changed. Skipping CI.${NC}"
  exit 0
fi

echo -e "${YELLOW}[pre-push] Changed repos: ${changed_repos[*]}${NC}"

# Build dependency-ordered test list
# db-cluster must build first (no deps), then federation, then operations
run_list=()
for repo in "db-cluster" "db-federation" "db-operations"; do
  if printf '%s\n' "${changed_repos[@]}" | grep -qx "$repo"; then
    run_list+=("$repo")
  fi
done

# If cross-deps are affected, add downstream repos
if printf '%s\n' "${run_list[@]}" | grep -qx "db-cluster"; then
  printf '%s\n' "${run_list[@]}" | grep -qx "db-federation" || run_list+=("db-federation")
fi
if printf '%s\n' "${run_list[@]}" | grep -qx "db-federation" || printf '%s\n' "${run_list[@]}" | grep -qx "db-cluster"; then
  printf '%s\n' "${run_list[@]}" | grep -qx "db-operations" || run_list+=("db-operations")
fi

echo -e "${YELLOW}[pre-push] Test chain: ${run_list[*]}${NC}"

failed=()
for repo in "${run_list[@]}"; do
  echo -e "\n${YELLOW}[pre-push] ▸ $repo — running CI...${NC}"
  (
    cd "$repo"
    npm run ci 2>&1 | tail -5
  ) && echo -e "${GREEN}[pre-push] ✓ $repo passed${NC}" || {
    echo -e "${RED}[pre-push] ✗ $repo FAILED${NC}"
    failed+=("$repo")
  }
done

if [ ${#failed[@]} -gt 0 ]; then
  echo -e "\n${RED}[pre-push] ✗ FAILED repos: ${failed[*]}${NC}"
  echo -e "${RED}[pre-push] Push blocked. Fix failures and retry.${NC}"
  exit 1
fi

echo -e "\n${GREEN}[pre-push] ✓ All repos passed. Proceed with push.${NC}"
