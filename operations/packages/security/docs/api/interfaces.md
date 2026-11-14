# Security Package API

## Interfaces

### `ITLSManager`

| Method | Return |
|---|---|
| `loadConfig(config)` | `Promise<void>` |
| `getCertInfo()` | `Promise<CertInfo>` |
| `reloadCerts()` | `Promise<void>` |

### `ICertMonitor`

| Method | Return |
|---|---|
| `start(intervalMs)` | `void` |
| `stop()` | `void` |
| `getExpiryStatus()` | `Array<{ cert, level }>` |
| `onWarning(cb)` | `() => void` (unsub fn) |
| `autoRenew()` | `Promise<boolean>` |

### `IEncryptionManager`

| Method | Return |
|---|---|
| `initialize(config)` | `Promise<void>` |
| `encrypt(plaintext, context?)` | `Promise<Buffer>` |
| `decrypt(ciphertext, context?)` | `Promise<Buffer>` |
| `rotateKey()` | `Promise<void>` |
| `isEnabled()` | `boolean` |

### `IRBACProvider`

| Method | Return |
|---|---|
| `hasPermission(identity, permission)` | `boolean` |
| `getPermissions(identity)` | `Permission[]` |
| `registerRole(role)` | `void` |
| `getRoles()` | `Role[]` |

### `IRateLimiter`

| Method | Return |
|---|---|
| `check(key, config?)` | `{ allowed, remaining, resetMs }` |
| `reset(key)` | `void` |

### `ISCIMSyncProvider`

| Method | Return |
|---|---|
| `syncUsers()` | `Promise<{ added, updated, removed }>` |
| `getLastSyncTime()` | `Date \| null` |
| `fullResync()` | `Promise<void>` |

### `ISecurityCompliance`

| Method | Return |
|---|---|
| `runChecks()` | `Promise<SecurityCheck[]>` |
| `runCategory(category)` | `Promise<SecurityCheck[]>` |
| `getScore()` | `number` |

## Implementations

- **`InMemoryTLSManager`** — Mock cert info with configurable validity
- **`InMemoryCertMonitor`** — `setInterval`-based monitoring with callback registration
- **`InMemoryEncryptionManager`** — XOR-based encryption with key versioning
- **`InMemoryRBACProvider`** — Full role-permission matrix
- **`InMemoryRateLimiter`** — Fixed-window rate limiter
- **`InMemorySCIMSyncProvider`** — Simulated IdP sync
- **`InMemorySecurityCompliance`** — Register checks and evaluate
