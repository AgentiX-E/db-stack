# @agentix-e/db-operations-security

**Security implementations for db-operations: TLS management, certificate monitoring, encryption, RBAC, rate limiting, SCIM sync, and security compliance checks.**

This package provides concrete implementations for all security interfaces defined in `@agentix-e/db-operations-auth`. Each component works in-memory, making it suitable for both production use (with real data) and testing (with full state inspection).

---

## Features

- **TLS Manager** — Load, inspect, and reload TLS certificates with in-memory simulation
- **Certificate Monitor** — Periodic expiry monitoring with callback-based warnings and auto-renewal
- **Encryption Manager** — AES-256-GCM/ChaCha20-Poly1305 XOR-based encryption with key versioning and rotation
- **RBAC Provider** — Role-permission matrix with role registration and multi-role identity evaluation
- **Rate Limiter** — Sliding-window token bucket with configurable max requests and window
- **SCIM Sync Provider** — Simulated identity provider synchronization with user management
- **Security Compliance** — Multi-category security checks with pass/warn/fail evaluation and scoring

---

## Installation

```bash
npm install @agentix-e/db-operations-security
```

---

## Quick Start

```typescript
import {
  InMemoryTLSManager,
  InMemoryRBACProvider,
  InMemoryRateLimiter,
  InMemoryEncryptionManager,
} from '@agentix-e/db-operations-security';

// RBAC
const rbac = new InMemoryRBACProvider();
rbac.registerRole({ name: 'admin', permissions: [{ resource: '*', action: 'admin' }] });

const identity = { id: 'user-1', roles: ['admin'] };
console.log(rbac.hasPermission(identity, { resource: 'users', action: 'delete' })); // true

// Rate Limiting
const limiter = new InMemoryRateLimiter();
const result = limiter.check('/api/login', { maxRequests: 5, windowMs: 60000 });
console.log(result.allowed); // true

// Encryption
const enc = new InMemoryEncryptionManager();
await enc.initialize({ algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2' });
const ciphertext = await enc.encrypt(Buffer.from('secret-data'));
const plaintext = await enc.decrypt(ciphertext);
console.log(plaintext.toString()); // 'secret-data'
```

---

## API Reference

### Interfaces

#### `ITLSManager`

| Method | Return | Description |
|---|---|---|
| `loadConfig(config)` | `Promise<void>` | Load and validate certificates |
| `getCertInfo()` | `Promise<CertInfo>` | Get current certificate info |
| `reloadCerts()` | `Promise<void>` | Hot-reload certificates from disk |

#### `ICertMonitor`

| Method | Return | Description |
|---|---|---|
| `start(intervalMs)` | `void` | Start periodic monitoring |
| `stop()` | `void` | Stop monitoring |
| `getExpiryStatus()` | `Array<{ cert, level }>` | Get expiry status for all certs |
| `onWarning(cb)` | `() => void` | Register expiry callback (returns unsub fn) |
| `autoRenew()` | `Promise<boolean>` | Attempt automatic renewal |

#### `IEncryptionManager`

| Method | Return | Description |
|---|---|---|
| `initialize(config)` | `Promise<void>` | Initialize with config |
| `encrypt(plaintext, context?)` | `Promise<Buffer>` | Encrypt data at rest |
| `decrypt(ciphertext, context?)` | `Promise<Buffer>` | Decrypt data at rest |
| `rotateKey()` | `Promise<void>` | Rotate encryption key |
| `isEnabled()` | `boolean` | Check if initialized |

#### `IRBACProvider`

| Method | Return | Description |
|---|---|---|
| `hasPermission(identity, permission)` | `boolean` | Check permission |
| `getPermissions(identity)` | `Permission[]` | Get all permissions |
| `registerRole(role)` | `void` | Register/update a role |
| `getRoles()` | `Role[]` | Get all registered roles |

#### `IRateLimiter`

| Method | Return | Description |
|---|---|---|
| `check(key, config?)` | `{ allowed, remaining, resetMs }` | Check if request is allowed |
| `reset(key)` | `void` | Reset tracking for a key |

#### `ISCIMSyncProvider`

| Method | Return | Description |
|---|---|---|
| `syncUsers()` | `Promise<{ added, updated, removed }>` | Sync users from IdP |
| `getLastSyncTime()` | `Date \| null` | Get last sync timestamp |
| `fullResync()` | `Promise<void>` | Trigger full resync |

#### `ISecurityCompliance`

| Method | Return | Description |
|---|---|---|
| `runChecks()` | `Promise<SecurityCheck[]>` | Run all security checks |
| `runCategory(category)` | `Promise<SecurityCheck[]>` | Run checks in a category |
| `getScore()` | `number` | Get overall compliance score (0–100) |

### Types

| Type | Fields |
|---|---|
| `TLSConfig` | `certPath, keyPath, caPath?` |
| `EncryptionConfig` | `algorithm: 'aes-256-gcm' | 'chacha20-poly1305', keyDerivation: 'pbkdf2' | 'argon2'` |
| `Permission` | `resource, action: 'create' | 'read' | 'update' | 'delete' | 'admin'` |
| `Role` | `name, permissions[]` |
| `Identity` | `id, roles[], attributes?` |
| `RateLimitConfig` | `maxRequests, windowMs` |

---

## Implementations

### `InMemoryTLSManager`

Simulates certificate loading. Holds config and returns mock `CertInfo` with 30/60-day validity windows.

### `InMemoryCertMonitor`

Uses `setInterval` for periodic checks. Walks expiry entries and calls warning callbacks when level is not `'ok'`. Auto-renewal always returns `true` (simulated).

- `addExpiryStatus(cert, level)` — Test helper to pre-populate expiry status

### `InMemoryEncryptionManager`

Uses XOR-based encryption with a random 32-byte key. Supports key rotation (generates new key, increments version). Not cryptographically secure — use for testing only. For production, use a proper crypto library.

### `InMemoryRBACProvider`

Full role-permission matrix. Supports multi-role identity evaluation. Permission lookup iterates all roles of an identity and checks against registered permissions.

### `InMemoryRateLimiter`

Fixed-window rate limiter (resets when window expires). Default: 10 requests per 60 seconds.

### `InMemorySCIMSyncProvider`

Simulated sync: first call returns 3 users added, subsequent calls return 3 users updated. Supports full resync.

### `InMemorySecurityCompliance`

Compliance checks registered via `registerChecks()`. Score calculation: PASS=1 point, WARN=0.5, FAIL=0. Score = (sum / total) * 100. Empty checks = perfect score of 100.

---

## Usage Examples

### TLS Certificate Monitoring

```typescript
import { InMemoryTLSManager, InMemoryCertMonitor } from '@agentix-e/db-operations-security';

const tls = new InMemoryTLSManager();
await tls.loadConfig({ certPath: '/etc/certs/server.crt', keyPath: '/etc/certs/server.key' });

const info = await tls.getCertInfo();
console.log(`Certificate: ${info.subject}, expires in ${info.daysRemaining} days`);

// Monitor expiry
const monitor = new InMemoryCertMonitor();
monitor.addExpiryStatus(info, 'warning');
monitor.onWarning((cert, level) => {
  console.log(`⚠️  ${cert.subject}: ${level} (${cert.daysRemaining} days remaining)`);
});
monitor.start(3600000); // check every hour
```

### Security Compliance Checks

```typescript
import { InMemorySecurityCompliance } from '@agentix-e/db-operations-security';

const compliance = new InMemorySecurityCompliance();
compliance.registerChecks([
  { id: 'TLS-01', category: 'tls', description: 'TLS 1.3 enabled', severity: 'PASS', message: 'OK', timestamp: '' },
  { id: 'AUTH-01', category: 'auth', description: 'Rate limiting configured', severity: 'WARN', message: 'Configure rate limits', timestamp: '' },
  { id: 'ENC-01', category: 'encryption', description: 'Data-at-rest encryption', severity: 'FAIL', message: 'Encryption not enabled', timestamp: '' },
]);

const checks = await compliance.runChecks();
const score = compliance.getScore();
console.log(`Compliance score: ${score}/100`);

for (const check of checks) {
  if (check.severity !== 'PASS') {
    console.log(`  [${check.severity}] ${check.description}: ${check.message}`);
  }
}
```

---

## Testing

```bash
cd packages/security
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Provides `CertInfo`, `CertWarningLevel`, `SecurityCheck` types
