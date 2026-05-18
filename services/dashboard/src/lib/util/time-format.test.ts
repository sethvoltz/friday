import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTooltip,
  formatDaySeparator,
  formatRelativeTime,
  localDayKey,
} from "./time-format.js";

// Pin a fixed "now" so relative buckets are deterministic. Times are
// interpreted in the test runner's local timezone, but every assertion
// uses pairs of timestamps that share the same local day or differ by
// whole local days — so the bucketing is TZ-independent.
//
// Anchor: Sunday May 17 2026, 14:30 local.
const now = new Date(2026, 4, 17, 14, 30, 0, 0).getTime();

function mkLocal(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

describe("formatRelativeTime", () => {
  it("renders same-local-day as clock time", () => {
    const ts = mkLocal(2026, 4, 17, 14, 14);
    expect(formatRelativeTime(ts, now)).toBe("2:14 PM");
  });

  it("renders early-morning same-day with AM", () => {
    const ts = mkLocal(2026, 4, 17, 9, 5);
    expect(formatRelativeTime(ts, now)).toBe("9:05 AM");
  });

  it("renders midnight as 12:00 AM", () => {
    const ts = mkLocal(2026, 4, 17, 0, 0);
    expect(formatRelativeTime(ts, now)).toBe("12:00 AM");
  });

  it("renders noon as 12:00 PM", () => {
    const ts = mkLocal(2026, 4, 17, 12, 0);
    expect(formatRelativeTime(ts, now)).toBe("12:00 PM");
  });

  it("renders yesterday with prefix", () => {
    const ts = mkLocal(2026, 4, 16, 22, 30);
    expect(formatRelativeTime(ts, now)).toBe("Yesterday at 10:30 PM");
  });

  it("renders within-6-days with weekday", () => {
    // 5 days back from Sunday May 17 = Tuesday May 12.
    const ts = mkLocal(2026, 4, 12, 8, 7);
    expect(formatRelativeTime(ts, now)).toBe("Tuesday at 8:07 AM");
  });

  it("renders 6 days ago as weekday (boundary inside window)", () => {
    const ts = mkLocal(2026, 4, 11, 15, 0);
    expect(formatRelativeTime(ts, now)).toBe("Monday at 3:00 PM");
  });

  it("renders 7 days ago as Mon Day (boundary out of window)", () => {
    const ts = mkLocal(2026, 4, 10, 15, 0);
    expect(formatRelativeTime(ts, now)).toBe("May 10");
  });

  it("renders older same year as Mon Day", () => {
    const ts = mkLocal(2026, 2, 15, 9, 0);
    expect(formatRelativeTime(ts, now)).toBe("Mar 15");
  });

  it("renders prior years with year suffix", () => {
    const ts = mkLocal(2024, 2, 15, 9, 0);
    expect(formatRelativeTime(ts, now)).toBe("Mar 15, 2024");
  });
});

describe("formatDaySeparator", () => {
  it("returns Today for same local day", () => {
    expect(formatDaySeparator(mkLocal(2026, 4, 17, 0, 1), now)).toBe("Today");
  });
  it("returns Yesterday for one local day prior", () => {
    expect(formatDaySeparator(mkLocal(2026, 4, 16, 23, 59), now)).toBe("Yesterday");
  });
  it("returns weekday + full month + day for older same year", () => {
    expect(formatDaySeparator(mkLocal(2026, 2, 15, 9, 0), now)).toBe("Sunday, March 15");
  });
  it("appends year when not the current local year", () => {
    expect(formatDaySeparator(mkLocal(2024, 2, 15, 9, 0), now)).toBe("Friday, March 15, 2024");
  });
});

describe("formatAbsoluteTooltip", () => {
  it("renders weekday, month name, day, year, and clock time", () => {
    const ts = mkLocal(2026, 4, 17, 14, 14);
    expect(formatAbsoluteTooltip(ts)).toBe("Sunday, May 17, 2026 at 2:14 PM");
  });
});

describe("localDayKey", () => {
  it("returns zero-padded YYYY-MM-DD in local time", () => {
    expect(localDayKey(mkLocal(2026, 0, 3, 4, 5))).toBe("2026-01-03");
  });
  it("differs across local midnight", () => {
    const a = mkLocal(2026, 4, 17, 23, 59);
    const b = mkLocal(2026, 4, 18, 0, 1);
    expect(localDayKey(a)).not.toBe(localDayKey(b));
  });
});
