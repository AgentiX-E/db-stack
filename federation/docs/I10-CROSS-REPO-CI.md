# I10 — Cross-Repo CI/CD Pipeline

## Overview

Orchestrates the three-repo dependency chain with automatic change
detection, cross-repo E2E integration tests, and merged coverage
dashboard.

```
db-cluster ──→ db-federation ──→ db-operations
   (leaf)         (mid)            (leaf)
     │               │                 │
     └─── cross-repo E2E tests ───────┘
```

## Components

### 1. GitHub Actions: `cross-repo-ci.yml`

- **detect-changes**: Analyses changed paths, determines full chain needs
- **cluster-quality / federation-quality / operations-quality**: Reuses
  each repo's `_quality.yml` (lint + build + test + coverage)
- **cross-repo-e2e**: Runs `cross-repo-end-to-end.test.ts` in db-federation
  after all three repos build successfully
- **coverage-dashboard**: Generates merged coverage report
- **summary**: Posts PR comment with pass/fail table

### 2. Local Hooks: `scripts/`

#### pre-push.sh
Runs affected-repo CI before push. Automatically detects changed repos
and expands to downstream dependents:

```bash
# Install (manual — git hooks are opt-in):
cp scripts/pre-push.sh .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

#### post-merge.sh
Auto-installs node_modules when package.json changes after pull/merge:

```bash
cp scripts/post-merge.sh .git/hooks/post-merge
chmod +x .git/hooks/post-merge
```

### 3. `.gitignore`
Excludes CI artifacts: `merged-coverage/`, `test-results/`,
`cross-repo-e2e-results/`, `coverage-dashboard/`.

## Invariants Validated

| ID | Description | Validation Method |
|----|-------------|-------------------|
| CR11 | db-cluster changes trigger federation E2E | Change detection in `detect-changes` |
| CR12 | Federation changes trigger operations chain | Dependency expansion in `pre-push.sh` |
| CR13 | Full chain completes within 60 min | `timeout-minutes: 45` + 15 dashboard |
| CR14 | Coverage merged report as artifact | `coverage-dashboard` job |
| CR15 | Pre-push blocks if any affected CI fails | `pre-push.sh` exit code |
| CR16 | Cross-repo E2E on cluster/federation change | `cross-repo-e2e` needs condition |

## Dependency Order

1. `db-cluster` — builds first (no deps)
2. `db-federation` — needs db-cluster built (uses `@agentix-e/db-cluster`)
3. `db-operations` — needs federation built (uses `@agentix-e/db-operations`)
4. Cross-repo E2E — needs all three built
5. Coverage Dashboard — needs all three coverage reports
