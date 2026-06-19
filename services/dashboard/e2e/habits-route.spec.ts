/**
 * FRI-169 AC16 — the /habits management route (render + detail calendar).
 *
 * Covers the user-visible /habits surface added in FRI-169:
 *   1. an active habit renders a summary ROW carrying the numeric streak
 *      headline as exact text (here "3 month streak") and a square strip
 *      (>= 1 `.habit-square` Slot square);
 *   2. expanding that habit's detail renders a full Sun→Sat calendar grid
 *      built on the reusable HeatmapCalendar (>= 1 `.hm-cell` node) with
 *      month labels above the columns (>= 1 `.hm-month` node).
 *
 * Seeds one active MONTH-Period, target=1 habit plus four Check-ins — one in
 * each of the three prior calendar months and one in the current month — so
 * the streak engine derives `active_satisfied, count: 3` (two prior satisfied
 * months + the current satisfied month ticks it to 3) and the headline reads
 * exactly "3 month streak". The Check-in timestamps are computed relative to
 * the test's `now`, so the assertion is date-stable rather than pinned to a
 * fixed calendar date.
 *
 * Validated by CI's playwright job (the harness boots daemon + dashboard +
 * zero-cache + scratch PG); it is NOT run locally against the prod stack.
 *
 * Conventions mirror habits-today.spec.ts / schedules-reminders.spec.ts:
 * cookie injection via parseCookiesForPlaywright, direct pg seeding (here INTO
 * habits + habit_checkins), generous web-first timeouts to absorb Zero
 * replication, and a console-error guard.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { envPath } from "./global-setup";

interface EnvSnapshot {
  dashboardURL: string;
  databaseUrl: string;
  cookie: string;
  userId: string;
  deviceId: string;
}

function loadEnv(): EnvSnapshot {
  return JSON.parse(readFileSync(envPath(), "utf8")) as EnvSnapshot;
}

function parseCookiesForPlaywright(
  cookieHeader: string,
  url: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}> {
  const u = new URL(url);
  return cookieHeader.split("; ").map((pair) => {
    const eq = pair.indexOf("=");
    return {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      domain: u.hostname,
      path: "/",
      httpOnly: false,
      // adapter-node binds HTTP locally; secure:false is required for
      // Playwright to accept the cookie on a http:// origin.
      secure: false,
      sameSite: "Lax" as const,
    };
  });
}

/**
 * Seed an active MONTH-Period, target=1 habit. period='month', no weekday
 * mask, status='active'. Inserts every NOT-NULL column and leaves nullable
 * ones explicit for clarity.
 */
async function seedMonthHabit(
  databaseUrl: string,
  row: { id: string; name: string; colorIndex: number },
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO habits
         (id, name, description, mode, target, period, days_of_week,
          bucket, color_index, window_start, window_end, status,
          created_at, updated_at)
       VALUES
         ($1, $2, NULL, 'ongoing', 1, 'month', NULL,
          NULL, $3, NULL, NULL, 'active',
          now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.name, row.colorIndex],
    );
  } finally {
    await c.end();
  }
}

/** Append-only INSERT of one Check-in at an explicit timestamp. */
async function seedCheckin(
  databaseUrl: string,
  row: { id: string; habitId: string; ts: Date },
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO habit_checkins (id, habit_id, ts, note, created_at)
       VALUES ($1, $2, $3, NULL, now())
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.habitId, row.ts],
    );
  } finally {
    await c.end();
  }
}

/**
 * The 15th (mid-month, so DST / month-length never shifts it across a
 * boundary) of the month `monthsBack` before `now`.
 */
function midMonth(now: Date, monthsBack: number): Date {
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 15, 12, 0, 0);
}

test.describe("FRI-169 AC16: /habits route", () => {
  test("summary row shows the numeric streak + square strip, detail shows a Sun-Sat hm-cell grid + month labels", async ({
    browser,
  }) => {
    const env = loadEnv();

    const now = new Date();
    const stamp = Date.now();
    const habitId = randomUUID();
    const habitName = `Pay rent ${stamp}`;

    await seedMonthHabit(env.databaseUrl, {
      id: habitId,
      name: habitName,
      colorIndex: 5,
    });

    // Check-ins in the current month + the two prior months → two prior
    // Satisfied months (the run) and a satisfied current month (ticks to N+1)
    // = count 3. A third prior month keeps the prior run unbroken so the
    // current-month tick lands exactly at 3 (2 prior + this month), reading
    // "3 month streak".
    for (const monthsBack of [0, 1, 2]) {
      await seedCheckin(env.databaseUrl, {
        id: randomUUID(),
        habitId,
        ts: midMonth(now, monthsBack),
      });
    }

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${env.dashboardURL}/habits`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    // The seeded habit's summary row is present (scoped to the list item that
    // carries its name).
    const habitItem = page.locator("li.habit-item").filter({ hasText: habitName });
    await expect(habitItem).toBeVisible({ timeout: 15_000 });

    // 1a. The numeric streak headline reads exactly "3 month streak". The
    //     summary row renders the number and unit as adjacent spans, so the
    //     row's normalized text contains the joined phrase.
    await expect(habitItem.locator(".streak-num")).toHaveText("3", { timeout: 15_000 });
    await expect(habitItem.locator(".streak-unit")).toHaveText("month streak");

    // 1b. The square strip renders at least one Slot square (the current
    //     Period's filled quota square).
    await expect(habitItem.locator(".habit-square").first()).toBeVisible();

    // 2. Expanding the detail renders the Sun→Sat calendar built on the
    //    reusable HeatmapCalendar (`.hm-cell` square language).
    await habitItem.getByRole("button", { name: `Expand ${habitName}` }).click();
    await expect(habitItem.locator(".hm-cell").first()).toBeVisible({ timeout: 15_000 });
    // The detail grid is a substantial calendar, not a stray single cell.
    expect(await habitItem.locator(".hm-cell").count()).toBeGreaterThan(7);
    // The month labels above the columns are the requested follow-up feature.
    expect(await habitItem.locator(".hm-month").count()).toBeGreaterThan(0);

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
