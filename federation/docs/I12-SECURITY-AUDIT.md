# I12 — Security Audit Pipeline

## Overview

Unified security scanning across all three AgentiX-E repositories, enforcing
supply-chain integrity, secret hygiene, and license compliance on every PR.

## Architecture

```
ci.yml (per repo)
  │
  ├─ security ──→ _security.yml (reusable)
  │                ├─ dependency-audit    (npm audit + signatures)
  │                ├─ secret-scan         (git-secrets pattern scan)
  │                └─ license-check       (OSI compliance)
  │
  ├─ quality ───→ _quality.yml  (needs: [security])
  │
  └─ publish ─── (needs: [security, quality])
```

## Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| SEC1 | Zero critical CVEs in production deps | `npm audit --audit-level=high` |
| SEC2 | Zero hardcoded secrets in committed code | git-secrets pattern scan |
| SEC3 | All production deps have OSI-approved licenses | license-checker |

## Workflows Added

| File | Purpose |
|------|---------|
| `.github/workflows/_security.yml` | Reusable security workflow (3 jobs) |
| `.github/workflows/ci.yml` (updated) | Integrated `security → quality → publish` chain |
| `SECURITY.md` | Vulnerability disclosure policy |
| `.gitignore` (db-cluster updated) | Added `.env`/`.pem`/credential patterns |

## Local Audit

```bash
# Dependency audit
npm audit --production && npm audit signatures

# Secret scan (manual)
git log -p | grep -E 'sk-[a-zA-Z0-9]{32,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}'

# License check
npx license-checker --production --onlyAllow \
  'MIT;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause;Unlicense;MPL-2.0'
```

## Repository Coverage

| Repository | _security.yml | ci.yml updated | SECURITY.md | .gitignore env |
|------------|:-------------:|:--------------:|:-----------:|:--------------:|
| db-federation | ✅ | ✅ | ✅ | ✅ |
| db-cluster | ✅ | ✅ | — | ✅ (fixed) |
| db-operations | ✅ | ✅ | — | ✅ |
