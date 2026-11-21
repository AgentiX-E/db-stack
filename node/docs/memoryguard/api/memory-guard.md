# Memory guard

A single admission question: *is there room to do this work?* It exists so that a
maintenance operation — a VACUUM, a reindex, a full-table export — can decline to
start under memory pressure instead of taking the process down with it.

```ts
import { InMemoryMemoryGuard } from "@agentix-e/db-node/memoryguard";

const guard = new InMemoryMemoryGuard();
guard.configure(0.85);                       // refuse above 85 % of the heap

const result = await guard.protect(() => reindex("orders"));
if (result === null) {
  logger.warn("reindex skipped: heap above 85 %", guard.getStats());
}
```

## `InMemoryMemoryGuard`

| Member | Contract |
|---|---|
| `configure(threshold)` | Fraction of `heapUsed / heapTotal` above which work is refused. Default `0.9` |
| `getStats()` | `{ heapUsed, heapTotal, external, rss, threshold }`, read from `process.memoryUsage()` at call time |
| `isHealthy()` | `heapUsed / heapTotal < threshold`. A zero `heapTotal` counts as healthy — a process that has not allocated has not run out |
| `protect(fn)` | Runs `fn` when healthy; returns **`null` and does not run it** when not |

The `null` return is the whole contract and it is deliberately not a throw: a
caller that wants to skip work should be able to write `if (result === null)`
without a `try` around it, and a refusal is a normal outcome rather than an
exception. Callers that must distinguish "refused" from "returned null" wrap the
work instead of returning `null` from it.

## What it measures, and what it does not

`heapUsed / heapTotal` is V8's own accounting. It does not see native memory held
by a driver, a shared buffer or an mmap, and it does not see a container limit —
Node sizes a heap by the machine's memory unless told otherwise. A deployment in a
cgroup-limited container should set `--max-old-space-size` (or `--max-semi-space-size`)
so that `heapTotal` reflects the budget the process actually has; without that, the
ratio describes an allowance the process will never be granted.

The name is `InMemory` because the state is per-process, not because it is a
fixture: reading `process.memoryUsage()` is the only way a guard can answer for the
process it is in.
