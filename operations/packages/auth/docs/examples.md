# Examples

## Full Auth Pipeline

```typescript
import type { IAuthProvider, IRBACProvider, IAuditStore } from '@agentix-e/db-operations-auth';

async function loginFlow(
  auth: IAuthProvider,
  audit: IAuditStore,
  username: string,
  password: string,
) {
  try {
    const { token, expiresAt } = await auth.authenticate(username, password);
    await audit.record({
      timestamp: new Date(),
      userId: username,
      action: 'login',
      resource: 'system',
      result: 'success',
    });
    return { token, expiresAt };
  } catch (err) {
    await audit.record({
      timestamp: new Date(),
      userId: username,
      action: 'login',
      resource: 'system',
      result: 'failure',
      details: { error: err.message },
    });
    throw err;
  }
}
```

## RBAC in Action

```typescript
import type { IRBACProvider } from '@agentix-e/db-operations-auth';

async function authorizeAction(
  rbac: IRBACProvider,
  userId: string,
  action: string,
  resource: string,
) {
  const roles = await rbac.getUserRoles(userId);
  for (const role of roles) {
    if (await rbac.checkPermission(role, action, resource)) {
      return true;
    }
  }
  return false;
}

// Usage
const canRead = await authorizeAction(rbac, 'user-1', 'read', 'database:orders');
```
