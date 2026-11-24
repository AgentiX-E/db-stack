# Scheduling maintenance windows

`MaintenanceWindowScheduler` owns the window lifecycle: when a window may run,
who approved it, what it conflicts with, and what to do when two of them want the
same minutes.

```ts
import { MaintenanceWindowScheduler } from "@agentix-e/db-node/maintenance";

const scheduler = new MaintenanceWindowScheduler();
scheduler.registerWindow({
  id: "vacuum-nightly",
  name: "Nightly VACUUM",
  operationType: "vacuum",
  targets: ["orders", "order_items"],
  recurrence: "cron",
  cronExpression: "0 3 * * *",
  priority: 10,
  owner: "platform",
  maxDurationMin: 45,
  requiresApproval: true,
});
```

`recurrence` is one string, not an object: `once`, `daily`, `weekly`, `monthly`
or `cron`. What the mode needs is a sibling field — `cronExpression` for `cron`,
`at` for `once`, `startTime`/`endTime` for the calendar modes, plus `daysOfWeek`
or `daysOfMonth` where the mode has days. `maxDurationMin` is minutes, and `0`
means unbounded; `requiresApproval` decides whether an occurrence may start
without a call to `approveWindow`.

## Lifecycle

```
pending ──approve──▶ approved ──(a window opens)──▶ scheduled ──▶ in_progress ──▶ completed
   │                                                                  └─────────▶ failed
   └──cancel──▶ cancelled
```

| Member | Contract |
|---|---|
| `registerWindow(window)` | Adds a window. Ids are unique; a duplicate is refused rather than replacing the earlier definition |
| `approveWindow(instanceId, approvedBy)` | Records who approved an occurrence. A window without approvals does not start |
| `cancelWindow(instanceId, reason)` | Terminates an occurrence that has not started |
| `startWindow(instanceId)` / `completeWindow(instanceId)` / `failWindow(instanceId, reason)` | The transitions a runner drives. An illegal transition throws rather than being recorded as success |
| `forceStart(windowId)` | The emergency path: bypasses approval and scheduling, and is recorded as forced |
| `getUpcomingOccurrences(fromMs, toMs)` | Projects occurrences in a range, in order |
| `checkConflict(a, b)` / `detectConflicts(fromMs, toMs)` | Overlap detection over projected occurrences |
| `resolveConflict(conflict, strategy)` | `'defer_lower'`, `'defer_newer'` or `'allow_both'`. Resolution is an explicit call, never an implicit policy |
| `getInstanceState(instanceId)` / `getWindowInstances(windowId)` | Read views |
| `requestPause(request)` / `requestResume(request)` | Ask the resources a window depends on to stop and start |
| `getStats()` | Counts by state, and the conflicts that were resolved |

The five recurrence modes are `once`, `daily`, `weekly`, `monthly` and `cron`.
Overlap is decided on the *projected* interval, so a weekly window and a monthly
one that share a date are a conflict in the week they share, not every week.

> **`requestPause` is immediate.** `PauseRequest.pauseAt` and `ResumeRequest.resumeAt`
> are declared and read by no branch: `requestPause` iterates the dependents and
> awaits `onPaused` now. A caller that sets a future resume time has described an
> intention nothing schedules. The interval is owned by the caller until the
> scheduler takes it over (registered as P3-2).

## The cron grammar

`parseCron(expression)` reads five fields — `minute hour day-of-month month
day-of-week` — and returns the values each names:

```ts
import { parseCron } from "@agentix-e/db-node/maintenance";

parseCron("0 3 * * *").hours;              // Set { 3 }
parseCron("*/15 0-6 * * 1-5").minutes;     // Set { 0, 15, 30, 45 }
parseCron("0 3 * *");                      // throws: expected 5 fields
```

`CronSchedule` carries `minutes`, `hours`, `daysOfMonth`, `months` and
`daysOfWeek` (Sunday is `0`).

### `parseCronField(field, min, max)`

One field, resolved against its own bounds. This is exported because a field is
where an operator's typo lives, and the outcome of a typo is assertable here —
*which minutes matched* — while the same typo observed through occurrence
projection is indistinguishable from "this window never fires".

| Form | Meaning |
|---|---|
| `*` | Every value in `min..max` |
| `5` | That value |
| `1-5` | Inclusive range, clamped to `min..max` at both ends |
| `*/n`, `a/n`, `a-b/n` | A walked range, clamped per value |
| `1,15,30` | Union of the parts above |

Three behaviours are decisions rather than accidents:

- **Clamping, not wrapping.** `0-70` in minutes names `0..59`, not seventy minutes
  that do not exist and not a roll into the next hour.
- **A malformed part names nothing.** `0-70/5` yields `0,5,…,55`; `abc` yields the
  empty set. Nothing throws, so a schedule that names nothing is inert and
  visible, not a crash at midnight.
- **A step of `0` names nothing.** `*/0` is a typo, and iterating it would never
  terminate.

A sixth field is ignored: dialects that have a year field are dialects, and a
scheduler that reads only the five it implements is honest about which it honours.
