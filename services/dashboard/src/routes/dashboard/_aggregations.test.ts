import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyByModelRow } from "@friday/shared/services";
import { buildTokenViews } from "./_aggregations.js";

// Frozen "today" used for every test below.
const NOW = new Date("2026-05-13T12:00:00");

function daysAgo(n: number): string {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  return d.toLocaleDateString("en-CA");
}

function row(day: string, overrides: Partial<DailyByModelRow> = {}): DailyByModelRow {
  return {
    day,
    model: "sonnet",
    cost: 1,
    rawInput: 1000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 500,
    turns: 1,
    ...overrides,
  };
}

describe("buildTokenViews — rolling window semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("day.current covers only today", () => {
    const rows = [row(daysAgo(0)), row(daysAgo(1)), row(daysAgo(2))];
    const { views } = buildTokenViews(rows);
    expect(views.day.current.cost).toBe(1);
    expect(views.day.current.input).toBe(1000);
  });

  it("week.current is a rolling 7-day sum (today + last 6 days)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(daysAgo(i)));
    const { views, costSummary } = buildTokenViews(rows);
    expect(views.week.current.cost).toBe(7);
    expect(views.week.current.input).toBe(7 * 1000);
    expect(views.week.current.output).toBe(7 * 500);
    expect(costSummary.thisWeek).toBe(7);
  });

  it("week.current excludes a row 7 days ago (window is [now-7d, now))", () => {
    const rows = [row(daysAgo(0)), row(daysAgo(6)), row(daysAgo(7))];
    const { views } = buildTokenViews(rows);
    expect(views.week.current.cost).toBe(2);
  });

  it("month.current is a rolling 30-day sum", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(daysAgo(i)));
    const { views, costSummary } = buildTokenViews(rows);
    expect(views.month.current.cost).toBe(30);
    expect(costSummary.thisMonth).toBe(30);
  });

  it("month.current excludes a row 30+ days old", () => {
    const rows = [row(daysAgo(0)), row(daysAgo(29)), row(daysAgo(30))];
    const { views } = buildTokenViews(rows);
    expect(views.month.current.cost).toBe(2);
  });

  it("costSummary agrees with the headline cards", () => {
    const rows = Array.from({ length: 35 }, (_, i) => row(daysAgo(i)));
    const { views, costSummary } = buildTokenViews(rows);
    expect(costSummary.thisWeek).toBe(views.week.current.cost);
    expect(costSummary.thisMonth).toBe(views.month.current.cost);
  });

  it("cacheRate reflects the rolling window's cache split", () => {
    const rows = [
      row(daysAgo(0), { cacheCreation: 100, cacheRead: 900 }),
      row(daysAgo(8), { cacheCreation: 1000, cacheRead: 0 }), // outside 7d
    ];
    const { views } = buildTokenViews(rows);
    // Within the 7-day window: 900 cacheRead / (100 + 900) total = 90%
    expect(views.week.cacheRate).toBe(90);
  });
});
