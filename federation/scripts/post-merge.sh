#!/usr/bin/env bash
# I10 — Post-merge: Auto-install dependencies for changed repos.
#
# Runs after `git pull` or `git merge` to ensure node_modules
# are up-to-date in repos whose package.json changed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
NC='\033[0m'

changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)

for repo in db-cluster db-federation db-operations; do
  if echo "$changed" | grep -q "^${repo}/package"; then
    echo -e "${GREEN}[post-merge] ▸ $repo — reinstalling deps...${NC}"
    (cd "$repo" && npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts) || true
  fi
done
