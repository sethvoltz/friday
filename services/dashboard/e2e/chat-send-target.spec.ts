/**
 * FRI-72 — the URL route is the AUTHORITATIVE chat send target.
 *
 * Confirmed root cause of a SEV-0 silent message loss: a user composing
 * at `/sessions/<A>` had their message stamped with a DIFFERENT agent's
 * name and silently misrouted. The send derived `agent_name` from the
 * `chat.focusedAgent` signal, which is synced from the route by a
 * post-navigation `$effect` in ChatShell.svelte and therefore LAGS the
 * URL during/right-after a navigation. A send issued in that window read
 * the previously-viewed agent.
 *
 * The fix (ChatInput.svelte submit): resolve the send target from
 * `$page.url.pathname` via `resolveSendTargetAgent()` and let the URL win,
 * regardless of what `focusedAgent` currently holds.
 *
 * This spec reproduces the race deterministically: it forces
 * `chat.focusedAgent` to the PREVIOUS agent (`agent-b`) while the browser
 * URL is `/sessions/agent-a`, then sends. It MUST fail on `main` (the
 * canonical `blocks.agent_name` lands as `agent-b`) and pass after the fix
 * (`agent-a`). Follows live-typing.spec.ts's cookie-injection + PG-poll
 * pattern and zero-permissions.spec.ts's agent-seeding + `window` probe.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { newTestClient } from "@friday/shared/test/sync-harness";
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

async function seedAgent(databaseUrl: string, name: string): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO agents (name, type, status, session_count, created_at, updated_at)
         VALUES ($1, 'bare', 'idle', 0, now(), now())
       ON CONFLICT (name) DO NOTHING`,
      [name],
    );
  } finally {
    await c.end();
  }
}

async function readUserBlock(
  databaseUrl: string,
  textFilter: string,
): Promise<Array<{ block_id: string; agent_name: string }>> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    const r = await c.query<{ block_id: string; agent_name: string }>(
      `SELECT block_id, agent_name
         FROM blocks
         WHERE role = 'user'
           AND source = 'user_chat'
           AND content_json::text LIKE $1`,
      [`%${textFilter}%`],
    );
    return r.rows.map((row) => ({ block_id: row.block_id, agent_name: row.agent_name }));
  } finally {
    await c.end();
  }
}

test.describe("FRI-72: URL route is the authoritative chat send target", () => {
  test("send from /sessions/agent-a stamps agent-a even when focusedAgent lags at agent-b", async ({
    browser,
  }) => {
    const env = loadEnv();

    // Two distinct agents — the "previously viewed" B and the current A.
    await seedAgent(env.databaseUrl, "agent-b");
    await seedAgent(env.databaseUrl, "agent-a");

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // Land on agent-a's live chat. (Going there directly is enough — we
    // force the lag below rather than relying on flaky effect timing.)
    await page.goto(`${env.dashboardURL}/sessions/agent-a`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);

    const input = page.getByPlaceholder(/Message/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(input).toBeEnabled();

    // Force the exact race: while the URL is /sessions/agent-a, drive the
    // `focusedAgent` signal to the *previous* agent B — simulating the
    // post-navigation `$effect` not yet having caught up. A send now must
    // still be stamped to the URL agent (A), not the lagging signal (B).
    await page.waitForFunction(() => {
      const c = (globalThis as unknown as { __fridayChat?: { focusedAgent: string } }).__fridayChat;
      return !!c;
    });
    await page.evaluate(() => {
      const c = (globalThis as unknown as { __fridayChat?: { focusedAgent: string } })
        .__fridayChat!;
      c.focusedAgent = "agent-b";
    });
    // Sanity: the signal is now B while the URL is still A.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __fridayChat?: { focusedAgent: string } }).__fridayChat!
              .focusedAgent,
        ),
      )
      .toBe("agent-b");
    await expect(page).toHaveURL(/\/sessions\/agent-a$/);

    const marker = `e2e-fri72-${Date.now()}`;
    const messageText = `route-authoritative send ${marker}`;
    await input.fill(messageText);
    await page.getByRole("button", { name: "Send" }).click();

    // Canonical-write check: the row must be stamped with the URL agent.
    let rows: Awaited<ReturnType<typeof readUserBlock>> = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      rows = await readUserBlock(env.databaseUrl, marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(rows.length).toBe(1);
    // THE INVARIANT: viewing /sessions/agent-a → stamped agent-a, full stop.
    expect(rows[0]!.agent_name).toBe("agent-a");

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });

  test("real navigation race: goto(B) then goto(A) then immediate send stamps agent-a", async ({
    browser,
  }) => {
    // Unlike the first test (which force-sets `focusedAgent` via the
    // `__fridayChat` probe), this drives the ACTUAL navigation timing: we
    // navigate to B, then to A, then send immediately — without settling —
    // so `focusedAgent`'s post-navigation `$effect` may still be lagging at
    // B when the send fires. The canonical write must still land on A.
    const env = loadEnv();

    await seedAgent(env.databaseUrl, "agent-b");
    await seedAgent(env.databaseUrl, "agent-a");

    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // 1. Land on agent-b and let it settle so focusedAgent === "agent-b".
    await page.goto(`${env.dashboardURL}/sessions/agent-b`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForFunction(() => {
      const c = (globalThis as unknown as { __fridayChat?: { focusedAgent: string } }).__fridayChat;
      return !!c && c.focusedAgent === "agent-b";
    });

    // 2. Client-side navigate to agent-a and IMMEDIATELY send, without
    //    waiting for the focus `$effect` to catch up. We don't await any
    //    settle between the route change and the send — that's the race.
    await page.goto(`${env.dashboardURL}/sessions/agent-a`, { waitUntil: "commit" });

    const input = page.getByPlaceholder(/Message/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(input).toBeEnabled();
    await expect(page).toHaveURL(/\/sessions\/agent-a$/);

    const marker = `e2e-fri72-realrace-${Date.now()}`;
    const messageText = `real navigation race send ${marker}`;
    await input.fill(messageText);
    await page.getByRole("button", { name: "Send" }).click();

    // Canonical-write check: the row must be stamped with the URL agent (A),
    // regardless of whether focusedAgent had caught up at send time.
    let rows: Awaited<ReturnType<typeof readUserBlock>> = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      rows = await readUserBlock(env.databaseUrl, marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_name).toBe("agent-a");

    // The optimistic bubble must render on the agent-a surface (overlay
    // keyed by the authoritative send agent, not the lagging focusedAgent).
    await expect(page.getByText(messageText)).toBeVisible({ timeout: 10_000 });

    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
