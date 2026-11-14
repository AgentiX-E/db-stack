import type { IRBACProvider, Permission, Role, Identity } from '../interfaces/index.js';

export class InMemoryRBACProvider implements IRBACProvider {
  private _roles: Map<string, Permission[]> = new Map();

  registerRole(role: Role): void {
    this._roles.set(role.name, [...role.permissions]);
  }

  hasPermission(identity: Identity, permission: Permission): boolean {
    for (const roleName of identity.roles) {
      const perms = this._roles.get(roleName);
      if (!perms) continue;
      const match = perms.find(
        (p) => p.resource === permission.resource && p.action === permission.action,
      );
      if (match) return true;
    }
    return false;
  }

  getPermissions(identity: Identity): Permission[] {
    const result: Map<string, Permission> = new Map();
    for (const roleName of identity.roles) {
      const perms = this._roles.get(roleName);
      if (!perms) continue;
      for (const p of perms) {
        const key = `${p.resource}:${p.action}`;
        if (!result.has(key)) {
          result.set(key, { resource: p.resource, action: p.action });
        }
      }
    }
    return Array.from(result.values());
  }

  getRoles(): Role[] {
    return Array.from(this._roles.entries()).map(([name, permissions]) => ({
      name,
      permissions,
    }));
  }
}
