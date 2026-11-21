# Production implementations

The `InMemory*` classes in this package are fixtures: `InMemoryEncryptionManager`
XORs its input, `InMemoryRBACProvider` is a map with no hierarchy, and both exist
so that a package that *uses* security can be tested without owning a key. The
seven classes below are what a deployment runs, and until iteration 32 none of
them was reachable from the package entry point — every documented snippet in the
user guide's encryption section resolved to `undefined`.

## Encryption

### `KeyManager`

Owns the key hierarchy: a key-encryption key (KEK) derived from a master secret,
and the data-encryption keys (DEKs) it wraps.

```ts
import { KeyManager } from "@agentix-e/db-node/security";

const keys = new KeyManager({ masterSecret: process.env.MASTER_SECRET! });
const wrapped = await keys.generateKey(); // version 1, DEK sealed under the KEK
```

| Member | Contract |
|---|---|
| `constructor(config)` | Derives the KEK. `masterSecret` is required; the rest have documented defaults |
| `generateKey()` | Issues the next key version and returns it wrapped |
| `loadKey(wrapped)` | Adopts a wrapped key, e.g. one read from durable storage. Returns its version |
| `wrapKey(dek, version)` / `unwrapKey(wrapped)` | Wrap a DEK under the KEK / recover it. Unwrapping a key whose version is not held throws |
| `exportWrappedKeys()` | Every key this manager holds, wrapped. This is the shape that goes to disk |
| `getCurrentKey()` / `getKey(version)` | The raw DEK for encrypting / decrypting a specific version |
| `hasKeyVersion(version)` | Whether a version can still be decrypted |
| `zeroize()` | Wipes the KEK and every DEK. The version counter is kept, because a version number names one key and reissuing a retired name would make two different keys answer to the same version |

`KeyManagerConfig`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `masterSecret` | `string` | — | Password or secret the KEK is derived from |
| `salt` | `Buffer` | 32 random bytes | PBKDF2 salt. Store it beside the wrapped keys |
| `iterations` | `number` | 600 000 | PBKDF2 iterations. Must be ≤ `MAX_DERIVATION_ITERATIONS` |
| `keyLength` | `16 \| 24 \| 32` | 32 | Data-key length. Does **not** size the KEK, which is always 32 bytes because the wrapping cipher is fixed |
| `hashAlgorithm` | `string` | `"sha256"` | PBKDF2 hash |

### The four bounds

| Constant | Value | Why it is published |
|---|---|---|
| `MAX_DERIVATION_ITERATIONS` | 10 000 000 | A configuration that asks for more is a denial of service against itself; the constructor refuses it rather than deriving for a minute |
| `MIN_SALT_BYTES` / `MAX_SALT_BYTES` | 16 / 64 | A short salt is a precomputation aid; a long one is a memory cost with no benefit. Both ends are refused |
| `MAX_CACHED_KEKS` | 64 | The derived-KEK cache is bounded, because an unbounded cache keyed by salt is a memory leak a caller cannot see |

### `AES256GCMEncryptionProvider`

Authenticated encryption with a documented wire format, so two processes agree on
what a ciphertext is:

```
┌─────────┬──────┬──────────┬───────────┐
│ version │  IV  │ cipher-  │  auth tag │
│ (4B BE) │ (12B)│  text    │   (16B)   │
└─────────┴──────┴──────────┴───────────┘
```

`encrypt(plaintext, context?)` binds the blob to `context` as associated data, so
a ciphertext lifted from one context does not decrypt in another. `decrypt` throws
when the tag does not verify — the plaintext is never released before the check.

### `EnvelopeEncryptionProvider`

The pattern a deployment wants when keys must rotate without re-encrypting data: a
DEK per session, wrapped under the KEK, prepended to the payload.

```
┌────────────────┬────────────────┬────────────┐
│   wrapped DEK  │   ciphertext   │   blob     │
└────────────────┴────────────────┴────────────┘
```

Rotating the KEK re-wraps the DEKs; the data is untouched. `canDecryptVersion(v)`
answers whether a blob written under version `v` can still be read, which is the
question a migration asks. `exportKeys()` / `importKey()` move the key history
between processes.

## Key rotation

### `KeyRotationManager`

```ts
const rotation = new KeyRotationManager(encryption, keys);
rotation.registerPolicy({ id: "dek-90d", intervalMs: 90 * 24 * 3600_000, ... });
await rotation.checkPolicies();          // policies that are due
await rotation.rotate("dek-90d");        // one rotation, recorded
```

| Member | Contract |
|---|---|
| `registerPolicy(policy)` | Adds a policy. Rotation is driven by policies, never by a timer the manager invents |
| `checkPolicies()` | The policies that are due now, without rotating them |
| `rotate(policyId)` / `emergencyRotate(policyId, reason)` | Execute one rotation and return the recorded event |
| `reEncrypt(policyId, blobIterator)` | Re-encrypt a stream: fetch, decrypt-old, encrypt-new, verify, retire. Returns counts and the failures it could not commit |
| `getState(policyId)` / `getHistory(policyId?)` / `getStats()` | What happened, and what it costs |
| `startScheduler(intervalMs?)` / `stopScheduler()` | Opt-in polling. Nothing rotates unless a policy says it may |
| `recordEncryption(policyId, bytes)` | Feeds the byte counter that a volume-triggered policy reads |

### `RotationAuditor`

The compliance record, and the reason it can be trusted: every entry carries
`prevHash` and `hash`, so removing or editing one breaks `verify()`.

| Member | Contract |
|---|---|
| `record(event)` | Appends and returns the entry with its chain hash |
| `verify()` | `{ valid, brokenAt }` — where the chain stops being a chain |
| `generateReport(framework)` | A compliance summary for `"PCI-DSS"`, `"SOC2"` or `"HIPAA"` |
| `exportJSONL()` / `importJSONL(jsonl)` | Move the trail between processes without losing the chain |
| `recent(n)`, `bySeq(seq)`, `getEntriesByPolicy(id)` | Read views |

## Application audit

### `AuditLogManager`

Structured, hash-chained application audit (distinct from `FileAuditStore`, which
is the durable *storage* layer — see the audit package's own reference).

| Member | Contract |
|---|---|
| `log(partial)` | Appends an event; returns it with `id`, `seq`, `timestamp`, `hash`, `prevHash` filled in |
| `query(q)` | Filter by time, category, severity, actor, free text |
| `verifyIntegrity()` | Where the hash chain breaks, if it does |
| `getStats()` | Counts by severity, category and actor |
| `exportJSONL(query?)` | Machine-readable compliance export |
| `prune(olderThanMs)` | Retention, anchored so that pruning never invalidates the chain of what remains |
| `flush()` / `destroy()` | Persist now / flush and stop |

> **Set `logFilePath` in production.** The default is
> `path.join(process.cwd(), "audit.jsonl")`, so a process started from `/` writes
> `/audit.jsonl` and a process started from a directory it can write to leaves an
> audit trail inside its working directory. Both are the wrong place for evidence.

## Authorisation

### `RBACEngine`

Multi-dimensional RBAC with a DAG role hierarchy, constraint evaluation and a
resolution cache that is invalidated by the write that makes it stale.

| Member | Contract |
|---|---|
| `registerRole(role)` / `updateRole(name, updates)` / `removeRole(name)` | The role graph. A cycle is rejected at write time, not discovered at read time |
| `getEffectivePermissions(identity)` | Transitively resolved permissions, after constraints |
| `addConstraint(constraint)` / `removeConstraint(resource, action, type)` | Constraints that subtract from what the hierarchy grants (separation of duty, time windows, resource scope) |
| `validateHierarchy()` | `{ valid, circularRoles }` — the check the write path already performs, exposed for an external editor |
| `getRoleAncestors(name)` | The path a permission travelled, which is what an access review asks for |
| `getStats()` / `invalidateCache(identityId?)` | Cache accounting, and the escape hatch for a role edited outside this object |

## What is deliberately not here

No KMS client, no HSM binding, no key escrow. `KeyManager` derives and wraps
locally; a deployment that needs a managed root of trust supplies its own
`IEncryptionManager` and keeps the rotation and audit layers, which are the parts
that carry policy.
