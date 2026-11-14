/**
 * MaintenanceWindowScheduler — malformed input and terminal-outcome handling.
 *
 * A scheduler that throws on a bad cron string, or that silently keeps a
 * finished window in `scheduled`, is worse than no scheduler: the failure
 * surfaces hours later during a maintenance blackout. These tests pin the
 * behaviour that matters operationally:
 *
 *   - malformed recurrence / cron / time fields are skipped, never thrown,
 *   - a window with no trigger produces no occurrence instead of a bogus one,
 *   - the terminal states (`completed` / `failed`) are reachable and counted.
 */

import { describe, it, expect } from "vitest";
import { MaintenanceWindowScheduler } from "../impl/MaintenanceWindowScheduler.js";
import type { MaintenanceWindow } from "../interfaces/IMaintenanceScheduler.js";

const H_MS = 3_600_000;
const D_MS = 86_400_000;
const NOW = 1_800_000_000_000;

let seq = 0;
function win(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  seq += 1;
  return {
    id: `mws-${seq}`,
    name: "Test Window",
    operationType: "VACUUM",
    targets: ["table_a"],
    recurrence: "once",
    at: new Date(NOW + 2 * H_MS).toISOString(),
    priority: 5,
    owner: "dba-team",
    maxDurationMin: 60,
    requiresApproval: false,
    ...overrides,
  };
}

describe("MaintenanceWindowScheduler — malformed cron fields", () => {
  const cases: Array<[string, string]> = [
    ["missing step", "*/ 3 * * *"],
    ["non numeric step", "*/x * * * *"],
    ["zero step", "*/0 * * * *"],
    ["empty range", "/5 * * * *"],
    ["unknown range token", "a-b/2 * * * *"],
    ["range without bounds", "-/2 * * * *"],
  ];

  it.each(cases)("skips the malformed field (%s) without throwing", (_label, expr) => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "cron", cronExpression: expr }));

    expect(() => scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).not.toThrow();
  });

  it("still projects a valid step field", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ id: "cron-ok", recurrence: "cron", cronExpression: "0 */6 * * *" }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);

    expect(occurrences.length).toBeGreaterThan(0);
  });

  it("accepts a bounded range with a step", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "cron", cronExpression: "0 10-14/2 * * *" }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);

    // Only the even hours 10, 12 and 14 inside the range qualify.
    for (const occurrence of occurrences) {
      const hour = new Date(occurrence.start).getUTCHours();
      expect([10, 12, 14]).toContain(hour);
    }
  });

  it("accepts a start-anchored step (hour/step)", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "cron", cronExpression: "0 8/6 * * *" }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);

    for (const occurrence of occurrences) {
      expect([8, 14, 20]).toContain(new Date(occurrence.start).getUTCHours());
    }
  });

  it("rejects a cron expression with fewer than five fields", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "cron", cronExpression: "* * *" }));

    expect(() => scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).toThrow("expected 5 fields");
  });
});

describe("MaintenanceWindowScheduler — trigger validation", () => {
  // The projection code assumes the trigger is present; `registerWindow` is the
  // only writer, so the invariant must hold there. These assertions pin that
  // contract instead of testing unreachable guards downstream.
  const invalid: Array<[string, Partial<MaintenanceWindow>, string]> = [
    ["one-off without 'at'", { recurrence: "once", at: undefined }, "require 'at'"],
    ["daily without startTime", { recurrence: "daily" }, "daily windows require 'startTime'"],
    ["weekly without startTime", { recurrence: "weekly", daysOfWeek: ["mon"] }, "weekly windows require 'startTime'"],
    [
      "weekly without weekdays",
      { recurrence: "weekly", startTime: "03:00", daysOfWeek: [] },
      "require 'daysOfWeek'",
    ],
    ["monthly without startTime", { recurrence: "monthly", daysOfMonth: [1] }, "monthly windows require 'startTime'"],
    [
      "monthly without days",
      { recurrence: "monthly", startTime: "03:00", daysOfMonth: [] },
      "require 'daysOfMonth'",
    ],
    ["cron without expression", { recurrence: "cron" }, "require 'cronExpression'"],
    ["negative duration", { maxDurationMin: -1 }, "maxDurationMin must be >= 0"],
    ["negative priority", { priority: -1 }, "Priority must be >= 0"],
  ];

  it.each(invalid)("rejects a %s window", (_label, overrides, message) => {
    const scheduler = new MaintenanceWindowScheduler();

    expect(() => scheduler.registerWindow(win(overrides))).toThrow(message);
  });

  it("rejects a daily window with a malformed start time at projection time", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "daily", startTime: "aa:bb" }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).toEqual([]);
  });

  it("rejects a weekly window with a malformed start time at projection time", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "weekly", startTime: "aa:bb", daysOfWeek: ["mon"] }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).toEqual([]);
  });

  it("rejects a monthly window with a malformed start time at projection time", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "monthly", startTime: "aa:bb", daysOfMonth: [1] }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).toEqual([]);
  });

  it("skips a one-off window with an unparsable timestamp", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ recurrence: "once", at: "not-a-date" }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + D_MS)).toEqual([]);
  });

  it("falls back to an hour when maxDurationMin is not positive", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ maxDurationMin: 0 }));

    const [occurrence] = scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);

    expect(occurrence).toBeDefined();
    expect(occurrence!.end - occurrence!.start).toBe(H_MS);
  });

  it("honours a positive maxDurationMin", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ maxDurationMin: 15 }));

    const [occurrence] = scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);

    expect(occurrence!.end - occurrence!.start).toBe(15 * 60_000);
  });
});

describe("MaintenanceWindowScheduler — terminal outcomes", () => {
  function scheduledInstance() {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(win({ id: "outcome-win" }));
    scheduler.getUpcomingOccurrences(NOW, NOW + D_MS);
    const [instance] = scheduler.getWindowInstances("outcome-win");
    return { scheduler, instance: instance! };
  }

  it("marks an instance completed and counts it", () => {
    const { scheduler, instance } = scheduledInstance();

    const finished = scheduler.completeWindow(instance.id);

    expect(finished.state).toBe("completed");
    expect(finished.actualEnd).toBeGreaterThan(0);
    expect(scheduler.getStats().completedInstances).toBe(1);
  });

  it("marks an instance failed with the reason and counts it", () => {
    const { scheduler, instance } = scheduledInstance();

    const finished = scheduler.failWindow(instance.id, "disk full");

    expect(finished.state).toBe("failed");
    expect(finished.error).toBe("disk full");
    expect(scheduler.getStats().failedInstances).toBe(1);
  });

  it("rejects finishing an instance twice", () => {
    const { scheduler, instance } = scheduledInstance();
    scheduler.completeWindow(instance.id);

    expect(() => scheduler.completeWindow(instance.id)).toThrow('in state "completed"');
    expect(() => scheduler.failWindow(instance.id, "late")).toThrow('in state "completed"');
  });

  it("rejects finishing a cancelled instance", () => {
    const { scheduler, instance } = scheduledInstance();
    scheduler.cancelWindow(instance.id, "operator aborted");

    expect(() => scheduler.completeWindow(instance.id)).toThrow('in state "cancelled"');
  });

  it("rejects finishing an unknown instance", () => {
    const { scheduler } = scheduledInstance();

    expect(() => scheduler.completeWindow("nope")).toThrow();
  });

  it("reports the per-state breakdown after mixed outcomes", () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(
      win({ id: "mix", recurrence: "daily", startTime: "03:00", maxDurationMin: 30 }),
    );
    scheduler.getUpcomingOccurrences(NOW, NOW + 3 * D_MS);
    const instances = scheduler.getWindowInstances("mix");
    expect(instances.length).toBeGreaterThanOrEqual(3);

    scheduler.completeWindow(instances[0]!.id);
    scheduler.failWindow(instances[1]!.id, "checkpoint failed");
    scheduler.cancelWindow(instances[2]!.id, "superseded");

    const stats = scheduler.getStats();
    expect(stats.completedInstances).toBe(1);
    expect(stats.failedInstances).toBe(1);
    expect(stats.cancelledInstances).toBe(1);
    expect(stats.totalWindows).toBe(1);
  });
});
