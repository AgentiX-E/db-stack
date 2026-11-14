# Architecture

## Position in the Framework

The auth package is a **pure-interface boundary** — it defines the security and identity contracts without providing implementations. Concrete implementations live in `@agentix-e/db-operations-security` (TLS, RBAC, Encryption, Rate Limiting, SCIM) and `@agentix-e/db-operations-audit` (Audit Store).

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-auth                      │
│  ┌────────────┐ ┌────────────┐ ┌───────────────────┐    │
│  │ IAuth      │ │ IRBAC      │ │ ITLSManager       │    │
│  │ Provider   │ │ Provider   │ │                   │    │
│  └────────────┘ └────────────┘ └───────────────────┘    │
│  ┌────────────┐ ┌────────────┐ ┌───────────────────┐    │
│  │ IAudit     │ │ IRate      │ │ IEncryption       │    │
│  │ Store      │ │ Limiter    │ │ Manager           │    │
│  └────────────┘ └────────────┘ └───────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │            ISCIMSyncProvider                     │    │
│  └─────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│         @agentix-e/db-operations-security                │
│         @agentix-e/db-operations-audit                   │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Separation of contracts and implementations** — Interfaces live in `auth`, implementations in `security` and `audit`. This allows consumers to depend only on interfaces and swap implementations at configuration time.

2. **Audit-first security** — Every security decision (access denied, token validated, role assigned) should produce an audit event. The auth patterns encourage this composition.

3. **Sprint 1.2 extensions** — The package extended from basic auth/RBAC to include rate limiting, encryption, and SCIM synchronization for multi-tenant and enterprise deployments.
