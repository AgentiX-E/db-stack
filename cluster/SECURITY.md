# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue.** Instead, send details to:

- Email: security@agentix-e.ai
- Or use GitHub's [private vulnerability reporting](https://github.com/AgentiX-E/db-cluster/security/advisories/new)

### What to include

1. Affected component(s) and version
2. Steps to reproduce
3. Impact assessment (confidentiality / integrity / availability)
4. Any suggested fixes (optional)

### Response timeline

| Phase | Target |
|-------|--------|
| Acknowledge | within 48 hours |
| Triage and confirm | within 5 business days |
| Patch release | within 30 days (critical: 7 days) |

## Scope

This policy covers all three AgentiX-E database repositories:

- [db-cluster](https://github.com/AgentiX-E/db-cluster) — Raft-based distributed consensus
- [db-cluster](https://github.com/AgentiX-E/db-cluster) — Cross-cluster federation and replication
- [db-operations](https://github.com/AgentiX-E/db-operations) — Backup, audit, and operational tooling

## Security Controls

| Control | Status |
|---------|--------|
| Dependabot (npm + Actions) | ✅ Active |
| npm audit in CI | ✅ Enforced per PR |
| Secret scanning | ✅ Commit-level pattern scan |
| License compliance | ✅ OSI-only production deps |
| CodeQL analysis | 🔜 Planned |
| SBOM generation | 🔜 Planned |

## Disclosure Policy

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
Security advisories are published on GitHub after a patch is available.

## Recognition

We maintain a hall of fame for security researchers who responsibly disclose vulnerabilities.
Names are added to `SECURITY-HOF.md` with consent.
