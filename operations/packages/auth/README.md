# @agentix-e/db-operations-auth

**Authentication, authorization (RBAC), TLS management, and audit store interfaces for database engine operations.**

This package defines the identity and access control abstraction layers: authenticating users, checking role-based permissions, managing TLS certificates, and recording audit events. All types are interface-only — concrete implementations live in `@agentix-e/db-operations-security` and `@agentix-e/db-operations-audit`.

> **Note:** This package currently exports only **type definitions** (interfaces). No implementation classes are included. For implementations, see `@agentix-e/db-operations-security` and `@agentix-e/db-operations-audit`.

---

## Features

- **Authentication** — `IAuthProvider` with token-based auth (validate, revoke, expire)
- **Role-Based Access Control** — `IRBACProvider` with role assignment and permission checks
- **TLS certificate management** — `ITLSManager` for cert rotation and expiration validation
- **Audit event recording** — `IAuditStore` for recording and querying audit events
- **Rate limiting** — `IRateLimiter` with token-bucket semantics
- **Encryption management** — `IEncryptionManager` for key lifecycle management
- **SCIM sync** — `ISCIMSyncProvider` for identity provider synchronization

---

## Installation

```bash
npm install @agentix-e/db-operations-auth
```

---

## Quick Start

```typescript
import type {
  IAuthProvider,
  IRBACProvider,
  ITLSManager,
  IAuditStore,
  IRateLimiter,
} from '@agentix-e/db-operations-auth';

// This package exports only types — use implementations from
// @agentix-e/db-operations-security or @agentix-e/db-operations-audit
```

---

## API Reference

### Interfaces

#### `IAuthProvider`

| Method | Return | Description |
|---|---|---|
| `authenticate(username, password)` | `Promise<{ token, expiresAt }>` | Authenticate and return a token |
| `validateToken(token)` | `Promise<{ userId, roles }>` | Validate token and return user info |
| `revokeToken(token)` | `Promise<void>` | Revoke a token |

#### `IRBACProvider`

| Method | Return | Description |
|---|---|---|
| `checkPermission(role, action, resource)` | `Promise<boolean>` | Check role permission |
| `assignRole(userId, role)` | `Promise<void>` | Assign role to user |
| `revokeRole(userId, role)` | `Promise<void>` | Revoke role from user |
| `getUserRoles(userId)` | `Promise<string[]>` | List user's roles |

#### `ITLSManager`

| Method | Return | Description |
|---|---|---|
| `getConfig()` | `Promise<{ cert, key, ca? }>` | Get TLS config |
| `rotateCertificates(newCert, newKey)` | `Promise<void>` | Rotate TLS certificates |
| `validateExpiration()` | `Promise<{ valid, daysRemaining }>` | Validate cert expiration |

#### `IAuditStore`

| Method | Return | Description |
|---|---|---|
| `record(event)` | `Promise<void>` | Record an audit event |
| `query(filters)` | `Promise<AuditEvent[]>` | Query audit events |
| `export(startDate, endDate)` | `Promise<AuditEvent[]>` | Export audit log for compliance |

#### `IRateLimiter`

| Method | Return | Description |
|---|---|---|
| `check(key, cost?)` | `Promise<{ allowed, remaining, resetAt }>` | Check if request is allowed |

#### `IEncryptionManager`

| Method | Return | Description |
|---|---|---|
| `encrypt(plaintext, keyId)` | `Promise<string>` | Encrypt plaintext |
| `decrypt(ciphertext)` | `Promise<string>` | Decrypt ciphertext |
| `generateKey(keyId)` | `Promise<void>` | Generate new encryption key |
| `rotateKey(keyId)` | `Promise<void>` | Rotate key (new version) |
| `listKeys()` | `Promise<string[]>` | List all key identifiers |

#### `ISCIMSyncProvider`

| Method | Return | Description |
|---|---|---|
| `createUser(user)` | `Promise<ISCIMUser>` | Create user in IdP |
| `updateUser(user)` | `Promise<ISCIMUser>` | Update user in IdP |
| `deleteUser(userId)` | `Promise<void>` | Delete user from IdP |
| `listUsers()` | `Promise<ISCIMUser[]>` | List all users from IdP |
| `syncAll()` | `Promise<{ created, updated, deleted }>` | Full synchronization |

### Types

| Type | Fields |
|---|---|
| `AuditEvent` | `timestamp, userId, action, resource, result, details?` |
| `AuditQuery` | `userId?, action?, resource?, startDate?, endDate?, limit?, offset?` |
| `ISCIMUser` | `id, userName, displayName, emails[], active, roles[]` |

---

## Usage Examples

### Type-Only Import Pattern

```typescript
import type { IAuthProvider } from '@agentix-e/db-operations-auth';
// Use implementations from @agentix-e/db-operations-security
```

### Defining a Service Dependence on Auth

```typescript
import type { IRBACProvider, IAuthProvider, IAuditStore } from '@agentix-e/db-operations-auth';

class SecureService {
  constructor(
    private auth: IAuthProvider,
    private rbac: IRBACProvider,
    private audit: IAuditStore,
  ) {}

  async processRequest(username: string, password: string, action: string, resource: string) {
    // 1. Authenticate
    const { token } = await this.auth.authenticate(username, password);

    // 2. Authorize
    const { roles } = await this.auth.validateToken(token);
    const hasPermission = await this.rbac.checkPermission(roles[0], action, resource);
    if (!hasPermission) {
      await this.audit.record({
        timestamp: new Date(),
        userId: username,
        action,
        resource,
        result: 'failure',
      });
      throw new Error('Access denied');
    }

    // 3. Audit
    await this.audit.record({
      timestamp: new Date(),
      userId: username,
      action,
      resource,
      result: 'success',
    });

    return true;
  }
}
```

---

## Testing

```bash
cd packages/auth
npm test
npm run test:watch
```

---

## Dependencies

- `pino` (`^9.0.0`) — Logging
