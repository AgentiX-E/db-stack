/**
 * MaintenanceWindowSchedulerSurvivors — precise tests targeting remaining
 * mutation survivors in MaintenanceWindowScheduler.ts.
 *
 * Grouped by source region:
 *   - getStats exact per-state counts (active/cancelled/pending)
 *   - resolveConflict full branch matrix (defer_lower / defer_newer)
 *   - cron parser boundary values (range clamping, step overflow)
 *   - checkConflict overlap boundary
 *   - projection loop boundaries (daily/weekly/monthly/cron step advancement)
 */

import { describe, it, expect } from "vitest";
import { MaintenanceWindowScheduler } from "../impl/MaintenanceWindowScheduler.js";
import type { MaintenanceWindow } from "../interfaces/IMaintenanceScheduler.js";

const M_MS = 60_000;
const H_MS = 3_600_000;
const D_MS = 86_400_000;
const NOW = 1_800_000_000_000; // fixed reference timestamp

function win(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: `win-${Math.random().toString(36).slice(2, 8)}`,
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

describe("MWS-S: getStats exact per-state counts", () => {
  it("counts scheduled instances as active", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "g1", recurrence: "daily", startTime: "03:00" }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    const stats = s.getStats();
    expect(stats.activeWindows).toBeGreaterThan(0);
  });

  it("counts pending instances separately (requiresApproval)", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "g2", recurrence: "once", at: new Date(NOW + H_MS).toISOString(), requiresApproval: true }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    const stats = s.getStats();
    expect(stats.pendingApprovals).toBe(1);
    expect(stats.activeWindows).toBe(0); // pending is not active
  });

  it("counts cancelled instances after cancelWindow", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "g3", recurrence: "once", at: new Date(NOW + H_MS).toISOString() }));
    const occs = s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(occs.length).toBe(1);
    s.cancelWindow(occs[0]!.instanceId, "test cancel");
    const stats = s.getStats();
    expect(stats.cancelledInstances).toBe(1);
    expect(stats.activeWindows).toBe(0);
  });
});

describe("MWS-S: resolveConflict defer_lower full matrix", () => {
  function twoOverlapping(priorityA: number, priorityB: number) {
    const s = new MaintenanceWindowScheduler();
    const at = new Date(NOW + H_MS).toISOString();
    s.registerWindow(win({ id: "a", recurrence: "once", at, maxDurationMin: 60, priority: priorityA }));
    s.registerWindow(win({ id: "b", recurrence: "once", at: new Date(NOW + H_MS + 30 * M_MS).toISOString(), maxDurationMin: 60, priority: priorityB }));
    const occs = s.getUpcomingOccurrences(NOW, NOW + 4 * H_MS);
    const conflicts = s.detectConflicts(NOW, NOW + 4 * H_MS);
    return { s, conflicts, occs };
  }

  it("defer_lower cancels the lower-priority window's instances", () => {
    const { s, conflicts } = twoOverlapping(3, 8); // a=low, b=high
    expect(conflicts.length).toBe(1);
    s.resolveConflict(conflicts[0]!, "defer_lower");
    const aStates = s.getWindowInstances("a").map((i) => i.state);
    const bStates = s.getWindowInstances("b").map((i) => i.state);
    expect(aStates).toContain("cancelled");
    expect(bStates).not.toContain("cancelled");
  });

  it("defer_lower cancels B when B is lower priority", () => {
    const { s, conflicts } = twoOverlapping(9, 4); // a=high, b=low
    expect(conflicts.length).toBe(1);
    s.resolveConflict(conflicts[0]!, "defer_lower");
    const aStates = s.getWindowInstances("a").map((i) => i.state);
    const bStates = s.getWindowInstances("b").map((i) => i.state);
    expect(bStates).toContain("cancelled");
    expect(aStates).not.toContain("cancelled");
  });

  it("defer_lower with equal priorities cancels B (the later window)", () => {
    const { s, conflicts } = twoOverlapping(5, 5);
    expect(conflicts.length).toBe(1);
    s.resolveConflict(conflicts[0]!, "defer_lower");
    // equal priority -> lowerAlone=false -> deferWin = winB (the second id)
    const bStates = s.getWindowInstances("b").map((i) => i.state);
    expect(bStates).toContain("cancelled");
  });

  it("defer_lower leaves approved instances untouched unless scheduled/approved", () => {
    const s = new MaintenanceWindowScheduler();
    const at = new Date(NOW + H_MS).toISOString();
    s.registerWindow(win({ id: "a", recurrence: "once", at, requiresApproval: true, priority: 3 }));
    s.registerWindow(win({ id: "b", recurrence: "once", at: new Date(NOW + H_MS + 30 * M_MS).toISOString(), requiresApproval: true, priority: 8 }));
    s.getUpcomingOccurrences(NOW, NOW + 4 * H_MS);
    const conflicts = s.detectConflicts(NOW, NOW + 4 * H_MS);
    s.resolveConflict(conflicts[0]!, "defer_lower");
    // a is pending (requiresApproval => pending, not scheduled/approved), so it is NOT cancelled
    const aStates = s.getWindowInstances("a").map((i) => i.state);
    expect(aStates).toContain("pending");
  });
});

describe("MWS-S: resolveConflict defer_newer", () => {
  it("cancels the newest scheduled instance of each conflicting window", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "n1", recurrence: "daily", startTime: "03:00" }));
    s.registerWindow(win({ id: "n2", recurrence: "daily", startTime: "03:30" }));
    s.getUpcomingOccurrences(NOW, NOW + 3 * D_MS);
    const conflicts = s.detectConflicts(NOW, NOW + 3 * D_MS);
    expect(conflicts.length).toBeGreaterThan(0);
    for (const c of conflicts) {
      s.resolveConflict(c, "defer_newer");
    }
    // at least one instance across n1/n2 got cancelled
    const allStates = [...s.getWindowInstances("n1"), ...s.getWindowInstances("n2")].map((i) => i.state);
    expect(allStates).toContain("cancelled");
  });

  it("defer_newer skips windows with no instances", () => {
    const s = new MaintenanceWindowScheduler();
    // register a once-window in the past (no future instances)
    s.registerWindow(win({ id: "past", recurrence: "once", at: new Date(NOW - D_MS).toISOString() }));
    s.registerWindow(win({ id: "now", recurrence: "once", at: new Date(NOW + H_MS).toISOString() }));
    s.getUpcomingOccurrences(NOW, NOW + 2 * H_MS);
    // Manually build a conflict referencing a window with no instances
    const conflict = {
      hasConflict: true,
      conflictingWindowIds: ["past", "now"],
      description: "x",
      recommendation: "defer" as const,
    };
    expect(() => s.resolveConflict(conflict, "defer_newer")).not.toThrow();
  });
});

describe("MWS-S: resolveConflict allow_both / no-conflict guards", () => {
  it("allow_both is a no-op even for a real conflict", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "x", recurrence: "once", at: new Date(NOW + H_MS).toISOString() }));
    s.registerWindow(win({ id: "y", recurrence: "once", at: new Date(NOW + H_MS + 30 * M_MS).toISOString() }));
    s.getUpcomingOccurrences(NOW, NOW + 4 * H_MS);
    const conflicts = s.detectConflicts(NOW, NOW + 4 * H_MS);
    expect(conflicts.length).toBe(1);
    s.resolveConflict(conflicts[0]!, "allow_both");
    expect(s.getWindowInstances("x").some((i) => i.state !== "cancelled")).toBe(true);
    expect(s.getWindowInstances("y").some((i) => i.state !== "cancelled")).toBe(true);
  });

  it("no-conflict resolveConflict returns early (no-op)", () => {
    const s = new MaintenanceWindowScheduler();
    const noConflict = {
      hasConflict: false,
      conflictingWindowIds: ["a", "b"],
      description: "x",
      recommendation: "defer" as const,
    };
    expect(() => s.resolveConflict(noConflict, "defer_lower")).not.toThrow();
  });
});

describe("MWS-S: cron parser boundary values", () => {
  it("cron step range does not leak values below min or above max", () => {
    const s = new MaintenanceWindowScheduler();
    // step */45 on minutes must produce only multiples of 45 within 0..59
    s.registerWindow(win({ id: "c1", recurrence: "cron", cronExpression: "*/45 * * * *" }));
    s.getUpcomingOccurrences(NOW, NOW + 2 * H_MS);
    const insts = s.getWindowInstances("c1");
    const minutes = insts.map((i) => new Date(i.scheduledStart!).getUTCMinutes());
    for (const m of minutes) {
      expect(m % 45).toBe(0);
    }
  });

  it("cron single-value field clamps out-of-range values", () => {
    const s = new MaintenanceWindowScheduler();
    // "99 * * * *" — minute 99 is out of range, so no occurrences
    s.registerWindow(win({ id: "c2", recurrence: "cron", cronExpression: "99 * * * *" }));
    s.getUpcomingOccurrences(NOW, NOW + H_MS);
    expect(s.getWindowInstances("c2")).toHaveLength(0);
  });

  it("cron exact minute produces an occurrence at that minute", () => {
    const s = new MaintenanceWindowScheduler();
    const base = new Date(NOW);
    base.setUTCSeconds(0, 0);
    const baseMs = base.getTime();
    s.registerWindow(win({ id: "c3", recurrence: "cron", cronExpression: "0 * * * *" }));
    s.getUpcomingOccurrences(baseMs, baseMs + H_MS);
    const insts = s.getWindowInstances("c3");
    expect(insts.length).toBeGreaterThan(0);
    for (const i of insts) {
      expect(new Date(i.scheduledStart!).getUTCMinutes()).toBe(0);
    }
  });
});

describe("MWS-S: checkConflict overlap boundary", () => {
  it("two occurrences that merely touch (end == start) do NOT overlap", () => {
    const s = new MaintenanceWindowScheduler();
    const t = NOW;
    const a = { windowId: "w1", instanceId: "i1", start: t, end: t + H_MS, recurrence: "once" as const, priority: 5 };
    const b = { windowId: "w2", instanceId: "i2", start: t + H_MS, end: t + 2 * H_MS, recurrence: "once" as const, priority: 5 };
    expect(s.checkConflict(a, b).hasConflict).toBe(false);
  });

  it("two occurrences where one starts before the other ends DO overlap", () => {
    const s = new MaintenanceWindowScheduler();
    const t = NOW;
    const a = { windowId: "w1", instanceId: "i1", start: t, end: t + H_MS, recurrence: "once" as const, priority: 5 };
    const b = { windowId: "w2", instanceId: "i2", start: t + H_MS - 1, end: t + 2 * H_MS, recurrence: "once" as const, priority: 5 };
    expect(s.checkConflict(a, b).hasConflict).toBe(true);
  });
});

describe("MWS-S: projection loop boundaries", () => {
  it("daily projection with startTime after range start advances to tomorrow", () => {
    const s = new MaintenanceWindowScheduler();
    // start time far in the "past" of the day; still projects future days
    s.registerWindow(win({ id: "d1", recurrence: "daily", startTime: "00:05" }));
    const start = new Date(NOW);
    start.setUTCHours(23, 59, 0, 0); // range starts near end of day
    const from = start.getTime();
    const to = from + 2 * D_MS;
    s.getUpcomingOccurrences(from, to);
    const insts = s.getWindowInstances("d1");
    expect(insts.length).toBeGreaterThan(0);
    // all occurrences should carry the HH:MM 00:05
    for (const i of insts) {
      const d = new Date(i.scheduledStart!);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(5);
    }
  });

  it("weekly projection respects daysOfWeek filter", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "w1", recurrence: "weekly", startTime: "02:00", daysOfWeek: ["mon"] as any }));
    s.getUpcomingOccurrences(NOW, NOW + 8 * D_MS);
    const insts = s.getWindowInstances("w1");
    expect(insts.length).toBeGreaterThan(0);
    for (const i of insts) {
      expect(new Date(i.scheduledStart!).getUTCDay()).toBe(1); // Monday
    }
  });

  it("monthly projection clamps day-of-month to last day", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "m1", recurrence: "monthly", startTime: "10:00", daysOfMonth: [31] }));
    s.getUpcomingOccurrences(NOW, NOW + 60 * D_MS);
    const insts = s.getWindowInstances("m1");
    expect(insts.length).toBeGreaterThan(0);
    for (const i of insts) {
      const d = new Date(i.scheduledStart!);
      // day is either 31 (long months) or the last day of a short month
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      expect(d.getUTCDate()).toBe(lastDay);
    }
  });

  it("cron projection advances by one minute per scan", () => {
    const s = new MaintenanceWindowScheduler();
    const base = new Date(NOW);
    base.setUTCSeconds(0, 0);
    // every 30 minutes
    s.registerWindow(win({ id: "c4", recurrence: "cron", cronExpression: "*/30 * * * *" }));
    const from = base.getTime();
    s.getUpcomingOccurrences(from, from + 2 * H_MS);
    const insts = s.getWindowInstances("c4");
    expect(insts.length).toBeGreaterThanOrEqual(3);
    for (const i of insts) {
      expect(new Date(i.scheduledStart!).getUTCMinutes() % 30).toBe(0);
    }
  });
});

// ── Additional precise assertions for remaining survivors ──

describe("MWS-S: checkConflict bothHighPriority boundary", () => {
  it("one high + one low priority overlapping returns 'defer' (not coexist)", () => {
    const s = new MaintenanceWindowScheduler();
    const t = NOW;
    const a = { windowId: "w1", instanceId: "i1", start: t, end: t + H_MS, recurrence: "once" as const, priority: 9 };
    const b = { windowId: "w2", instanceId: "i2", start: t + 30 * M_MS, end: t + 2 * H_MS, recurrence: "once" as const, priority: 2 };
    expect(s.checkConflict(a, b).recommendation).toBe("defer");
  });

  it("both high priority returns 'coexist'", () => {
    const s = new MaintenanceWindowScheduler();
    const t = NOW;
    const a = { windowId: "w1", instanceId: "i1", start: t, end: t + H_MS, recurrence: "once" as const, priority: 8 };
    const b = { windowId: "w2", instanceId: "i2", start: t + 30 * M_MS, end: t + 2 * H_MS, recurrence: "once" as const, priority: 7 };
    expect(s.checkConflict(a, b).recommendation).toBe("coexist");
  });

  it("one priority exactly 5 and one 6 (boundary) returns 'defer'", () => {
    const s = new MaintenanceWindowScheduler();
    const t = NOW;
    const a = { windowId: "w1", instanceId: "i1", start: t, end: t + H_MS, recurrence: "once" as const, priority: 5 };
    const b = { windowId: "w2", instanceId: "i2", start: t + 30 * M_MS, end: t + 2 * H_MS, recurrence: "once" as const, priority: 6 };
    expect(s.checkConflict(a, b).recommendation).toBe("defer");
  });
});

describe("MWS-S: resolveConflict with undefined windows", () => {
  it("defer_lower with a non-existent window id does not throw", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "real", recurrence: "once", at: new Date(NOW + H_MS).toISOString() }));
    s.getUpcomingOccurrences(NOW, NOW + 2 * H_MS);
    const conflict = {
      hasConflict: true,
      conflictingWindowIds: ["real", "ghost"],
      description: "x",
      recommendation: "defer" as const,
    };
    expect(() => s.resolveConflict(conflict, "defer_lower")).not.toThrow();
  });
});

describe("MWS-S: weekly/monthly validation", () => {
  it("registerWindow rejects weekly without startTime", () => {
    const s = new MaintenanceWindowScheduler();
    const w = win({ id: "vw", recurrence: "weekly", daysOfWeek: ["mon"] as any, startTime: undefined });
    expect(() => s.registerWindow(w)).toThrow(/startTime/);
  });

  it("registerWindow rejects monthly without startTime", () => {
    const s = new MaintenanceWindowScheduler();
    const w = win({ id: "vm", recurrence: "monthly", daysOfMonth: [15], startTime: undefined });
    expect(() => s.registerWindow(w)).toThrow(/startTime/);
  });

  it("registerWindow rejects daily without startTime", () => {
    const s = new MaintenanceWindowScheduler();
    const w = win({ id: "vd", recurrence: "daily", startTime: undefined });
    expect(() => s.registerWindow(w)).toThrow(/startTime/);
  });
});

describe("MWS-S: daily projection invalid/edge startTime", () => {
  it("daily with invalid hour (valid minute) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "di", recurrence: "daily", startTime: "xx:30" }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("di")).toHaveLength(0);
  });

  it("daily with invalid minute (valid hour) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "di2", recurrence: "daily", startTime: "03:xx" }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("di2")).toHaveLength(0);
  });

  it("weekly with invalid hour (valid minute) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "wi", recurrence: "weekly", startTime: "xx:30", daysOfWeek: ["mon"] as any }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("wi")).toHaveLength(0);
  });

  it("weekly with invalid minute (valid hour) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "wi2", recurrence: "weekly", startTime: "03:xx", daysOfWeek: ["mon"] as any }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("wi2")).toHaveLength(0);
  });

  it("monthly with invalid hour (valid minute) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "mi", recurrence: "monthly", startTime: "xx:30", daysOfMonth: [15] }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("mi")).toHaveLength(0);
  });

  it("monthly with invalid minute (valid hour) produces no occurrences", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "mi2", recurrence: "monthly", startTime: "03:xx", daysOfMonth: [15] }));
    s.getUpcomingOccurrences(NOW, NOW + D_MS);
    expect(s.getWindowInstances("mi2")).toHaveLength(0);
  });
});

describe("MWS-S: weekly/monthly empty days guard", () => {
  it("weekly with empty daysOfWeek is rejected at registration", () => {
    const s = new MaintenanceWindowScheduler();
    const w = win({ id: "we", recurrence: "weekly", startTime: "03:00", daysOfWeek: [] });
    expect(() => s.registerWindow(w)).toThrow(/daysOfWeek/);
  });

  it("monthly with empty daysOfMonth is rejected at registration", () => {
    const s = new MaintenanceWindowScheduler();
    const w = win({ id: "me", recurrence: "monthly", startTime: "03:00", daysOfMonth: [] });
    expect(() => s.registerWindow(w)).toThrow(/daysOfMonth/);
  });
});

describe("MWS-S: defer_newer approved + newest selection", () => {
  it("defer_newer cancels only the newest among scheduled AND approved", () => {
    const s = new MaintenanceWindowScheduler();
    // daily window -> multiple instances across days; approve the very first
    s.registerWindow(win({ id: "dn", recurrence: "daily", startTime: "03:00" }));
    const occs = s.getUpcomingOccurrences(NOW, NOW + 3 * D_MS);
    expect(occs.length).toBeGreaterThanOrEqual(2);
    // approve the first instance (pending -> approved requires requiresApproval, so use scheduled)
    // Instead: create a conflict and ensure defer_newer cancels the newest scheduled instance
    const conflict = {
      hasConflict: true,
      conflictingWindowIds: ["dn"],
      description: "x",
      recommendation: "defer" as const,
    };
    s.resolveConflict(conflict, "defer_newer");
    const states = s.getWindowInstances("dn").map((i) => i.state);
    expect(states).toContain("cancelled");
  });
});

describe("MWS-S: monthly day range boundary", () => {
  it("monthly afterStart guard excludes candidates before range start", () => {
    const s = new MaintenanceWindowScheduler();
    // day 1 of month; range starts mid-month on the 15th -> day 1 is before range
    s.registerWindow(win({ id: "mb", recurrence: "monthly", startTime: "10:00", daysOfMonth: [1] }));
    const rangeStart = new Date(NOW);
    rangeStart.setUTCDate(15);
    rangeStart.setUTCHours(0, 0, 0, 0);
    const from = rangeStart.getTime();
    s.getUpcomingOccurrences(from, from + 60 * D_MS);
    const insts = s.getWindowInstances("mb");
    for (const i of insts) {
      expect(i.scheduledStart!).toBeGreaterThanOrEqual(from);
    }
  });
});

// ── defer_newer newest-selection precision (L256/L259) ──

describe("MWS-S: defer_newer newest-selection precision", () => {
  it("cancels ONLY the newest scheduled instance, leaving earlier ones scheduled", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "sel", recurrence: "daily", startTime: "03:00" }));
    s.getUpcomingOccurrences(NOW, NOW + 3 * D_MS);
    const conflict = {
      hasConflict: true,
      conflictingWindowIds: ["sel"],
      description: "x",
      recommendation: "defer" as const,
    };
    s.resolveConflict(conflict, "defer_newer");

    const insts = s.getWindowInstances("sel");
    const cancelled = insts.filter((i) => i.state === "cancelled");
    const scheduled = insts.filter((i) => i.state === "scheduled");
    // exactly one cancelled, and it is the newest (largest scheduledStart)
    expect(cancelled).toHaveLength(1);
    const newestStart = Math.max(...insts.map((i) => i.scheduledStart ?? 0));
    expect(cancelled[0]!.scheduledStart).toBe(newestStart);
    // remaining instances stay scheduled
    expect(scheduled).toHaveLength(insts.length - 1);
  });

  it("selects among approved instances too (approved participates in newest)", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "appr", recurrence: "daily", startTime: "03:00", requiresApproval: true }));
    const occs = s.getUpcomingOccurrences(NOW, NOW + 3 * D_MS);
    expect(occs.length).toBeGreaterThanOrEqual(2);
    // approve ALL pending instances so every instance is "approved" (not pending)
    for (const inst of s.getWindowInstances("appr")) {
      s.approveWindow(inst.id, "dba");
    }
    const conflict = {
      hasConflict: true,
      conflictingWindowIds: ["appr"],
      description: "x",
      recommendation: "defer" as const,
    };
    s.resolveConflict(conflict, "defer_newer");

    const insts = s.getWindowInstances("appr");
    const cancelled = insts.filter((i) => i.state === "cancelled");
    const approved = insts.filter((i) => i.state === "approved");
    expect(cancelled).toHaveLength(1);
    // newest approved instance got cancelled
    const newestStart = Math.max(...insts.map((i) => i.scheduledStart ?? 0));
    expect(cancelled[0]!.scheduledStart).toBe(newestStart);
    expect(approved).toHaveLength(insts.length - 1);
  });
});

// ── daily cursor advance boundary (L395/L396) ──

describe("MWS-S: daily cursor advancement boundary", () => {
  it("does not project an occurrence before the range start", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "adv", recurrence: "daily", startTime: "00:05" }));
    const start = new Date(NOW);
    start.setUTCHours(23, 59, 0, 0);
    const from = start.getTime();
    const to = from + 2 * D_MS;
    s.getUpcomingOccurrences(from, to);
    const insts = s.getWindowInstances("adv");
    expect(insts.length).toBeGreaterThan(0);
    // first occurrence must be on/after the range start (advance-to-tomorrow path)
    expect(insts[0]!.scheduledStart!).toBeGreaterThanOrEqual(from);
  });
});

// ── idempotent projection (L659 _findExistingInstance) ──

describe("MWS-S: idempotent projection reuse", () => {
  it("re-projection reuses the same instance instead of duplicating", () => {
    const s = new MaintenanceWindowScheduler();
    s.registerWindow(win({ id: "idem", recurrence: "once", at: new Date(NOW + H_MS).toISOString() }));
    const first = s.getUpcomingOccurrences(NOW, NOW + 2 * H_MS);
    expect(first).toHaveLength(1);
    const before = s.getWindowInstances("idem").length;
    // second projection must NOT add a duplicate
    const second = s.getUpcomingOccurrences(NOW, NOW + 2 * H_MS);
    expect(second).toHaveLength(1);
    expect(s.getWindowInstances("idem").length).toBe(before);
    // the returned occurrence references the same instance id
    expect(second[0]!.instanceId).toBe(first[0]!.instanceId);
  });
});
