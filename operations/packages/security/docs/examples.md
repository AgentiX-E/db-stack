# Examples

## Complete Auth Integration

```typescript
import {
  InMemoryTLSManager,
  InMemoryRBACProvider,
  InMemoryEncryptionManager,
  InMemoryRateLimiter,
} from '@agentix-e/db-operations-security';

class SecureEngine {
  readonly tls = new InMemoryTLSManager();
  readonly rbac = new InMemoryRBACProvider();
  readonly encryption = new InMemoryEncryptionManager();
  readonly rateLimiter = new InMemoryRateLimiter();

  async initialize() {
    // Load TLS
    await this.tls.loadConfig({
      certPath: '/etc/engine/cert.pem',
      keyPath: '/etc/engine/key.pem',
    });

    // Setup encryption
    await this.encryption.initialize({
      algorithm: 'aes-256-gcm',
      keyDerivation: 'pbkdf2',
    });

    // Register roles
    this.rbac.registerRole({
      name: 'readonly',
      permissions: [{ resource: 'data', action: 'read' }],
    });
    this.rbac.registerRole({
      name: 'writer',
      permissions: [
        { resource: 'data', action: 'read' },
        { resource: 'data', action: 'create' },
        { resource: 'data', action: 'update' },
      ],
    });
    this.rbac.registerRole({
      name: 'admin',
      permissions: [{ resource: '*', action: 'admin' }],
    });
  }

  authorize(identity: Identity, permission: Permission): boolean {
    const result = this.rateLimiter.check(identity.id);
    if (!result.allowed) {
      throw new Error('Rate limit exceeded');
    }
    return this.rbac.hasPermission(identity, permission);
  }
}
```

## SCIM User Sync

```typescript
import { InMemorySCIMSyncProvider } from '@agentix-e/db-operations-security';

const scim = new InMemorySCIMSyncProvider();

// First sync — creates users
const result1 = await scim.syncUsers();
console.log(`Created: ${result1.added}, Updated: ${result1.updated}`);
// → Created: 3, Updated: 0

// Second sync — updates existing
const result2 = await scim.syncUsers();
console.log(`Created: ${result2.added}, Updated: ${result2.updated}`);
// → Created: 0, Updated: 3

// Full resync
await scim.fullResync();
console.log(`Last sync: ${scim.getLastSyncTime()}`);
```
