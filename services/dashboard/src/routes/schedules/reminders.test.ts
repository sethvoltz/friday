/**
 * AC11 (FRI-168): the reminders surface on /schedules. These pin the
 * pure-logic layer that the filter + "Upcoming reminders" agenda are
 * built on, so a regression in the kind filter or the 7-day window is
 * caught without a browser or the page component.
 */

import { describe, expect, it } from "vitest";
import { filterReminders, upcomingReminders, UPCOMING_WINDOW_MS } from "./reminders";

type Row = { name: string; kind: "agent-run" | "reminder"; nextRunAt: number | null };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("filterReminders", () => {
  it("keeps reminder rows and hides agent-run rows", () => {
    const reminderRow: Row = { name: "rem", kind: "reminder", nextRunAt: 1 };
    const agentRunRow: Row = { name: "job", kind: "agent-run", nextRunAt: 1 };

    const out = filterReminders([reminderRow, agentRunRow]);

    expect(out).toHaveLength(1);
    expect(out).toEqual([reminderRow]);
  });
});

describe("upcomingReminders", () => {
  it("includes in-window reminders, sorted soonest-first, excluding out-of-window / agent-run / null", () => {
    const now = 1_000_000_000_000;
    const soon: Row = { name: "soon", kind: "reminder", nextRunAt: now + HOUR };
    const later: Row = { name: "later", kind: "reminder", nextRunAt: now + 6 * DAY };
    const farOut: Row = { name: "far", kind: "reminder", nextRunAt: now + 30 * DAY };
    const job: Row = { name: "job", kind: "agent-run", nextRunAt: now + HOUR };
    const nullRun: Row = { name: "null", kind: "reminder", nextRunAt: null };

    const out = upcomingReminders([later, soon, farOut, job, nullRun], now);

    // soonest-first ordering, only the two in-window reminders survive.
    expect(out.map((r) => r.name)).toEqual(["soon", "later"]);
  });

  it("treats the window boundary as inclusive and now as the lower bound", () => {
    const now = 1_000_000_000_000;
    const atNow: Row = { name: "atNow", kind: "reminder", nextRunAt: now };
    const atEdge: Row = {
      name: "atEdge",
      kind: "reminder",
      nextRunAt: now + UPCOMING_WINDOW_MS,
    };
    const past: Row = { name: "past", kind: "reminder", nextRunAt: now - 1 };
    const justOver: Row = {
      name: "justOver",
      kind: "reminder",
      nextRunAt: now + UPCOMING_WINDOW_MS + 1,
    };

    const out = upcomingReminders([atNow, atEdge, past, justOver], now);

    expect(out.map((r) => r.name)).toEqual(["atNow", "atEdge"]);
  });
});
