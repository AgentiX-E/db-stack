/**
 * I30 — RBAC provider edges.
 *
 * The interesting property of an authorisation check is what it does with a
 * role it has never heard of, and what happens when a role is re-registered
 * without a permission it used to hold.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryRBACProvider } from '../impl/InMemoryRBACProvider.js';
import type { Identity } from '../interfaces/index.js';

const reader: Identity = { id: 'user-reader', roles: ['reader'] };

describe('InMemoryRBACProvider — unknown roles', () => {
  it('ignores an unregistered role when collecting permissions', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'docs', action: 'read' }] });

    const identity: Identity = { id: 'user-mixed', roles: ['ghost', 'reader'] };

    expect(rbac.getPermissions(identity)).toEqual([{ resource: 'docs', action: 'read' }]);
  });

  it('returns no permissions for an identity made entirely of unknown roles', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'docs', action: 'read' }] });

    expect(rbac.getPermissions({ id: 'user-nobody', roles: ['ghost', 'phantom'] })).toEqual([]);
  });

  it('denies every permission to an identity with an empty role list', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'docs', action: 'read' }] });

    expect(rbac.hasPermission({ id: 'user-none', roles: [] }, { resource: 'docs', action: 'read' })).toBe(false);
    expect(rbac.getPermissions({ id: 'user-none', roles: [] })).toEqual([]);
  });
});

describe('InMemoryRBACProvider — revocation by re-registration', () => {
  it('stops authorising a permission that the updated role no longer grants', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({
      name: 'reader',
      permissions: [
        { resource: 'docs', action: 'read' },
        { resource: 'docs', action: 'delete' },
      ],
    });
    expect(rbac.hasPermission(reader, { resource: 'docs', action: 'delete' })).toBe(true);

    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'docs', action: 'read' }] });

    expect(rbac.hasPermission(reader, { resource: 'docs', action: 'delete' })).toBe(false);
    expect(rbac.getPermissions(reader)).toEqual([{ resource: 'docs', action: 'read' }]);
  });

  it('grants a permission added by re-registering the role', () => {
    const rbac = new InMemoryRBACProvider();
    rbac.registerRole({ name: 'reader', permissions: [] });
    expect(rbac.hasPermission(reader, { resource: 'docs', action: 'update' })).toBe(false);

    rbac.registerRole({ name: 'reader', permissions: [{ resource: 'docs', action: 'update' }] });

    expect(rbac.hasPermission(reader, { resource: 'docs', action: 'update' })).toBe(true);
  });
});
