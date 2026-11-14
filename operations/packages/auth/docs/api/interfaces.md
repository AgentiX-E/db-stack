# Auth Package API

## Interfaces (Type-Only)

### `IRBACProvider`

| Method | Return |
|---|---|
| `checkPermission(role, action, resource)` | `Promise<boolean>` |
| `assignRole(userId, role)` | `Promise<void>` |
| `revokeRole(userId, role)` | `Promise<void>` |
| `getUserRoles(userId)` | `Promise<string[]>` |

### `IAuthProvider`

| Method | Return |
|---|---|
| `authenticate(username, password)` | `Promise<{ token, expiresAt }>` |
| `validateToken(token)` | `Promise<{ userId, roles }>` |
| `revokeToken(token)` | `Promise<void>` |

### `ITLSManager`

| Method | Return |
|---|---|
| `getConfig()` | `Promise<{ cert, key, ca? }>` |
| `rotateCertificates(newCert, newKey)` | `Promise<void>` |
| `validateExpiration()` | `Promise<{ valid, daysRemaining }>` |

### `IAuditStore`

| Method | Return |
|---|---|
| `record(event)` | `Promise<void>` |
| `query(filters)` | `Promise<AuditEvent[]>` |
| `export(startDate, endDate)` | `Promise<AuditEvent[]>` |

### `IRateLimiter`

| Method | Return |
|---|---|
| `check(key, cost?)` | `Promise<{ allowed, remaining, resetAt }>` |

### `IEncryptionManager`

| Method | Return |
|---|---|
| `encrypt(plaintext, keyId)` | `Promise<string>` |
| `decrypt(ciphertext)` | `Promise<string>` |
| `generateKey(keyId)` | `Promise<void>` |
| `rotateKey(keyId)` | `Promise<void>` |
| `listKeys()` | `Promise<string[]>` |

## Types

- **`AuditEvent`** — `{ timestamp, userId, action, resource, result, details? }`
- **`AuditQuery`** — `{ userId?, action?, resource?, startDate?, endDate?, limit?, offset? }`
- **`ISCIMUser`** — `{ id, userName, displayName, emails[], active, roles[] }`
- **`IBottleneckConfig`** — `{ maxTokens, refillRate, refillIntervalMs }`

## Notes

This package exports **interfaces only** (no implementations). See `@agentix-e/db-operations-security` and `@agentix-e/db-operations-audit` for implementations.
