/**
 * FRI-169 AC15 — the /dashboard habits "Today" card (render + DOM order).
 *
 * Covers the user-visible Today-card surface added in FRI-169:
 *   1. the Today card's DOM node PRECEDES the .activity-card node in document
 *      order (AC15 — `expect(todayIndex).toBeLessThan(activityIndex)`);
 *   2. an active, expected-today habit renders a tap-to-check-off control in
 *      the card, grouped under its Time-of-day bucket;
 *   3. checking it off flips the control's aria-pressed to "true" (the Zero
 *      mutator INSERT replicates back through the live binding).
 *
 * Seeds one active day-Period habit directly into the scratch DB (expected
 * every day, so it always lands in the card) and drives the real dashboard.
 * Validated by CI's playwright job (the harness boots daemon + dashboard +
 * zero-cache + scratch PG); it is NOT run locally against the prod stack.
 *
 * Conventions mirror schedules-reminders.spec.ts: cookie injection via
 * parseCookiesForPlaywright, direct pg seeding (here INTO habits), generous
 * web-first timeouts to absorb Zero replication, and a console-error guard.
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
 * Seed an active day-Period habit. period='day', target=1, no weekday mask,
 * status='active' — so the adapter's isExpectedToday() returns true every
 * day and the habit always appears in the Today card. Inserts every NOT-NULL
 * column and leaves nullable ones explicit for clarity.
 */
async function seedHabit(
  databaseUrl: string,
  row: { id: string; name: string; bucket: string | null; colorIndex: number },
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
         ($1, $2, NULL, 'ongoing', 1, 'day', NULL,
          $3, $4, NULL, NULL, 'active',
          now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.name, row.bucket, row.colorIndex],
    );
  } finally {
    await c.end();
  }
}

test.describe("FRI-169 AC15: /dashboard habits Today card", () => {
  test("Today card precedes the Activity card and renders an expected habit", async ({
    browser,
  }) => {
    const env = loadEnv();

    const stamp = Date.now();
    const habitId = randomUUID();
    const habitName = `Drink water ${stamp}`;

    await seedHabit(env.databaseUrl, {
      id: habitId,
      name: habitName,
      bucket: "morning",
      colorIndex: 3,
    });

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${env.dashboardURL}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).not.toHaveURL(/\/login/);

    // The Today card and the Activity card are both present.
    const todayCard = page.locator('[data-testid="today-card"]');
    const activityCard = page.locator(".activity-card");
    await expect(todayCard).toBeVisible({ timeout: 15_000 });
    await expect(activityCard).toBeVisible();

    // AC15: the Today card's DOM node precedes the .activity-card node in
    // document order. evaluateHandle is brittle for ordering; compare the
    // two boxes by reading their position in the shared parent's children.
    const todayBeforeActivity = await page.evaluate(() => {
      const today = document.querySelector('[data-testid="today-card"]');
      const activity = document.querySelector(".activity-card");
      if (!today || !activity) return false;
      // Node.DOCUMENT_POSITION_FOLLOWING (4) means `activity` follows `today`.
      return Boolean(today.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(todayBeforeActivity, "Today card must precede .activity-card in DOM order (AC15)").toBe(
      true,
    );

    // The seeded habit renders as a check-off control grouped under Morning.
    const checkBtn = page.getByRole("button", { name: `Check off ${habitName}` });
    await expect(checkBtn).toBeVisible({ timeout: 15_000 });
    await expect(checkBtn).toHaveAttribute("aria-pressed", "false");

    // Checking it off flips aria-pressed to true once the INSERT replicates
    // back through the Zero live binding.
    await checkBtn.click();
    const undoBtn = page.getByRole("button", {
      name: `Undo check-off for ${habitName}`,
    });
    await expect(undoBtn).toBeVisible({ timeout: 15_000 });
    await expect(undoBtn).toHaveAttribute("aria-pressed", "true");

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
