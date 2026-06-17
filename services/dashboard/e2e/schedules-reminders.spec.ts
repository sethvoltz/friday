/**
 * FRI-168 AC11 — the /schedules reminder surface (render half).
 *
 * Covers the three user-visible reminder affordances added in FRI-168:
 *   1. the Kind column renders a 'reminder' badge for kind='reminder' rows
 *      and an 'agent-run' badge for kind='agent-run' rows;
 *   2. the All/Reminders view toggle filters the table down to reminders
 *      (the agent-run row disappears, the reminder stays);
 *   3. the "Upcoming reminders" agenda panel lists a reminder firing within
 *      the next 7 days.
 *
 * Seeds two schedules directly into the scratch DB (a reminder due in ~1h and
 * a recurring agent-run) and drives the real dashboard. This is validated by
 * CI's playwright job (the harness boots daemon + dashboard + zero-cache +
 * scratch PG); it is NOT run locally against the prod stack.
 *
 * Conventions mirror chat-send-target.spec.ts: cookie injection via
 * parseCookiesForPlaywright, direct pg seeding (here INTO schedules), generous
 * web-first timeouts to absorb Zero replication, and a console-error guard.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
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
 * Seed a schedule row. `nextRunAt` is a JS Date (pg serializes it to the
 * timestamptz column); `cron`/`runAt` are nullable text. Inserts every
 * NOT-NULL column (name, task_prompt, paused, kind, status, created_at,
 * updated_at) and leaves the nullable ones explicit for clarity.
 */
async function seedSchedule(
  databaseUrl: string,
  row: {
    name: string;
    taskPrompt: string;
    kind: "reminder" | "agent-run";
    cron: string | null;
    runAt: string | null;
    nextRunAt: Date | null;
  },
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO schedules
         (name, cron, run_at, task_prompt, paused, kind, status,
          next_run_at, last_run_at, last_run_id, meta_json, app_id, delivery_json,
          created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, false, $5, 'active',
          $6, NULL, NULL, NULL, NULL, NULL,
          now(), now())
       ON CONFLICT (name) DO NOTHING`,
      [row.name, row.cron, row.runAt, row.taskPrompt, row.kind, row.nextRunAt],
    );
  } finally {
    await c.end();
  }
}

test.describe("FRI-168 AC11: /schedules reminder surface", () => {
  test("kind badge, Reminders filter, and Upcoming reminders panel", async ({ browser }) => {
    const env = loadEnv();

    const stamp = Date.now();
    const reminderName = `e2e-reminder-${stamp}`;
    const reminderTitle = `Thaw the cod ${stamp}`;
    const agentRunName = `e2e-agentrun-${stamp}`;

    // (a) a one-shot reminder firing in ~1h — lands in the next-7-days panel.
    const nextRunAt = new Date(stamp + 60 * 60 * 1000);
    await seedSchedule(env.databaseUrl, {
      name: reminderName,
      taskPrompt: reminderTitle,
      kind: "reminder",
      cron: null,
      runAt: nextRunAt.toISOString(),
      nextRunAt,
    });
    // (b) a recurring agent-run — should NOT appear in the Reminders view or
    // the Upcoming panel.
    await seedSchedule(env.databaseUrl, {
      name: agentRunName,
      taskPrompt: `nightly job ${stamp}`,
      kind: "agent-run",
      cron: "0 4 * * *",
      runAt: null,
      nextRunAt: null,
    });

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${env.dashboardURL}/schedules`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    // Scope to the "All schedules" table so the assertions key on table rows,
    // not the agenda panel (which also shows the reminder).
    const reminderRow = page.getByRole("row").filter({ hasText: reminderName });
    const agentRunRow = page.getByRole("row").filter({ hasText: agentRunName });

    // 1. Kind badges: both rows are visible, the reminder shows the
    //    'reminder' badge and the agent-run shows the 'agent-run' badge.
    await expect(reminderRow).toBeVisible({ timeout: 15_000 });
    await expect(agentRunRow).toBeVisible({ timeout: 15_000 });
    await expect(reminderRow.getByText("reminder", { exact: true })).toBeVisible();
    await expect(agentRunRow.getByText("agent-run", { exact: true })).toBeVisible();

    // 2. Reminders filter: clicking the "Reminders" toggle drops the
    //    agent-run row while the reminder remains.
    await page.getByRole("button", { name: "Reminders" }).click();
    await expect(agentRunRow).toBeHidden({ timeout: 15_000 });
    await expect(reminderRow).toBeVisible();

    // 3. Upcoming reminders panel: the reminder is listed by its title.
    const upcomingHeading = page.getByRole("heading", { name: "Upcoming reminders" });
    await expect(upcomingHeading).toBeVisible();
    const upcomingPanel = page.locator(".card").filter({ has: upcomingHeading });
    await expect(upcomingPanel.getByText(reminderTitle)).toBeVisible({ timeout: 15_000 });

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
