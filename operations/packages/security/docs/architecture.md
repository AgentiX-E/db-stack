# Architecture

## Position in the Framework

The security package implements the interfaces defined in `@agentix-e/db-operations-auth`. It builds on `core` for shared security type definitions.

```
┌─────────────────────────────────────────────────────────┐
│               db-operations-security                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐     │
│  │ TLS Mgmt │ │ Cert     │ │ Encryption           │     │
│  │ InMemory │ │ Monitor  │ │ Manager (InMemory)   │     │
│  └──────────┘ └──────────┘ └──────────────────────┘     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐     │
│  │ RBAC     │ │ Rate     │ │ SCIM Sync           │     │
│  │ InMemory │ │ Limiter  │ │ Provider (InMemory)  │     │
│  └──────────┘ └──────────┘ └──────────────────────┘     │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Security Compliance Checker            │    │
│  └─────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
│              @agentix-e/db-operations-auth (interfaces)  │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **In-memory by design** — All security implementations work in-memory, enabling both testing and development without external PKI, LDAP, or encryption hardware.

2. **Composition over configuration** — TLS + CertMonitor together provide a complete certificate lifecycle solution. RBAC + Compliance together provide comprehensive access governance.

3. **Testability** — Every implementation exposes test helpers to set state directly, enabling focused unit tests without complex setup.

## Compliance Scoring

```
getScore():
  total = checks.length
  if total === 0 → return 100

  sum = PASS count * 1 + WARN count * 0.5 + FAIL count * 0
  score = (sum / total) * 100
  return Math.round(score)
```
